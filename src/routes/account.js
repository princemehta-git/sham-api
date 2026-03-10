/**
 * Account routes — all use X-API-Key → Bearer JWT token (mobile pattern).
 * No cookies, no forge key. Token stored after /login or /session/createNew.
 */

const store  = require('../lib/store');
const client = require('../lib/shamcashClient');
const QRCode = require('qrcode');

// ── Token resolution ──────────────────────────────────────────────────────────

/**
 * Resolve stored credentials from the API key.
 * Returns { token, accessToken } where:
 *   token       = JWT Bearer token (Authorization: Bearer <token>)
 *   accessToken = short-lived hex token embedded in the encrypted request body
 * Prefers JWT-looking tokens (eyJ...) for Bearer to avoid sending hex as Bearer.
 */
async function getCredentials(req) {
  const apiKey = req.get('x-api-key')
    || req.get('authorization')?.replace(/^Bearer\s+/i, '')
    || req.query.apiKey;
  if (!apiKey) return null;
  const creds = await store.getApiKeyCredentials(apiKey);
  if (!creds) return null;

  const candidates = [creds.token, creds.authToken, creds.accessToken].filter(Boolean);
  // Prefer a JWT (mobile Bearer token) over a hex access token
  const token = candidates.find(t => t.startsWith('eyJ')) || candidates[0] || null;
  // The short-lived hex accessToken goes inside the encrypted body
  const accessToken = creds.accessToken || creds.token || token;
  // Forge cookie (from QR login) — body must be encrypted with keyFromForge, not fixed key
  const forge = creds.forge || (Array.isArray(creds.cookies) && creds.cookies.find(c => c?.name === 'forge'))?.value;
  if (!token) return null;
  console.log(`[token] ${token.startsWith('eyJ') ? 'JWT' : 'non-JWT'} len=${token.length} accessToken len=${accessToken?.length} forge=${forge ? 'yes' : 'no'}`);
  return { token, accessToken, forge };
}

// Keep getToken for backward compat (returns just the Bearer token string)
async function getToken(req) {
  const c = await getCredentials(req);
  return c?.token || null;
}

async function requireToken(req, res) {
  const creds = await getCredentials(req);
  if (!creds) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Provide X-API-Key header. Get one via POST /login or POST /session/createNew.',
    });
    return null;
  }
  return creds;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function balance(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.accountBalances(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Balance failed', detail: e.message, data: e.data }); }
}

async function profile(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.accountMyProfile(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Profile failed', detail: e.message, data: e.data }); }
}

async function personal(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.personalAccountGet(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'PersonalAccount failed', detail: e.message, data: e.data }); }
}

async function settings(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.accountSettings(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Settings failed', detail: e.message, data: e.data }); }
}

async function favorites(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.accountFavorites(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Favorites failed', detail: e.message, data: e.data }); }
}

async function exchange(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.exchangeGetServices(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Exchange failed', detail: e.message, data: e.data }); }
}

async function mtnWallets(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.mtnWalletAll(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'MTN wallets failed', detail: e.message, data: e.data }); }
}

async function syriatelWallets(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try { res.json({ success: true, data: await client.syriatelWalletAll(c) }); }
  catch (e) { res.status(e.status || 502).json({ error: 'Syriatel wallets failed', detail: e.message, data: e.data }); }
}

/**
 * Extract receive address (hex code like 2d2b49e3bc2b576e34907d3c52ec7ed4).
 * NOT accountNumber — that is a different identifier. Only hex addresses for Receive QR.
 */
function extractReceiveCode(d) {
  if (!d) return null;
  const candidates = [
    d?.user?.address,
    d?.address,
    d?.data?.user?.address,
    d?.data?.address,
    d?.data?.data?.user?.address,
    d?.data?.data?.address,
    Array.isArray(d?.data) ? d.data[0]?.address : null,
    Array.isArray(d?.data?.data) ? d.data.data[0]?.address : null,
    Array.isArray(d) ? d[0]?.address : null,
  ];
  const v = candidates.find((x) => x && typeof x === 'string' && x.trim());
  if (!v) return null;
  const s = v.trim();
  // Hex address: 32 hex chars. Reject accountNumber (digits only).
  if (/^[a-fA-F0-9]{32}$/.test(s)) return s;
  return null;
}

/**
 * GET /account/qr — user's Receive QR code (hex address for Receive money).
 * Web app uses Account/settings for user.address (not myProfile). Try settings first, then myProfile, then PersonalAccount.
 */
async function receiveQr(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try {
    let address = null;
    try {
      const r = await client.accountSettings(c);
      address = extractReceiveCode(r?.data ?? r);
    } catch (_) {}
    if (!address) {
      try {
        const r = await client.accountMyProfile(c);
        address = extractReceiveCode(r?.data ?? r);
      } catch (_) {}
    }
    if (!address) {
      try {
        const r = await client.personalAccountGet(c);
        address = extractReceiveCode(r?.data ?? r);
      } catch (_) {}
    }
    if (!address) {
      return res.status(404).json({ error: 'Receive address not found. Account may not be verified yet.' });
    }
    const qrImage = await QRCode.toDataURL(address, { type: 'image/png', margin: 2, width: 300 });
    res.json({ success: true, address, qrImage });
  } catch (e) {
    res.status(e.status || 502).json({ error: 'Receive QR failed', detail: e.message, data: e.data });
  }
}

/**
 * GET /account/address/:code — resolve receive code → account info.
 */
async function addressLookup(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  const address = req.params.code || req.query.address || req.query.code;
  if (!address) return res.status(400).json({ error: 'address or code is required' });
  try {
    const data = await client.accountGetByAddress(c, address);
    res.json({ success: true, address, data });
  } catch (e) {
    res.status(e.status || 502).json({ error: 'Address lookup failed', detail: e.message, data: e.data });
  }
}

/**
 * GET /account/transactions — Transaction/history-logs (full paginated history).
 * Query params: page, pageSize, fromDate, toDate, currencyId, type, etc.
 */
async function transactions(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try {
    const params = { page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20, ...req.query };
    delete params.apiKey;
    res.json({ success: true, data: await client.transactionHistoryLogs(c, params) });
  } catch (e) {
    res.status(e.status || 502).json({ error: 'Transactions failed', detail: e.message, data: e.data });
  }
}

/**
 * GET /account/transaction-logs — Transaction/logs (simpler, faster).
 */
async function transactionLogs(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  try {
    const params = { page: Number(req.query.page) || 1, pageSize: Number(req.query.pageSize) || 20, ...req.query };
    delete params.apiKey;
    res.json({ success: true, data: await client.transactionLogs(c, params) });
  } catch (e) {
    res.status(e.status || 502).json({ error: 'Transaction logs failed', detail: e.message, data: e.data });
  }
}

/**
 * GET /account/transactions-debug — try different payload formats to find which works.
 * Query: format=minimal|web|no-next|page|default, endpoint=history-logs|logs
 * Tries single format, or all formats if format=all.
 */
async function transactionsDebug(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  const format = (req.query.format || 'all').toLowerCase();
  const endpoint = (req.query.endpoint || 'history-logs').toLowerCase();
  const validEndpoint = endpoint === 'logs' ? 'logs' : 'history-logs';

  const formats = format === 'all'
    ? ['minimal', 'web', 'no-next', 'page', 'default']
    : [format];

  if (format !== 'all' && !['minimal', 'web', 'no-next', 'page', 'default'].includes(format)) {
    return res.status(400).json({
      error: 'Invalid format',
      message: 'Use format=minimal|web|no-next|page|default|all',
    });
  }

  const results = {};
  for (const f of formats) {
    try {
      const data = await client.transactionWithFormat(c, f, validEndpoint);
      const logCount = Array.isArray(data?.data) ? data.data.length : (data?.data?.log?.length ?? 0);
      results[f] = {
        succeeded: data?.succeeded ?? false,
        result: data?.result,
        logCount,
        hasData: logCount > 0,
        sample: logCount > 0 ? (data?.data?.log?.[0] ?? data?.data?.[0]) : null,
      };
    } catch (e) {
      results[f] = { error: e.message, status: e.status };
    }
  }

  res.json({
    success: true,
    endpoint: validEndpoint,
    formats: results,
    hint: 'If any format has hasData:true, use that format in the main implementation.',
  });
}

/**
 * GET /account/transactions/:id — single transaction detail.
 */
async function transactionById(req, res) {
  const c = await requireToken(req, res); if (!c) return;
  const id = req.params.id;
  if (!id) return res.status(400).json({ error: 'Transaction ID required' });
  try {
    res.json({ success: true, data: await client.transactionById(c, id) });
  } catch (e) {
    res.status(e.status || 502).json({ error: 'Transaction fetch failed', detail: e.message, data: e.data });
  }
}

module.exports = {
  balance, profile, personal, settings, favorites,
  exchange, mtnWallets, syriatelWallets,
  receiveQr, addressLookup,
  transactions, transactionLogs, transactionsDebug, transactionById,
  getToken,
};
