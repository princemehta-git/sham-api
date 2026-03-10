/**
 * Admin routes — login, session management, account CRUD.
 * All routes except /admin/api/login require admin JWT.
 */

const { randomUUID } = require('crypto');
const QRCode = require('qrcode');
const crypto = require('../lib/crypto');
const device = require('../lib/device');
const store = require('../lib/store');
const { CURRENCY_ID_MAP } = require('../lib/currency');
const shamcashClient = require('../lib/shamcashClient');
const { generateToken, requireAdmin } = require('../middleware/adminAuth');

const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SERVER_PUBLIC_KEY = process.env.SHAMCASH_SERVER_PUBLIC_KEY;
const AES_KEY = process.env.SHAMCASH_AES_KEY;

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_TTL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;

const backgroundPollIntervals = new Map();
const completedSessions = new Map();   // sessionId -> { credentials, createdAt }
const consecutiveErrors = new Map();

function pruneCompletedSessions() {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const [id, v] of completedSessions.entries()) {
    if (v.createdAt < cutoff) completedSessions.delete(id);
  }
}

// ── Credential extraction helpers (from QR scan response) ────────────────────

function buildCredentialsCookies(responseCookies, publicKey) {
  const byName = new Map();
  if (publicKey) byName.set('forge', { name: 'forge', value: publicKey });
  byName.set('NEXT_LOCALE', { name: 'NEXT_LOCALE', value: 'en' });
  if (Array.isArray(responseCookies)) {
    for (const c of responseCookies) {
      if (c && c.name) byName.set(c.name, { name: c.name, value: String(c.value ?? '') });
    }
  }
  return Array.from(byName.values());
}

function getAuthTokenFromResponse(data) {
  if (data && data.authToken) return data.authToken;
  if (Array.isArray(data?.cookies)) {
    const c = data.cookies.find(x => x && x.name === 'authToken');
    if (c) return c.value;
  }
  return null;
}

function getAccessTokenFromResponse(data) {
  if (data && data.accessToken) return data.accessToken;
  if (Array.isArray(data?.cookies)) {
    const c = data.cookies.find(x => x && x.name === 'accessToken');
    if (c) return c.value;
  }
  return null;
}

// ── Receive address extraction ───────────────────────────────────────────────

function extractReceiveCode(d) {
  if (!d) return null;
  const candidates = [
    d?.user?.address, d?.address,
    d?.data?.user?.address, d?.data?.address,
    d?.data?.data?.user?.address, d?.data?.data?.address,
    Array.isArray(d?.data) ? d.data[0]?.address : null,
    Array.isArray(d?.data?.data) ? d.data.data[0]?.address : null,
    Array.isArray(d) ? d[0]?.address : null,
  ];
  const v = candidates.find(x => x && typeof x === 'string' && x.trim());
  if (!v) return null;
  const s = v.trim();
  if (/^[a-fA-F0-9]{32}$/.test(s)) return s;
  return null;
}

/**
 * Get credentials object suitable for shamcashClient calls.
 */
function buildCredsForClient(credentials) {
  const candidates = [credentials.token, credentials.authToken, credentials.accessToken].filter(Boolean);
  const token = candidates.find(t => t.startsWith('eyJ')) || candidates[0] || null;
  const accessToken = credentials.accessToken || credentials.token || token;
  const forge = credentials.forge || (Array.isArray(credentials.cookies) && credentials.cookies.find(c => c?.name === 'forge'))?.value;
  return { token, accessToken, forge };
}

/**
 * Fetch account_address for credentials by calling ShamCash API.
 */
async function fetchAccountAddress(credentials) {
  const creds = buildCredsForClient(credentials);
  let address = null;
  try {
    const r = await shamcashClient.accountSettings(creds);
    address = extractReceiveCode(r?.data ?? r);
  } catch (_) {}
  if (!address) {
    try {
      const r = await shamcashClient.accountMyProfile(creds);
      address = extractReceiveCode(r?.data ?? r);
    } catch (_) {}
  }
  if (!address) {
    try {
      const r = await shamcashClient.personalAccountGet(creds);
      address = extractReceiveCode(r?.data ?? r);
    } catch (_) {}
  }
  return address;
}

/**
 * Fetch account name from profile.
 */
async function fetchAccountName(credentials) {
  const creds = buildCredsForClient(credentials);
  try {
    const r = await shamcashClient.accountMyProfile(creds);
    const data = r?.data ?? r;
    return data?.user?.fullName || data?.user?.name || data?.fullName || data?.name || null;
  } catch {
    return null;
  }
}

// ── Background polling for QR session ────────────────────────────────────────

async function runBackgroundCheck(sessionId) {
  const session = await store.getPendingSession(sessionId);
  if (!session || completedSessions.has(sessionId)) {
    const tid = backgroundPollIntervals.get(sessionId);
    if (tid) { clearInterval(tid); backgroundPollIntervals.delete(sessionId); }
    return true;
  }
  if (session.createdAt && Date.now() - session.createdAt > POLL_TIMEOUT_MS) {
    clearInterval(backgroundPollIntervals.get(sessionId));
    backgroundPollIntervals.delete(sessionId);
    await store.deletePendingSession(sessionId);
    return true;
  }
  if (!session.encPayload || !session.aesKeyEnc) return false;

  const errCount = consecutiveErrors.get(sessionId) || 0;
  if (errCount >= MAX_CONSECUTIVE_ERRORS) {
    console.warn('[Session/check] Too many errors, stopping for', sessionId.substring(0, 30));
    clearInterval(backgroundPollIntervals.get(sessionId));
    backgroundPollIntervals.delete(sessionId);
    consecutiveErrors.delete(sessionId);
    await store.deletePendingSession(sessionId);
    return true;
  }

  try {
    const response = await shamcashClient.sessionCheck(session.encPayload, session.aesKeyEnc);
    consecutiveErrors.set(sessionId, 0);

    if (response.result === 1231) return false;

    const loggedIn = response && response.result === 2000 && response.succeeded === true && response.data?.encData;
    if (loggedIn) {
      console.log('[Session/check] Login detected! Decrypting...');
      const keyFromForge = crypto.decryptForgeCookie(session.publicKey, AES_KEY);
      const data = keyFromForge && crypto.decryptWithForgeKey(response.data.encData, keyFromForge);
      if (!data) { console.warn('[Session/check] Decrypt failed'); return false; }

      const allTokens = [data.token, data.authToken, data.accessToken].filter(Boolean);
      const jwtToken = allTokens.find(t => typeof t === 'string' && t.startsWith('eyJ'));
      const hexToken = allTokens.find(t => typeof t === 'string' && !t.startsWith('eyJ'));
      const cookies = buildCredentialsCookies(data.cookies, session.publicKey);
      const authToken = getAuthTokenFromResponse(data);
      const accessToken = getAccessTokenFromResponse(data);

      const credentials = {
        cookies,
        forge: session.publicKey,
        token: jwtToken || authToken || data.token || null,
        accessToken: hexToken || accessToken || null,
        authToken: authToken || undefined,
        userAgent: session.infoDevice?.userAgent,
        infoDevice: session.infoDevice,
      };

      completedSessions.set(sessionId, { credentials, createdAt: Date.now() });
      await store.deletePendingSession(sessionId);
      consecutiveErrors.delete(sessionId);
      const tid = backgroundPollIntervals.get(sessionId);
      if (tid) { clearInterval(tid); backgroundPollIntervals.delete(sessionId); }
      console.log('[Session/check] QR login complete.');
      return true;
    }
  } catch (e) {
    consecutiveErrors.set(sessionId, errCount + 1);
    if (!e.status && (errCount <= 3 || errCount % 10 === 0)) {
      console.warn(`[Session/check] Network error (${errCount + 1}):`, e.message);
    }
  }
  return false;
}

function startBackgroundPolling(sessionId) {
  if (backgroundPollIntervals.has(sessionId)) return;
  const tid = setInterval(() => { runBackgroundCheck(sessionId); }, POLL_INTERVAL_MS);
  backgroundPollIntervals.set(sessionId, tid);
  setImmediate(() => { runBackgroundCheck(sessionId).catch(() => {}); });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROUTE HANDLERS
// ══════════════════════════════════════════════════════════════════════════════

function setupRoutes(app) {
  // ── Admin Login ──────────────────────────────────────────────────────────
  app.post('/admin/api/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = generateToken(username);
    res.cookie('admin_token', token, {
      httpOnly: true,
      maxAge: 2 * 60 * 60 * 1000, // 2 hours
      sameSite: 'strict',
    });
    res.json({ success: true, token });
  });

  // ── Admin Logout ─────────────────────────────────────────────────────────
  app.post('/admin/api/logout', requireAdmin, (req, res) => {
    res.clearCookie('admin_token');
    res.json({ success: true });
  });

  // ── Check admin auth status ──────────────────────────────────────────────
  app.get('/admin/api/me', requireAdmin, (req, res) => {
    res.json({ success: true, username: req.admin.username });
  });

  // ── Create QR Session ────────────────────────────────────────────────────
  app.post('/admin/api/session/create', requireAdmin, async (req, res) => {
    try {
      if (!AES_KEY || !SERVER_PUBLIC_KEY) {
        return res.status(500).json({ error: 'Missing SHAMCASH_AES_KEY or SHAMCASH_SERVER_PUBLIC_KEY in .env' });
      }

      const deviceContext = device.generateDeviceContext();
      const infoDeviceForQr = {
        deviceName: 'Media-Man-Bot',
        os: deviceContext.os,
        browser: deviceContext.browser,
      };
      const infoDeviceStored = { ...infoDeviceForQr, userAgent: deviceContext.userAgent };

      const rawSessionId = randomUUID();
      const rawPublicKey = crypto.generatePublicKeyRaw();
      const encryptedSessionId = crypto.encryptForgeFormat(rawSessionId, AES_KEY);
      const encryptedPublicKey = crypto.encryptForgeFormat(rawPublicKey, AES_KEY);
      if (!encryptedSessionId || !encryptedPublicKey) {
        return res.status(500).json({ error: 'Encryption failed' });
      }

      const sessionIdInQr = encryptedSessionId + '#XXX';
      const qrPayload = { sessionId: sessionIdInQr, publicKey: encryptedPublicKey, infoDevice: infoDeviceForQr };
      const qrJson = JSON.stringify(qrPayload);
      const qrImage = await QRCode.toDataURL(qrJson, { type: 'image/png', margin: 2, width: 300 });

      const sessionCheckPlaintext = { accessToken: '', sessionId: rawSessionId };
      const encPayload = crypto.encryptSessionCheck(sessionCheckPlaintext, SERVER_PUBLIC_KEY);
      if (!encPayload) {
        return res.status(500).json({ error: 'Session/check encryption failed' });
      }

      await store.createPendingSession({
        sessionId: encryptedSessionId,
        rawSessionId,
        publicKey: encryptedPublicKey,
        infoDevice: infoDeviceStored,
        encPayload: encPayload.encData,
        aesKeyEnc: encPayload.aesKey,
      });

      startBackgroundPolling(encryptedSessionId);

      res.json({
        success: true,
        qrImage,
        sessionId: encryptedSessionId,
        message: 'Scan QR with ShamCash app.',
      });
    } catch (e) {
      console.error('[admin/session/create]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Check QR Session Status ──────────────────────────────────────────────
  app.get('/admin/api/session/:sessionId/check', requireAdmin, async (req, res) => {
    const sessionId = (req.params.sessionId || '').replace(/#XXX$/, '');
    pruneCompletedSessions();

    const completed = completedSessions.get(sessionId);
    if (completed) {
      // Session scanned — now fetch account_address and store the account
      try {
        const address = await fetchAccountAddress(completed.credentials);
        if (!address) {
          return res.status(500).json({ error: 'Could not fetch account address after login' });
        }

        const name = await fetchAccountName(completed.credentials);
        await store.createAccount(address, {
          credentials: completed.credentials,
          name,
          email: completed.credentials.email || null,
          sessionId,
          label: name || address,
        });

        completedSessions.delete(sessionId);
        return res.json({
          success: true,
          loggedIn: true,
          account_address: address,
          name,
          message: 'Account linked successfully.',
        });
      } catch (e) {
        console.error('[session/check] Error saving account:', e);
        return res.status(500).json({ error: 'Login succeeded but failed to save account: ' + e.message });
      }
    }

    const session = await store.getPendingSession(sessionId);
    if (!session) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }
    res.json({ success: true, loggedIn: false, message: 'Waiting for scan.' });
  });

  // ── List All Linked Accounts ─────────────────────────────────────────────
  app.get('/admin/api/accounts', requireAdmin, async (req, res) => {
    try {
      const accts = await store.listAccounts();
      res.json({
        success: true,
        count: accts.length,
        accounts: accts.map(a => ({
          account_address: a.account_address,
          name: a.name,
          email: a.email,
          label: a.label,
          created_at: a.created_at,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get Account QR / Address Code ────────────────────────────────────────
  app.get('/admin/api/accounts/:address/qr', requireAdmin, async (req, res) => {
    try {
      const creds = await store.getAccountCredentials(req.params.address);
      if (!creds) return res.status(404).json({ error: 'Account not found' });
      const qrImage = await QRCode.toDataURL(req.params.address, { type: 'image/png', margin: 2, width: 300 });
      res.json({ success: true, account_address: req.params.address, qrImage });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── Get Account Balance ──────────────────────────────────────────────────
  app.get('/admin/api/accounts/:address/balance', requireAdmin, async (req, res) => {
    try {
      const creds = await store.getAccountCredentials(req.params.address);
      if (!creds) return res.status(404).json({ error: 'Account not found' });
      const clientCreds = buildCredsForClient(creds);
      const data = await shamcashClient.accountBalances(clientCreds);
      // Populate currencyName from currencyId (1=EUR, 2=USD, 3=SYP) when empty
      const balances = data?.data?.balances || data?.balances || [];
      if (Array.isArray(balances)) {
        for (const b of balances) {
          if (!b.currencyName && b.currencyId != null && CURRENCY_ID_MAP[b.currencyId]) {
            b.currencyName = CURRENCY_ID_MAP[b.currencyId];
          }
        }
      }
      res.json({ success: true, data });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Get Account Transaction History ──────────────────────────────────────
  app.get('/admin/api/accounts/:address/transactions', requireAdmin, async (req, res) => {
    try {
      const creds = await store.getAccountCredentials(req.params.address);
      if (!creds) return res.status(404).json({ error: 'Account not found' });
      const clientCreds = buildCredsForClient(creds);
      const data = await shamcashClient.transactionHistoryLogs(clientCreds, req.query);
      res.json({ success: true, data });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message });
    }
  });

  // ── Find Transaction by ID ───────────────────────────────────────────────
  app.get('/admin/api/accounts/:address/find-tx', requireAdmin, async (req, res) => {
    try {
      const { tx } = req.query;
      if (!tx) return res.status(400).json({ success: false, error: 'tx parameter is required.' });
      const creds = await store.getAccountCredentials(req.params.address);
      if (!creds) return res.status(404).json({ success: false, error: 'Account not found' });
      const clientCreds = buildCredsForClient(creds);
      try {
        const data = await shamcashClient.transactionById(clientCreds, tx);
        res.json({ success: true, data });
      } catch (txErr) {
        // transactionById throws 404 when not found — return null data, not a server error
        if (txErr.status === 404) return res.json({ success: true, data: null });
        throw txErr;
      }
    } catch (e) {
      res.status(e.status || 500).json({ success: false, error: e.message });
    }
  });

  // ── Config (returns API_KEY for dashboard URL builder) ──────────────────
  app.get('/admin/api/config', requireAdmin, (req, res) => {
    res.json({ apiKey: process.env.API_KEY || '' });
  });

  // ── Soft Delete Account ──────────────────────────────────────────────────
  app.delete('/admin/api/accounts/:address', requireAdmin, async (req, res) => {
    try {
      const deleted = await store.deleteAccount(req.params.address);
      if (!deleted) return res.status(404).json({ error: 'Account not found' });
      res.json({ success: true, message: 'Account soft-deleted.' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

module.exports = { setupRoutes };
