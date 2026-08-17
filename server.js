require('dotenv').config();

const path = require('path');
const express = require('express');
const session = require('express-session');
const { createClient, login, getDevices } = require('./src/dmsClient');

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.DMS_BASE_URL || 'http://13.52.48.194';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dms-device-viewer-dev-secret';
// DMS_EMAIL / DMS_PASS 是「選填的預設值」：如果 .env 有設定，登入頁會提供一個
// 「使用預設帳號登入」按鈕，不用每次手動打字；QA 團隊成員仍然可以在登入表單
// 輸入自己的帳密，不受環境變數限制。
const DEFAULT_EMAIL = process.env.DMS_EMAIL || '';
const DEFAULT_PASS = process.env.DMS_PASS || '';

const app = express();
app.use(express.json());
app.use(
  session({
    name: 'dms_viewer_sid',
    secret: SESSION_SECRET,
    resave: false,
    // 必須是 true：我們不會往 req.session 寫入任何欄位（DMS 的登入狀態存在
    // 記憶體裡的 dmsSessions Map，用 session id 當 key），如果 saveUninitialized
    // 是 false，express-session 在「session 內容沒被修改」時就不會發 Set-Cookie，
    // 導致每個請求都拿到不同的 session id、永遠對不上 dmsSessions。
    saveUninitialized: true,
    cookie: { httpOnly: true, maxAge: 1000 * 60 * 60 * 8 }, // 8 小時
  })
);
app.use(express.static(path.join(__dirname, 'public')));

// 每個瀏覽器 session（express-session）對應一組 DMS 的 cookie jar + 快取的
// Inertia version。存在記憶體裡就好——這是給內部 QA 團隊用的小工具，
// 不需要資料庫，重啟服務會需要重新登入一次，這是預期行為。
const dmsSessions = new Map();

function getDmsSession(req) {
  return dmsSessions.get(req.session.id);
}

function maskEmail(email) {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const visible = user.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(user.length - 2, 1))}@${domain}`;
}

function requireLogin(req, res, next) {
  const s = getDmsSession(req);
  if (!s) {
    return res.status(401).json({ ok: false, message: '尚未登入或登入已逾時，請重新登入。' });
  }
  req.dmsSession = s;
  next();
}

app.get('/api/status', (req, res) => {
  const s = getDmsSession(req);
  res.json({
    ok: true,
    loggedIn: !!s,
    baseUrl: BASE_URL,
    hasDefaultCredentials: !!(DEFAULT_EMAIL && DEFAULT_PASS),
    defaultEmailMasked: DEFAULT_EMAIL ? maskEmail(DEFAULT_EMAIL) : null,
    inertiaVersion: s ? s.version : null,
  });
});

app.post('/api/login', async (req, res) => {
  let { email, password, remember } = req.body || {};

  // 表單留空的話，退回使用伺服器端設定的預設帳密（如果有的話）
  if (!email || !password) {
    if (DEFAULT_EMAIL && DEFAULT_PASS) {
      email = DEFAULT_EMAIL;
      password = DEFAULT_PASS;
    } else {
      return res.status(400).json({ ok: false, message: '請輸入 email 與密碼。' });
    }
  }

  try {
    const dmsSession = createClient(BASE_URL);
    const result = await login(dmsSession, email, password, remember);

    if (!result.success) {
      return res.status(401).json({ ok: false, message: result.message });
    }

    // 登入成功後重新產生 express-session id（防 session fixation），
    // 確定新 id 才把 DMS session 存進 Map。
    req.session.regenerate((err) => {
      if (err) {
        console.error('[login] session regenerate error:', err.message);
        return res.status(500).json({ ok: false, message: '內部錯誤，請重試。' });
      }
      req.session.authenticated = true; // 確保 session 內容非空，會被存下並發 cookie
      dmsSessions.set(req.session.id, dmsSession);
      req.session.save((saveErr) => {
        if (saveErr) {
          console.error('[login] session save error:', saveErr.message);
          return res.status(500).json({ ok: false, message: '內部錯誤，請重試。' });
        }
        res.json({ ok: true });
      });
    });
  } catch (err) {
    console.error('[login] error:', err.message);
    res.status(502).json({
      ok: false,
      message: `連線到 DMS 站台失敗：${err.message}（請確認這台機器能連到 ${BASE_URL}）`,
    });
  }
});

app.post('/api/logout', (req, res) => {
  dmsSessions.delete(req.session.id);
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

app.get('/api/devices', requireLogin, async (req, res) => {
  const {
    device_kind = 'eld',
    serial_number = '',
    page = '1',
    per_page = '20',
    sort_by = 'serial_number',
    sort_order = 'asc',
  } = req.query;

  const qs = new URLSearchParams({
    device_kind,
    page,
    per_page,
    sort_by,
    sort_order,
  });
  if (serial_number) qs.set('serial_number', serial_number);

  const pathWithQuery = `/device?${qs.toString()}`;

  try {
    const result = await getDevices(req.dmsSession, pathWithQuery);
    if (result.needLogin) {
      dmsSessions.delete(req.session.id);
      return res.status(401).json({ ok: false, message: '登入已逾時，請重新登入。' });
    }
    res.json({
      ok: true,
      devices: result.devices,
      debug: { ...result.debug, baseUrl: BASE_URL, fetchedAt: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[devices] error:', err.message);
    res.status(502).json({ ok: false, message: `查詢裝置失敗：${err.message}` });
  }
});

app.listen(PORT, () => {
  console.log(`DMS Device Viewer 已啟動：http://localhost:${PORT}`);
  console.log(`目標 DMS 站台：${BASE_URL}`);
  if (DEFAULT_EMAIL && DEFAULT_PASS) {
    console.log('已偵測到 .env 的預設帳密，登入頁會提供快速登入按鈕。');
  }
});
