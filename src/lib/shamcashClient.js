/**
 * ShamCash HTTP client — mimics the MOBILE app (Flutter/Dart, libapp.so).
 *
 * Mobile vs web differences:
 *   Base URL  : api.shamcash.sy  (not api.shamcash.com)
 *   Auth      : Authorization: Bearer <JWT>  (no cookies)
 *   Body enc  : FIXED AES-128-GCM key (base64-decoded from aes_key.pem)
 *   Failover  : api-02.shamcash.sy → api-03.shamcash.sy (FailoverInterceptor)
 *   Login     : POST Authentication/signin (email + password + deviceToken + lang)
 *   Sessions  : Long-lived JWT tokens stored in our DB
 *
 * JWT TOKEN TYPES:
 *   QR login  → returns "session" role JWT — NOT valid for account/transaction endpoints
 *   Email/pwd → returns "bearer" role JWT — valid for ALL endpoints  ← USE THIS
 */

const crypto = require('./crypto');
const { fetch: undiciFetch, ProxyAgent } = require('undici');
const { getProxyOnly } = require('./proxyConfig');

/**
 * Encode userinfo (user:password) in proxy URL so special chars (e.g. ;) work.
 * Format: http://user:pass@host:port → http://encode(user):encode(pass)@host:port
 */
function encodeProxyUrl(proxy) {
  const match = proxy.match(/^(https?:\/\/)([^@\/]+)@(.+)$/);
  if (!match) return proxy;
  const [, scheme, userinfo, hostPart] = match;
  const parts = userinfo.split(':');
  if (parts.length < 2) return proxy;
  const password = parts.pop();
  const username = parts.join(':');
  const encoded = scheme + encodeURIComponent(username) + ':' + encodeURIComponent(password) + '@' + hostPart;
  return encoded;
}

// ── Proxies (comma-separated in SHAMCASH_PROXY; tried after direct fails) ────
// Hardcoded fallback: env parsing drops everything after ';' — build URL from parts
const PROXY_FALLBACK = 'http://'
  + encodeURIComponent('857c74bda452878e07ca__cr.sy;asn.48065')
  + ':' + encodeURIComponent('d3fdfa1ce91cea85')
  + '@gw.dataimpulse.com:823';

const PROXIES_RAW = (process.env.SHAMCASH_PROXY || '')
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);

// Use env proxies if they look valid (contain @host), otherwise use hardcoded fallback
const ENV_PROXIES = PROXIES_RAW.filter((p) => p.includes('@'));
const PROXIES = ENV_PROXIES.length > 0
  ? ENV_PROXIES.map((p) => encodeProxyUrl(p))
  : [PROXY_FALLBACK];

if (PROXIES.length > 0) {
  PROXIES.forEach((p, i) => {
    const masked = p.replace(/:[^:@]+@/, ':****@');
    console.log(`[proxy] #${i} url=${masked}`);
  });
  console.log(`[proxy] ${PROXIES.length} proxy(ies) configured (src=${ENV_PROXIES.length > 0 ? 'env' : 'hardcoded'})`);
  if (getProxyOnly()) console.log('[proxy] Proxy-only mode: skipping direct connection');
}

// ── Base URLs (app has three: primary + two failovers + bank + payment) ──────
const BASES = {
  primary:   process.env.SHAMCASH_API_BASE         || 'https://api.shamcash.sy/v4/api',
  failover2: process.env.SHAMCASH_API_BASE_02      || 'https://api-02.shamcash.sy/v4/api',
  failover3: process.env.SHAMCASH_API_BASE_03      || 'https://api-03.shamcash.sy/v4/api',
  bank:      process.env.SHAMCASH_BANK_API_BASE    || 'https://bank.shamcash.sy/v4/api',
  payment:   process.env.SHAMCASH_PAYMENT_API_BASE || 'https://payment.shamcash.sy/v4/api',
};

const RSA_PUB_KEY = process.env.SHAMCASH_SERVER_PUBLIC_KEY; // for Session/create yv()
const LOCALE      = (process.env.SHAMCASH_LOCALE || 'en').trim();

// aes_key.pem contains a base64-encoded AES-128 key (16 bytes).
// The Dart app calls Key.fromBase64() → 16 raw bytes → AES-128-GCM.
// We must base64-decode before passing to node-forge (which needs a binary string).
const AES_KEY_RAW = process.env.SHAMCASH_AES_KEY;
// const AES_KEY     = AES_KEY_RAW ? Buffer.from(AES_KEY_RAW, 'base64').toString('binary') : null;
const AES_KEY     = AES_KEY_RAW || null;

// SHAMCASH_PLAIN_BODY=true → skip AES body encryption (useful for debugging 401s).
// If plain body works but encrypted doesn't → AES key is still wrong.
const PLAIN_BODY  = process.env.SHAMCASH_PLAIN_BODY === 'true';
// SHAMCASH_DEBUG_LOG_BODY=true → log plaintext payload before encryption (for Transaction debugging).
const DEBUG_LOG_BODY = process.env.SHAMCASH_DEBUG_LOG_BODY === 'true';

if (AES_KEY) {
  console.log(`[crypto] AES key: ${AES_KEY.length} bytes (AES-${AES_KEY.length * 8}-GCM)${PLAIN_BODY ? ' [PLAIN_BODY mode — encryption skipped]' : ''}`);
}

// ── Mobile HTTP headers (Dio defaults from dio_factory.dart) ─────────────────
// Mobile sends: Content-Type, Accept, lang, Authorization (with token).
// No Origin, Referer, or browser Sec-* headers.
const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Accept':       'application/json',
  'lang':         LOCALE,
};

// Fake Android device info — InfoDeviceModel fields: deviceName, osName, brand, model
const DEVICE_INFO = {
  deviceName: process.env.DEVICE_NAME  || 'Pixel 7',
  osName:     process.env.DEVICE_OS    || 'Android 14',
  brand:      process.env.DEVICE_BRAND || 'Google',
  model:      process.env.DEVICE_MODEL || 'Pixel 7',
};

// Fake FCM device token (LoginRequestModel.deviceToken)
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || 'fakeDeviceToken_' + Math.random().toString(36).slice(2, 18);

// ── Core HTTP ─────────────────────────────────────────────────────────────────

function isNetworkError(e) {
  if (!e) return false;
  const msg = (e.message || '').toLowerCase();
  if (msg.includes('fetch failed') || msg.includes('econnrefused') || msg.includes('econnreset') ||
      msg.includes('etimedout') || msg.includes('enotfound') || msg.includes('network') ||
      msg.includes('invalid url')) return true;
  if (e.cause && isNetworkError(e.cause)) return true;
  return false;
}

/**
 * rawPost(url, body, extraHeaders, proxyUrl?) — one POST attempt.
 * proxyUrl: optional proxy (e.g. http://user:pass@host:port). Uses undici ProxyAgent when set.
 * Returns { ok, status, data }.
 */
async function rawPost(url, body, extraHeaders = {}, proxyUrl = null) {
  const headers = { ...BASE_HEADERS, ...extraHeaders };
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const opts = {
    method: 'POST',
    headers,
    body: bodyStr,
  };
  if (proxyUrl) {
    opts.dispatcher = new ProxyAgent(proxyUrl);
  }
  const res = await undiciFetch(url, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { _raw: text }; }
  return { ok: res.ok, status: res.status, data };
}

/**
 * rawPostWithRetry(url, body, extraHeaders) — tries direct first (unless proxy-only), then each proxy on network error.
 */
async function rawPostWithRetry(url, body, extraHeaders = {}) {
  const proxyOnly = getProxyOnly();

  // 1. Try direct (skip if proxy-only mode and we have proxies)
  if (!proxyOnly || PROXIES.length === 0) {
    try {
      return await rawPost(url, body, extraHeaders, null);
    } catch (e) {
      if (!isNetworkError(e) || PROXIES.length === 0) throw e;
      console.warn(`[direct] ${url} network error: ${e.message}`);
    }
  } else {
    console.log(`[proxy] Proxy-only mode: skipping direct for ${url}`);
  }

  // 2. Try each proxy
  let lastErr;
  for (const proxy of PROXIES) {
    try {
      const proxyMask = proxy.replace(/:[^:@]+@/, ':****@');
      console.log(`[proxy] Trying ${proxyMask}`);
      return await rawPost(url, body, extraHeaders, proxy);
    } catch (e) {
      lastErr = e;
      console.warn(`[proxy] ${proxy.replace(/:[^:@]+@/, ':****@')} failed: ${e.message}`);
    }
  }
  throw lastErr || new Error('Proxy-only mode but no proxies configured');
}

/**
 * post(path, body, extraHeaders, base?) — POST with automatic failover.
 * Mimics app's FailoverInterceptor: tries primary → api-02 → api-03.
 * Throws on definitive failure (4xx from server, or all hosts fail).
 */
async function post(path, body = {}, extraHeaders = {}, base = BASES.primary) {
  const isMainBase = (base === BASES.primary);
  const urls = isMainBase
    ? [BASES.primary, BASES.failover2, BASES.failover3].map(b => `${b}/${path}`)
    : [`${base}/${path}`];

  let lastErr;
  for (const url of urls) {
    try {
      const isEncrypted = body && typeof body.encData === 'string';
      console.log(`[POST] ${url} | body=${isEncrypted ? 'encrypted' : 'plain'} | auth=${extraHeaders.Authorization ? extraHeaders.Authorization.substring(0, 25) + '…' : 'none'}`);
      const { ok, status, data } = await rawPostWithRetry(url, body, extraHeaders);
      if (ok) return data;
      // Log full details on 4xx for debugging
      if (status >= 400 && status < 500) {
        console.error(`[${status}] ${url}`);
        console.error(`  → body: ${JSON.stringify(data)}`);
        if (extraHeaders.Authorization) {
          console.error(`  → Bearer: ${extraHeaders.Authorization.substring(0, 60)}…`);
        }
        const err = new Error(data?.message || data?.error || `HTTP ${status}`);
        err.status = status; err.data = data; throw err;
      }
      // 5xx → try next host
      lastErr = new Error(data?.message || `HTTP ${status}`);
      lastErr.status = status; lastErr.data = data;
      console.warn(`[failover] ${url} → ${status}, trying next…`);
    } catch (e) {
      if (e.status && e.status < 500) throw e;
      lastErr = e;
      if (!e.status) console.warn(`[failover] ${url} network error: ${e.message}`);
    }
  }
  throw lastErr;
}

/**
 * bankPost — POST to bank.shamcash.sy (no failover defined for bank).
 */
async function bankPost(path, body = {}, extraHeaders = {}) {
  const url = `${BASES.bank}/${path}`;
  const isEncrypted = body && typeof body.encData === 'string';
  console.log(`[POST bank] ${url} | body=${isEncrypted ? 'encrypted' : 'plain'}`);
  const { ok, status, data } = await rawPostWithRetry(url, body, extraHeaders);
  if (!ok) {
    console.error(`[${status}] ${url} → ${JSON.stringify(data)}`);
    const e = new Error(data?.message || `HTTP ${status}`); e.status = status; e.data = data; throw e;
  }
  return data;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

function bearerHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

// ── Body encryption ───────────────────────────────────────────────────────────

/**
 * buildBody(payload, bearerToken, extra, accessToken, forge) — BZ function (authenticated calls).
 * bearerToken = JWT sent in Authorization header.
 * accessToken = short-lived hex token embedded in body (defaults to bearerToken if not provided).
 * forge = encrypted forge cookie (from QR login). When present, body is encrypted with keyFromForge
 *   (decrypted forge), not the fixed key. Matches web/history-logs behavior.
 * Set SHAMCASH_PLAIN_BODY=true to send plain JSON — useful if 401 persists with encryption.
 */
function buildBody(payload, bearerToken, extra = {}, accessToken = null, forge = null) {
  const bodyAccessToken = accessToken || bearerToken || '';
  const full = { accessToken: bodyAccessToken, ...payload, ...extra };
  if (DEBUG_LOG_BODY) console.log('[buildBody] plaintext:', JSON.stringify(full));
  if (PLAIN_BODY) return full;
  if (!forge && !AES_KEY) return full;
  const plain = JSON.stringify(full);
  if (forge && AES_KEY) {
    const keyFromForge = crypto.decryptForgeCookie(forge, AES_KEY);
    if (keyFromForge) {
      const encrypted = crypto.encryptWithForgeKey(plain, keyFromForge);
      if (encrypted) return encrypted;
    }
  }
  const encrypted = crypto.encryptBody(plain, AES_KEY);
  return encrypted || full;
}

/**
 * decryptIfEncrypted(response, forge) — SL function.
 * If response.data.encData exists, decrypt with keyFromForge (when forge present) or FIXED AES key.
 */
function decryptIfEncrypted(response, forge = null) {
  if (!response?.data || typeof response.data.encData !== 'string') return response;
  if (forge && AES_KEY) {
    const keyFromForge = crypto.decryptForgeCookie(forge, AES_KEY);
    if (keyFromForge) {
      const decrypted = crypto.decryptWithForgeKey(response.data.encData, keyFromForge);
      if (decrypted != null) { response.data = decrypted; return response; }
    }
  }
  if (!AES_KEY) return response;
  const decrypted = crypto.decryptResponse(response.data.encData, AES_KEY);
  if (decrypted != null) response.data = decrypted;
  return response;
}

// ── Login flow ────────────────────────────────────────────────────────────────

/**
 * login(email, password, deviceToken?) — Authentication/signin.
 * LoginRequestModel fields: email, password, deviceToken, lang, infoDevice
 * Sent as PLAIN JSON (pre-auth, no token yet).
 * Returns decrypted response containing token/authToken/accessToken.
 */
async function login(email, password, deviceToken) {
  const body = {
    email,
    password,
    deviceToken: deviceToken || DEVICE_TOKEN,
    lang: LOCALE,
    infoDevice: DEVICE_INFO,
  };
  console.log('[Login] email:', email);
  // First try plain JSON (most likely for pre-auth endpoint)
  let response;
  try {
    response = await post('Authentication/signin', body);
  } catch (e) {
    // Server might require encrypted body — retry with encryption
    if (e.status === 400) {
      console.log('[Login] Plain rejected (400), retrying with encrypted body…');
      const encBody = buildBody(body, '');
      response = await post('Authentication/signin', encBody);
    } else {
      throw e;
    }
  }
  return decryptIfEncrypted(response);
}

/**
 * verifyOtp(email, otpCode) — Authentication/verify (after login when OTP required).
 */
async function verifyOtp(email, otpCode) {
  const response = await post('Authentication/verify', { email, otpCode, lang: LOCALE });
  return decryptIfEncrypted(response);
}

/**
 * check2fa(email, code) — Authentication/check2fa.
 */
async function check2fa(email, code) {
  const response = await post('Authentication/check2fa', { email, code, lang: LOCALE });
  return decryptIfEncrypted(response);
}

/**
 * logout(token) — Authentication/logout/new.
 */
async function logout(token) {
  try {
    return await post('Authentication/logout/new', buildBody({}, token), bearerHeaders(token));
  } catch (e) {
    console.warn('[logout] Server logout failed:', e.message);
    return null;
  }
}

// ── QR Session (device-to-device login, mimics Profile → Sessions → Scan QR) ─

/**
 * sessionCreate(infoDevice?) — POST Session/create.
 * Mobile generates a QR, this creates the session record on the server.
 * Returns { sessionId, publicKey } from server, or null if endpoint not found.
 */
async function sessionCreate(infoDevice = DEVICE_INFO) {
  try {
    const data = await post('Session/create', { infoDevice });
    const sid = data?.data?.sessionId || data?.sessionId;
    const pk  = data?.data?.publicKey  || data?.publicKey;
    if (sid) return { sessionId: sid, publicKey: pk, raw: data };
    return null;
  } catch (e) {
    if (e.status === 404 || e.status === 405) return null;
    throw e;
  }
}

/**
 * sessionCheck(encData, aesKey) — POST Session/check.
 * yv()-encrypted body { encData, aesKey } — polls until QR is scanned.
 */
async function sessionCheck(encData, aesKey) {
  return post('Session/check', { encData, aesKey });
}

/**
 * sessionGetAll(token) — Session/getAllSessions (authenticated, returns active sessions).
 */
async function sessionGetAll(token) {
  const response = await post('Session/getAllSessions', buildBody({}, token), bearerHeaders(token));
  return decryptIfEncrypted(response);
}

/**
 * sessionDelete(token, sessionId) — Session/delete/:id.
 */
async function sessionDelete(token, sessionId) {
  const response = await post(`Session/delete/${sessionId}`, buildBody({ sessionId }, token), bearerHeaders(token));
  return decryptIfEncrypted(response);
}

// ── Account endpoints (all authenticated via Bearer token) ───────────────────

/**
 * acct(path, creds, extra, bank)
 * creds can be:
 *   - a string (legacy): used as both Bearer JWT and body accessToken
 *   - { token, accessToken, forge }: token = JWT for Bearer header, accessToken = hex for body,
 *     forge = encrypted forge cookie (QR login) — body encrypted with keyFromForge when present
 */
function acct(path, creds, extra = {}, bank = false) {
  const token       = typeof creds === 'string' ? creds : creds?.token;
  const accessToken = typeof creds === 'string' ? creds : (creds?.accessToken || creds?.token);
  const forge       = typeof creds === 'string' ? null : creds?.forge;
  const body    = buildBody({}, token, extra, accessToken, forge);
  const headers = bearerHeaders(token);
  const fn      = bank ? bankPost : post;
  return fn(path, body, headers).then(r => decryptIfEncrypted(r, forge));
}

const accountMyProfile    = (c)         => acct('Account/myProfile',          c);
const accountBalances     = (c)         => acct('Account/balances',            c);
const accountSettings     = (c)         => acct('Account/settings',            c);
const personalAccountGet  = (c)         => acct('PersonalAccount/get',         c);
const accountFavorites    = (c)         => acct('AccountFavorites/all',        c);
const accountGetByAddress = (c, addr)   => acct('Account/getAccountByAddress', c, { address: addr });
const exchangeGetServices = (c)         => acct('Exchange/getServices',        c, {}, true);
const serviceCheck        = (c)         => acct('Service/checkService',        c);
const mtnWalletAll        = (c)         => acct('MtnWallet/all',               c);
const syriatelWalletAll   = (c)         => acct('SyriatelWallet/all',          c);

/**
 * Build payload for Transaction/history-logs.
 * Mobile API returns data with minimal payload { accessToken } only.
 * Pagination params (limit, pageSize, next, page) cause empty results — omit them.
 * Only pass filters: fromDate, toDate, currencyId, type.
 */
function buildHistoryLogsParams(params = {}) {
  const { fromDate, toDate, currencyId, type } = params;
  const hasFilters = fromDate || toDate || currencyId != null || type != null;
  if (!hasFilters) return {};
  return {
    ...(fromDate && { fromDate }),
    ...(toDate && { toDate }),
    ...(currencyId != null && { currencyId }),
    ...(type != null && { type }),
  };
}

/**
 * Transaction/logs — use minimal payload. Debug showed Transaction/logs returns
 * empty for all formats; history-logs with minimal works.
 */
function buildTransactionLogsParams(params = {}) {
  return buildHistoryLogsParams(params);
}

/**
 * Build transaction payload by format (for debugging which format the mobile API expects).
 * format: 'minimal' | 'web' | 'no-next' | 'page' | 'default'
 */
function buildTransactionPayloadByFormat(format, accessToken, extra = {}) {
  const base = { accessToken: accessToken || '' };
  switch (format) {
    case 'minimal':
      return { ...base, ...extra };
    case 'web':
      return { ...base, limit: 7, pageSize: 1, next: { tags: ['last-transactions'] }, ...extra };
    case 'no-next':
      return { ...base, limit: 20, pageSize: 20, ...extra };
    case 'page':
      return { ...base, page: 1, pageSize: 20, ...extra };
    default:
      return { ...base, limit: 20, pageSize: 20, next: { tags: ['last-transactions'] }, ...extra };
  }
}

function transactionHistoryLogs(creds, params = {}) {
  const body = buildHistoryLogsParams(params);
  return acct('Transaction/history-logs', creds, body);
}
function transactionLogs(creds, params = {}) {
  const body = buildTransactionLogsParams(params);
  return acct('Transaction/logs', creds, body);
}

/**
 * Call transaction endpoint with a specific payload format (for debugging).
 * format: 'minimal' | 'web' | 'no-next' | 'page' | 'default'
 * endpoint: 'history-logs' | 'logs'
 */
function transactionWithFormat(creds, format, endpoint = 'history-logs') {
  const path = endpoint === 'logs' ? 'Transaction/logs' : 'Transaction/history-logs';
  const accessToken = typeof creds === 'string' ? creds : (creds?.accessToken || creds?.token);
  const body = buildTransactionPayloadByFormat(format, accessToken);
  return acct(path, creds, body);
}
/**
 * Transaction by ID — Transaction/detail returns 404 on mobile API.
 * Use history-logs (minimal payload) and filter by tranId.
 */
async function transactionById(creds, id) {
  const idNum = Number(id) || id;
  const idStr = String(id).trim();
  const logs = await transactionHistoryLogs(creds, {});
  const log = Array.isArray(logs?.data) ? logs.data : logs?.data?.log;
  if (Array.isArray(log)) {
    const match = log.find(
      (t) =>
        t?.tranId === idNum ||
        t?.tranId === idStr ||
        String(t?.tranId) === idStr ||
        t?.id === idNum ||
        t?.id === idStr
    );
    if (match) return { succeeded: true, data: match };
  }
  const err = new Error('Transaction not found');
  err.status = 404;
  err.data = null;
  throw err;
}

module.exports = {
  post, bankPost, rawPost,
  login, verifyOtp, check2fa, logout,
  sessionCreate, sessionCheck, sessionGetAll, sessionDelete,
  accountMyProfile, accountBalances, accountSettings,
  personalAccountGet, accountFavorites, accountGetByAddress,
  exchangeGetServices, serviceCheck, mtnWalletAll, syriatelWalletAll,
  transactionHistoryLogs, transactionLogs, transactionById,
  transactionWithFormat, buildTransactionPayloadByFormat,
  buildBody, bearerHeaders, decryptIfEncrypted,
  BASES, DEVICE_INFO, DEVICE_TOKEN,
};
