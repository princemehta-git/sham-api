/**
 * Login route — mimics the mobile app's Authentication/signin flow.
 *
 * POST /login  { email, password, deviceToken? }
 *   → calls Authentication/signin on api.shamcash.sy
 *   → on success: stores JWT token in DB, returns { apiKey }
 *   → on OTP required (result 2001): returns { otpRequired, phoneNumber }
 *   → on 2FA required: returns { twoFaRequired, phoneNumber }
 *
 * POST /login/verify-otp  { email, otpCode, apiKeyPending }
 *   → calls Authentication/verify, completes the session
 *
 * POST /login/logout  { }  (X-API-Key header)
 *   → calls server logout, removes API key from store
 */

const store = require('../lib/store');
const client = require('../lib/shamcashClient');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the main auth token from a login response (various field names). */
function extractToken(data) {
  return data?.token || data?.authToken || data?.accessToken || data?.data?.token || null;
}

/** Extract accessToken (short-lived, used in encrypted body) from response. */
function extractAccessToken(data) {
  return data?.accessToken || data?.data?.accessToken || data?.token || null;
}

/** Build credentials object stored in DB for this session. */
function buildCredentials(responseData, email, extra = {}) {
  return {
    token:       extractToken(responseData),
    accessToken: extractAccessToken(responseData),
    email,
    infoDevice:  client.DEVICE_INFO,
    ...extra,
  };
}

// ── POST /login ───────────────────────────────────────────────────────────────

async function doLogin(req, res) {
  const { email, password, deviceToken, label } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  let response;
  try {
    response = await client.login(email, password, deviceToken);
  } catch (e) {
    console.error('[/login] ShamCash error:', e.status, e.message, e.data);
    return res.status(e.status || 502).json({
      error: 'Login failed',
      detail: e.message,
      data: e.data,
    });
  }

  const result = response?.result ?? response?.data?.result;
  const data   = response?.data ?? response;

  console.log('[/login] result:', result, 'succeeded:', response?.succeeded);

  // ── OTP required (result 2001 or LoginState.successNotOtpVerfied) ──────────
  if (result === 2001 || response?.succeeded === false && data?.phoneNumber) {
    // Store a pending-otp entry keyed by a temporary token so /verify-otp can finish it
    const pendingKey = store.generateApiKey();
    await store.createApiKey('pending_otp_' + pendingKey, {
      email,
      pendingOtp: true,
      token: extractToken(data) || '',
    });
    return res.json({
      success: false,
      otpRequired: true,
      phoneNumber: data?.phoneNumber,
      pendingKey,
      message: 'OTP sent. Call POST /login/verify-otp with { email, otpCode, pendingKey }',
    });
  }

  // ── 2FA required (LoginState.twoFactorAuthentication) ────────────────────
  if (result === 2002 || (response?.succeeded === false && data?.twoFactor)) {
    return res.json({
      success: false,
      twoFaRequired: true,
      phoneNumber: data?.phoneNumber,
      message: 'Call POST /login/verify-2fa with { email, code }',
    });
  }

  // ── Success (result 2000) ─────────────────────────────────────────────────
  const token = extractToken(data);
  if (!token && response?.succeeded !== true) {
    console.warn('[/login] Unexpected response:', JSON.stringify(response).substring(0, 400));
    return res.status(502).json({ error: 'Unexpected login response', raw: response });
  }

  const credentials = buildCredentials(data, email, { label: label || email });
  const apiKey = await store.createApiKey('session_' + Date.now(), credentials);

  console.log('[/login] ✓ Logged in as', email, '→ apiKey:', apiKey.substring(0, 12) + '…');

  res.json({
    success: true,
    apiKey,
    email,
    message: 'Use apiKey in X-API-Key header for all /account/* calls.',
  });
}

// ── POST /login/verify-otp ────────────────────────────────────────────────────

async function verifyOtp(req, res) {
  const { email, otpCode, pendingKey } = req.body || {};
  if (!email || !otpCode) {
    return res.status(400).json({ error: 'email and otpCode are required' });
  }

  let response;
  try {
    response = await client.verifyOtp(email, otpCode);
  } catch (e) {
    return res.status(e.status || 502).json({ error: 'OTP verification failed', detail: e.message, data: e.data });
  }

  // Remove pending entry if it was stored
  if (pendingKey) {
    await store.deleteApiKey('pending_otp_' + pendingKey).catch(() => {});
  }

  const data  = response?.data ?? response;
  const token = extractToken(data);
  if (!token) {
    return res.status(502).json({ error: 'OTP verified but no token returned', raw: response });
  }

  const credentials = buildCredentials(data, email);
  const apiKey = await store.createApiKey('session_otp_' + Date.now(), credentials);

  res.json({ success: true, apiKey, email, message: 'OTP verified. Use apiKey in X-API-Key header.' });
}

// ── POST /login/verify-2fa ────────────────────────────────────────────────────

async function verify2fa(req, res) {
  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ error: 'email and code are required' });
  }

  let response;
  try {
    response = await client.check2fa(email, code);
  } catch (e) {
    return res.status(e.status || 502).json({ error: '2FA failed', detail: e.message, data: e.data });
  }

  const data  = response?.data ?? response;
  const token = extractToken(data);
  if (!token) {
    return res.status(502).json({ error: '2FA passed but no token returned', raw: response });
  }

  const credentials = buildCredentials(data, email);
  const apiKey = await store.createApiKey('session_2fa_' + Date.now(), credentials);
  res.json({ success: true, apiKey, email });
}

// ── POST /login/logout ────────────────────────────────────────────────────────

async function doLogout(req, res) {
  const apiKey = req.get('x-api-key') || req.body?.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'X-API-Key header required' });

  const creds = await store.getApiKeyCredentials(apiKey);
  if (!creds) return res.status(404).json({ error: 'API key not found' });

  // Call server logout (best-effort)
  if (creds.token) {
    await client.logout(creds.token);
  }

  await store.deleteApiKey(apiKey);
  res.json({ success: true, message: 'Logged out and API key revoked.' });
}

module.exports = { doLogin, verifyOtp, verify2fa, doLogout };
