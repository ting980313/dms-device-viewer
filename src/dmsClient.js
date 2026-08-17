/**
 * dmsClient.js
 *
 * 把逆向工程筆記裡的四步 curl 流程,轉成可重複呼叫的 Node.js client：
 *   1) GET  /login              -> 拿 session cookie + XSRF-TOKEN
 *   2) POST /login              -> 帶 X-XSRF-TOKEN 送出帳密,換成「已登入」session
 *   3) GET  <目標頁面>(整頁)     -> 從 HTML 的 data-page 屬性挖出目前的 X-Inertia-Version
 *   4) GET  <目標頁面>(+Inertia) -> 帶 X-Inertia / X-Inertia-Version,拿到 JSON
 *
 * 每個「後端 session」（對應瀏覽器一次登入）都有自己獨立的 cookie jar 與
 * 快取的 Inertia version，彼此不共用，也不會寫死帳密。
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cheerio = require('cheerio');

/**
 * 建立一個獨立的 HTTP client + cookie jar，代表一個使用者的登入狀態。
 */
function createClient(baseUrl) {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      baseURL: baseUrl,
      jar,
      withCredentials: true,
      timeout: 15000,
      // 由呼叫端自行決定要不要跟隨轉址、要接受哪些狀態碼，
      // 這樣才能正確判斷「登入成功的 302」「session 過期被導回 /login」等情況。
      validateStatus: () => true,
      headers: {
        'User-Agent': 'dms-device-viewer/1.0 (+internal QA tool)',
      },
    })
  );
  return { client, jar, baseUrl, version: null };
}

async function getXsrfToken(jar, baseUrl) {
  const cookies = await jar.getCookies(baseUrl);
  const xsrfCookie = cookies.find((c) => c.key === 'XSRF-TOKEN');
  if (!xsrfCookie) return null;
  // cookie 內容是 URL-encoded，要先 decode 再放進 X-XSRF-TOKEN 標頭
  return decodeURIComponent(xsrfCookie.value);
}

/**
 * 從 Inertia 頁面的 HTML 中取出 <div id="app" data-page="..."> 這包 JSON。
 * cheerio 讀屬性時會自動把 HTML entity（&quot; 等）解碼，
 * 所以這裡拿到的就是可以直接 JSON.parse 的字串。
 */
function extractInertiaPage(html) {
  if (typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  const raw = $('#app').attr('data-page');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Step 1 + 2：headless 登入。
 * 回傳 { success: true } 或 { success: false, message }
 */
async function login(session, email, password, remember = false) {
  const { client, jar, baseUrl } = session;

  // Step 1：開 session，拿 XSRF-TOKEN
  await client.get('/login');
  const xsrf = await getXsrfToken(jar, baseUrl);
  if (!xsrf) {
    return {
      success: false,
      message: '無法從站台取得 XSRF-TOKEN，請確認網址與站台狀態是否正常。',
    };
  }

  // Step 2：重放登入 POST，CSRF token 放在標頭
  const res = await client.post(
    '/login',
    { email, password, remember: !!remember },
    {
      maxRedirects: 0,
      headers: {
        'X-XSRF-TOKEN': xsrf,
        'X-Inertia': 'true',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/plain, */*',
      },
    }
  );

  const location = res.headers.location || res.headers['x-inertia-location'] || '';

  if (res.status === 302 && location && !location.includes('/login')) {
    session.version = null; // 登入後版本可能不同，交給下次抓取時重新拿
    return { success: true };
  }

  // 帳密錯誤時，Laravel/Inertia 常見會是 302 導回 /login（帶 flash 錯誤）、
  // 或直接回 401/422。統一視為登入失敗，並盡量帶出可讀訊息。
  let message = `登入失敗（HTTP ${res.status}）`;
  const page = extractInertiaPage(res.data);
  if (page && page.props && page.props.errors) {
    const errs = Object.values(page.props.errors).flat();
    if (errs.length) message = errs.join('；');
  } else if (res.status === 302) {
    message = '帳號或密碼錯誤，請確認 DMS_EMAIL / DMS_PASS 是否正確。';
  }

  return { success: false, message };
}

/**
 * Step 3：用「整頁 GET」取得目前的 X-Inertia-Version。
 * 如果頁面其實是登入頁（component === 'auth/login'），代表 session 已失效。
 */
async function fetchVersion(session, path) {
  const res = await session.client.get(path);
  const page = extractInertiaPage(res.data);

  if (!page) {
    throw new Error('無法解析頁面內容（找不到 data-page），可能站台已改版或回應異常。');
  }
  if (page.component === 'auth/login') {
    return { expired: true };
  }
  return { expired: false, version: page.version, page };
}

/**
 * Step 4：帶著 X-Inertia + X-Inertia-Version 拿 JSON。
 * 若遇到 409（version 不符，或伺服器要求整頁導轉），
 * 依 X-Inertia-Location 判斷是「需要重新登入」還是「版本變了，重抓一次」。
 */
async function fetchInertiaJson(session, path) {
  if (!session.version) {
    const v = await fetchVersion(session, path);
    if (v.expired) return { expired: true };
    session.version = v.version;
  }

  let res = await session.client.get(path, {
    headers: {
      'X-Inertia': 'true',
      'X-Inertia-Version': session.version,
      Accept: 'text/html, application/xhtml+xml',
    },
  });

  let versionRetried = false;

  if (res.status === 409) {
    const loc = res.headers['x-inertia-location'] || '';
    if (loc.includes('/login')) {
      return { expired: true };
    }
    // 版本過期：重新抓一次目前版本，再重試一次
    const v = await fetchVersion(session, path);
    if (v.expired) return { expired: true };
    session.version = v.version;
    versionRetried = true;

    res = await session.client.get(path, {
      headers: {
        'X-Inertia': 'true',
        'X-Inertia-Version': session.version,
        Accept: 'text/html, application/xhtml+xml',
      },
    });
  }

  if (res.status !== 200) {
    throw new Error(`取得資料失敗（HTTP ${res.status}）`);
  }

  const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  return { expired: false, data, status: res.status, versionRetried };
}

/**
 * 對外主要入口：查詢裝置清單。
 * queryParams 會被組成跟文件裡一樣的 querystring（device_kind / serial_number / ...）。
 * 回傳的 debug 欄位是給網頁上的「除錯資訊」面板用的，方便追查 409 / 版本問題。
 */
async function getDevices(session, path) {
  const result = await fetchInertiaJson(session, path);
  if (result.expired) {
    return { needLogin: true };
  }
  const props = result.data && result.data.props;
  if (!props || !props.devices) {
    throw new Error('回應中找不到 props.devices，可能後端資料結構已變更。');
  }
  return {
    needLogin: false,
    devices: props.devices,
    debug: {
      inertiaVersion: session.version,
      httpStatus: result.status,
      versionRetried: !!result.versionRetried,
      path,
    },
  };
}

module.exports = {
  createClient,
  login,
  getDevices,
};
