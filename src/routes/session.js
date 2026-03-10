/**
 * Session routes: createNew (QR + details), check (poll), status.
 * After QR is created, backend polls ShamCash Session/check in the background until scan+login or timeout.
 */

const { randomUUID } = require('crypto');
const QRCode = require('qrcode');
const crypto = require('../lib/crypto');
const device = require('../lib/device');
const store = require('../lib/store');
const shamcashClient = require('../lib/shamcashClient');

const SERVER_PUBLIC_KEY = process.env.SHAMCASH_SERVER_PUBLIC_KEY;
const AES_KEY = process.env.SHAMCASH_AES_KEY;

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const COMPLETED_TTL_MS = 10 * 60 * 1000;
const MAX_CONSECUTIVE_ERRORS = 10;

const backgroundPollIntervals = new Map();
const completedSessions = new Map();
const consecutiveErrors = new Map();

function pruneCompletedSessions() {
  const cutoff = Date.now() - COMPLETED_TTL_MS;
  for (const [id, v] of completedSessions.entries()) {
    if (v.createdAt < cutoff) completedSessions.delete(id);
  }
}

/**
 * Build cookies for stored credentials after sign-in.
 * Prefer cookies from Session/check response (forge, accessToken, authToken); fallback forge to session publicKey.
 */
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

/** Get authToken from Session/check response (body or cookies). */
function getAuthTokenFromResponse(data) {
  if (data && data.authToken) return data.authToken;
  if (Array.isArray(data?.cookies)) {
    const c = data.cookies.find(x => x && x.name === 'authToken');
    if (c) return c.value;
  }
  return null;
}

/** Get accessToken from Session/check response (body or cookies). */
function getAccessTokenFromResponse(data) {
  if (data && data.accessToken) return data.accessToken;
  if (Array.isArray(data?.cookies)) {
    const c = data.cookies.find(x => x && x.name === 'accessToken');
    if (c) return c.value;
  }
  return null;
}

/**
 * One ShamCash Session/check call. On success (logged in), saves apiKey to completedSessions,
 * deletes pending session, clears the background interval, and returns true.
 */
async function runBackgroundCheck(sessionId) {
  const session = await store.getPendingSession(sessionId);
  if (!session || completedSessions.has(sessionId)) {
    const tid = backgroundPollIntervals.get(sessionId);
    if (tid) {
      clearInterval(tid);
      backgroundPollIntervals.delete(sessionId);
    }
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
    console.warn('[Session/check] Stopping: too many consecutive errors for', sessionId.substring(0, 30));
    clearInterval(backgroundPollIntervals.get(sessionId));
    backgroundPollIntervals.delete(sessionId);
    consecutiveErrors.delete(sessionId);
    await store.deletePendingSession(sessionId);
    return true;
  }

  console.log(`[Poll #${errCount + 1}] sessionId: ${sessionId.substring(0, 30)}... | publicKey(forge cookie): ${session.publicKey?.substring(0, 30)}...`);

  try {
    const response = await shamcashClient.sessionCheck(
      session.encPayload,
      session.aesKeyEnc,
      session.infoDevice?.userAgent,
      session.publicKey,
    );
    consecutiveErrors.set(sessionId, 0);

    if (response.result === 1231) {
      console.log('[Poll] result=1231 (waiting for scan)');
      return false;
    }

    console.log('[Session/check] Response:', response.result, response.succeeded ? 'succeeded' : 'pending');

    const loggedIn = response && response.result === 2000 && response.succeeded === true && response.data?.encData;
    if (loggedIn) {
      console.log('[Session/check] Login detected! Decrypting response...');
      const keyFromForge = crypto.decryptForgeCookie(session.publicKey, AES_KEY);
      const data = keyFromForge && crypto.decryptWithForgeKey(response.data.encData, keyFromForge);
      if (!data) {
        console.warn('[Session/check] Failed to decrypt response encData');
        return false;
      }

      // Log all token fields so we can diagnose Bearer vs accessToken issues
      console.log('[Session/check] Decrypted data keys:', Object.keys(data).join(', '));
      for (const field of ['token', 'authToken', 'accessToken']) {
        const val = data[field];
        if (val) console.log(`[Session/check]   ${field}: ${String(val).substring(0, 30)}… (len=${String(val).length})`);
      }

      // Identify the mobile JWT Bearer token (starts with eyJ) vs hex short-lived accessToken
      const allTokens = [data.token, data.authToken, data.accessToken].filter(Boolean);
      const jwtToken  = allTokens.find(t => typeof t === 'string' && t.startsWith('eyJ'));
      const hexToken  = allTokens.find(t => typeof t === 'string' && !t.startsWith('eyJ'));

      const cookies = buildCredentialsCookies(data.cookies, session.publicKey);
      const authToken = getAuthTokenFromResponse(data);
      const accessToken = getAccessTokenFromResponse(data);
      const apiKey = await store.createApiKey(sessionId, {
        cookies,
        forge: session.publicKey,
        token:       jwtToken || authToken || data.token || null,   // JWT for Bearer header
        accessToken: hexToken  || accessToken || null,              // hex for encrypted body
        authToken: authToken || undefined,
        userAgent: session.infoDevice?.userAgent,
        infoDevice: session.infoDevice,
      });
      completedSessions.set(sessionId, { apiKey, createdAt: Date.now() });
      await store.deletePendingSession(sessionId);
      consecutiveErrors.delete(sessionId);
      const tid = backgroundPollIntervals.get(sessionId);
      if (tid) {
        clearInterval(tid);
        backgroundPollIntervals.delete(sessionId);
      }
      console.log('[Session/check] Login complete. API key:', apiKey.substring(0, 10) + '...');
      return true;
    }
  } catch (e) {
    const newCount = errCount + 1;
    consecutiveErrors.set(sessionId, newCount);
    const isNetworkError = !e.status;
    if (isNetworkError) {
      if (newCount <= 3 || newCount % 10 === 0) {
        console.warn(`[Session/check] Network error (${newCount}/${MAX_CONSECUTIVE_ERRORS}):`, e.message);
      }
    } else if (e.status !== 1231 && e.status !== 401) {
      console.warn('[Session/check] HTTP', e.status, e.message);
    }
  }
  return false;
}

function startBackgroundPolling(sessionId) {
  if (backgroundPollIntervals.has(sessionId)) return;
  console.log('[Session] Background polling started for', sessionId.substring(0, 30) + '...');
  const tid = setInterval(() => {
    runBackgroundCheck(sessionId).then(done => { if (done) return; });
  }, POLL_INTERVAL_MS);
  backgroundPollIntervals.set(sessionId, tid);
  setImmediate(() => {
    runBackgroundCheck(sessionId).catch(err => console.warn('[Session] First check error:', err.message));
  });
}

/**
 * POST /session/createNew
 * Uses site format: encrypted sessionId/publicKey in QR and forge cookie; Session/check with encData.aesKey (PKCS1-V1_5).
 * Requires SHAMCASH_AES_KEY and SHAMCASH_SERVER_PUBLIC_KEY in .env.
 */
async function createNew(req, res) {
  try {
    if (!AES_KEY || !SERVER_PUBLIC_KEY) {
      return res.status(500).json({
        error: 'Missing SHAMCASH_AES_KEY or SHAMCASH_SERVER_PUBLIC_KEY in .env',
        message: 'Add both keys from .env.example to enable QR login.',
      });
    }

    const deviceContext = device.generateDeviceContext();
    const infoDeviceForQr = {
      deviceName: 'Media-Man-Bot',
      os: deviceContext.os,
      browser: deviceContext.browser,
    };
    const infoDeviceStored = {
      ...infoDeviceForQr,
      userAgent: deviceContext.userAgent,
    };

    const rawSessionId = randomUUID();
    const rawPublicKey = crypto.generatePublicKeyRaw();
    const encryptedSessionId = crypto.encryptForgeFormat(rawSessionId, AES_KEY);
    const encryptedPublicKey = crypto.encryptForgeFormat(rawPublicKey, AES_KEY);
    if (!encryptedSessionId || !encryptedPublicKey) {
      return res.status(500).json({ error: 'Encryption failed (check SHAMCASH_AES_KEY)' });
    }

    const sessionIdInQr = encryptedSessionId + '#XXX';
    const qrPayload = {
      sessionId: sessionIdInQr,
      publicKey: encryptedPublicKey,
      infoDevice: infoDeviceForQr,
    };
    const qrJson = JSON.stringify(qrPayload);

    let qrImageBase64;
    try {
      qrImageBase64 = await QRCode.toDataURL(qrJson, { type: 'image/png', margin: 2, width: 256 });
    } catch (e) {
      return res.status(500).json({ error: 'QR generation failed', detail: e.message });
    }

    // Real app's interceptor merges { accessToken: cookieValue, ...requestData }.
    // On initial login there's no accessToken cookie yet, so cg() returns "".
    // The payload is { accessToken: "", sessionId: rawUUID } — the RAW UUID, not the encrypted one.
    const sessionCheckPlaintext = { accessToken: '', sessionId: rawSessionId };
    const encPayload = crypto.encryptSessionCheck(sessionCheckPlaintext, SERVER_PUBLIC_KEY);
    if (!encPayload) {
      return res.status(500).json({ error: 'Session/check encryption failed (check SHAMCASH_SERVER_PUBLIC_KEY)' });
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

    const localCheckUrl = `http://localhost:${process.env.PORT || 3009}/session/${encodeURIComponent(encryptedSessionId)}/check`;

    console.log('\n========== SESSION CREATED ==========');
    console.log('[createNew] Raw sessionId (UUID):', rawSessionId);
    console.log('[createNew] Raw publicKey (zo):', rawPublicKey);
    console.log('[createNew] Encrypted sessionId:', encryptedSessionId);
    console.log('[createNew] Encrypted publicKey:', encryptedPublicKey);
    console.log('[createNew] Session/check plaintext payload:', JSON.stringify(sessionCheckPlaintext));
    console.log('[createNew] Session/check encData:', encPayload.encData.substring(0, 60) + '...');
    console.log('[createNew] Session/check aesKey:', encPayload.aesKey.substring(0, 40) + '...');
    console.log('');
    console.log('[createNew] >>> Manual check URL (copy & paste into browser or curl):');
    console.log(localCheckUrl);
    console.log('=====================================\n');

    res.json({
      success: true,
      qrImage: qrImageBase64,
      qrPayload: qrPayload,
      sessionId: qrPayload.sessionId,
      publicKey: qrPayload.publicKey,
      infoDevice: infoDeviceForQr,
      checkUrl: localCheckUrl,
      message: 'Scan QR with ShamCash app. Poll the checkUrl until loggedIn: true and apiKey.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * GET /session/:sessionId/check
 * Returns status from backend polling. If backend already got login from ShamCash, returns apiKey.
 * No ShamCash call is made here; the backend polls ShamCash in the background after createNew.
 */
async function check(req, res) {
  const sessionId = (req.params.sessionId || '').replace(/#XXX$/, '');
  pruneCompletedSessions();
  const completed = completedSessions.get(sessionId);
  if (completed) {
    completedSessions.delete(sessionId);
    return res.json({
      success: true,
      loggedIn: true,
      apiKey: completed.apiKey,
      message: 'Use this apiKey in header X-API-Key for /balance and /transactions',
    });
  }
  const session = await store.getPendingSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  return res.json({
    success: true,
    loggedIn: false,
    message: 'Waiting for scan. Backend is polling ShamCash.',
  });
}

/**
 * GET /session/:sessionId/status
 */
async function status(req, res) {
  const sessionId = (req.params.sessionId || '').replace(/#XXX$/, '');
  const session = await store.getPendingSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }
  res.json({
    sessionId,
    publicKey: session.publicKey,
    infoDevice: session.infoDevice,
    hasEncPayload: !!(session.encPayload && session.aesKeyEnc),
  });
}

module.exports = {
  createNew,
  check,
  status,
};
