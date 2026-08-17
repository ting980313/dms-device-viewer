/**
 * mock-server.js
 *
 * 這不是要交付給 QA 團隊的東西，純粹是拿來在沒有真正 DMS 站台可連的環境下，
 * 驗證 src/dmsClient.js 的四步流程（登入 / CSRF / Inertia version / 409 重試 /
 * session 過期偵測）邏輯是否正確。行為刻意模擬文件裡描述的 Laravel + Inertia
 * 特性：dms_qa_session + XSRF-TOKEN cookie、data-page 屬性、
 * X-Inertia-Version 不符時回 409 + X-Inertia-Location。
 *
 * 用法：node mock/mock-server.js  (預設監聽 4000)
 * 測試帳號：mock@example.com / password123
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.MOCK_PORT || 4000;
const VALID_EMAIL = 'mock@example.com';
const VALID_PASSWORD = 'password123';

let CURRENT_VERSION = crypto.randomBytes(16).toString('hex');
let VERSION_BUMPED_ONCE = false;

const DEVICES = Array.from({ length: 3 }).map((_, i) => ({
  id: 130 + i,
  imei: `123421421420${5 + i}`,
  serial_number: `12345${5 + i}`,
  eld_id: `RTHA5${5 + i}`,
  model_code: 'EHA554UA',
  org_id: 2,
  iccid: `33333${7 + i}`,
  is_active: i % 2 === 0,
}));

const sessions = new Map(); // sid -> { loggedIn }
const xsrfBySid = new Map(); // sid -> xsrf plaintext

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function ensureSession(req, res) {
  const cookies = parseCookies(req);
  let sid = cookies['dms_qa_session'];
  let xsrfPlain = cookies['__xsrf_plain']; // 內部用，方便 mock 比對，不代表真站台行為

  const setCookies = [];
  if (!sid || !sessions.has(sid)) {
    sid = crypto.randomBytes(12).toString('hex');
    sessions.set(sid, { loggedIn: false });
    setCookies.push(`dms_qa_session=${sid}; Path=/; HttpOnly`);
  }
  if (!xsrfPlain) {
    // 模擬真站台：cookie 是 URL-encoded（故意帶 "==" 進去驗證 decode 邏輯有作用）
    const fullPlain = crypto.randomBytes(16).toString('hex') + '==';
    xsrfPlain = fullPlain;
    xsrfBySid.set(sid, xsrfPlain);
    setCookies.push(`XSRF-TOKEN=${encodeURIComponent(fullPlain)}; Path=/`);
    setCookies.push(`__xsrf_plain=${encodeURIComponent(fullPlain)}; Path=/; HttpOnly`);
  } else {
    xsrfBySid.set(sid, xsrfPlain);
  }

  if (setCookies.length) {
    res.setHeader('Set-Cookie', setCookies);
  }

  return { sid, session: sessions.get(sid), xsrfPlain: xsrfBySid.get(sid) };
}

function renderPage(component, props, url) {
  const pageObj = { component, props, url, version: CURRENT_VERSION };
  const json = JSON.stringify(pageObj).replace(/"/g, '&quot;');
  return `<!DOCTYPE html><html><head><title>Mock DMS</title></head>` +
    `<body><div id="app" data-page="${json}"></div></body></html>`;
}

function readBody(req) {
  return new Promise((resolve) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(chunks || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function paginate(items, page, perPage, serialFilter, sortBy, sortOrder) {
  let filtered = items;
  if (serialFilter) {
    filtered = filtered.filter((d) => d.serial_number.includes(serialFilter));
  }
  filtered = [...filtered].sort((a, b) => {
    const av = a[sortBy], bv = b[sortBy];
    if (av < bv) return sortOrder === 'desc' ? 1 : -1;
    if (av > bv) return sortOrder === 'desc' ? -1 : 1;
    return 0;
  });
  const total = filtered.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const data = filtered.slice(start, start + perPage);
  return {
    current_page: page,
    data,
    per_page: perPage,
    total,
    last_page: lastPage,
    first_page_url: null,
    next_page_url: page < lastPage ? `?page=${page + 1}` : null,
    prev_page_url: page > 1 ? `?page=${page - 1}` : null,
    links: [],
  };
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const { sid, session, xsrfPlain } = ensureSession(req, res);

  // 刻意支援：在測試中呼叫 /__bump_version 模擬前端重新部署
  if (parsed.pathname === '/__bump_version') {
    CURRENT_VERSION = crypto.randomBytes(16).toString('hex');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('bumped');
  }

  if (parsed.pathname === '/login' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPage('auth/login', {}, '/login'));
  }

  if (parsed.pathname === '/login' && req.method === 'POST') {
    const headerXsrf = req.headers['x-xsrf-token'];
    const body = await readBody(req);

    if (!headerXsrf || headerXsrf !== xsrfPlain) {
      res.writeHead(419, { 'Content-Type': 'text/plain' });
      return res.end('CSRF token mismatch');
    }

    if (body.email === VALID_EMAIL && body.password === VALID_PASSWORD) {
      session.loggedIn = true;
      res.writeHead(302, { Location: '/dashboard' });
      return res.end();
    }

    res.writeHead(302, { Location: '/login' });
    return res.end();
  }

  if (parsed.pathname === '/device') {
    const wantsInertia = req.headers['x-inertia'] === 'true';

    if (!session.loggedIn) {
      if (wantsInertia) {
        res.writeHead(409, { 'X-Inertia-Location': '/login' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(renderPage('auth/login', {}, '/login'));
    }

    const page = parseInt(parsed.searchParams.get('page') || '1', 10);
    const perPage = parseInt(parsed.searchParams.get('per_page') || '20', 10);
    const serial = parsed.searchParams.get('serial_number') || '';
    const sortBy = parsed.searchParams.get('sort_by') || 'serial_number';
    const sortOrder = parsed.searchParams.get('sort_order') || 'asc';
    const devices = paginate(DEVICES, page, perPage, serial, sortBy, sortOrder);

    if (wantsInertia) {
      const clientVersion = req.headers['x-inertia-version'];
      if (clientVersion !== CURRENT_VERSION) {
        res.writeHead(409, { 'X-Inertia-Location': parsed.pathname + parsed.search });
        return res.end();
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'X-Inertia': 'true',
      });
      return res.end(
        JSON.stringify({
          component: 'device/index',
          props: { devices },
          url: parsed.pathname + parsed.search,
          version: CURRENT_VERSION,
        })
      );
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(renderPage('device/index', { devices }, parsed.pathname + parsed.search));
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`Mock DMS server listening on http://localhost:${PORT}`);
  console.log(`測試帳號：${VALID_EMAIL} / ${VALID_PASSWORD}`);
});
