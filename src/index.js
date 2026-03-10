require('dotenv').config();
const express = require('express');
const cors = require('cors');
const loginRoutes = require('./routes/login');
const sessionRoutes = require('./routes/session');
const sessionsRoutes = require('./routes/sessions');
const accountRoutes = require('./routes/account');
const store = require('./lib/store');
const db = require('./lib/db');

const app = express();
const PORT = process.env.PORT || 3000;

// TTL for pending QR sessions (never scanned). After this they are deleted by cleanup job. Default 15 min.
const PENDING_SESSION_TTL_MS = Math.max(0, parseInt(process.env.PENDING_SESSION_TTL_MS, 10) || 15 * 60 * 1000);
// TTL for api_keys (0 = never expire in our DB; ShamCash may still invalidate the underlying session). Default 0.
const API_KEY_TTL_MS = Math.max(0, parseInt(process.env.API_KEY_TTL_MS, 10) || 0);
// How often to run cleanup (default every 5 min).
const CLEANUP_INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 5 * 60 * 1000);

app.use(cors());
app.use(express.json());

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shamcash-api', store: store.USE_MEMORY ? 'memory' : 'mysql' });
});

// ── Email/Password Login ──────────────────────────────────────────────────────
app.post('/login', loginRoutes.doLogin);
app.post('/login/verify-otp', loginRoutes.verifyOtp);
app.post('/login/verify-2fa', loginRoutes.verify2fa);
app.post('/login/logout', loginRoutes.doLogout);

// ── QR Login (session) ───────────────────────────────────────────────────────
app.post('/session/createNew', sessionRoutes.createNew);       // generate QR → get sessionId
app.get('/session/:sessionId/check', sessionRoutes.check);     // poll → get apiKey when scanned
app.get('/session/:sessionId/status', sessionRoutes.status);   // metadata only

// ── Session Management ───────────────────────────────────────────────────────
app.get('/sessions', sessionsRoutes.list);                     // list all active API keys
app.delete('/sessions/:key', sessionsRoutes.revoke);           // revoke an API key

// ── Account (all require X-API-Key header) ──────────────────────────────────
app.get('/account/balance', accountRoutes.balance);            // balances: SYP, EUR, USD
app.get('/account/profile', accountRoutes.profile);            // myProfile (name, email, etc.)
app.get('/account/personal', accountRoutes.personal);          // PersonalAccount/get (+ address)
app.get('/account/settings', accountRoutes.settings);          // currency limits, visibility
app.get('/account/favorites', accountRoutes.favorites);        // saved favorite accounts
app.get('/account/exchange', accountRoutes.exchange);          // exchange/conversion rates
app.get('/account/mtn-wallets', accountRoutes.mtnWallets);     // MTN Cash wallets
app.get('/account/syriatel-wallets', accountRoutes.syriatelWallets); // Syriatel Cash wallets

// ── Receive QR ───────────────────────────────────────────────────────────────
app.get('/account/qr', accountRoutes.receiveQr);               // receive QR: address + base64 PNG
app.get('/account/address/:code', accountRoutes.addressLookup); // resolve code → account info

// ── Transactions ─────────────────────────────────────────────────────────────
app.get('/account/transactions', accountRoutes.transactions);          // Transaction/history-logs (detailed)
app.get('/account/transaction-history', accountRoutes.transactions);   // alias
app.get('/account/transaction-logs', accountRoutes.transactionLogs);   // Transaction/logs (simple)
app.get('/account/transactions-debug', accountRoutes.transactionsDebug); // try payload formats (format=minimal|web|no-next|page|all)
app.get('/account/transactions/:id', accountRoutes.transactionById);   // single transaction by ID

// ── Debug ─────────────────────────────────────────────────────────────────────
// GET /whoami — inspect stored credentials for an API key (no ShamCash call)
app.get('/whoami', async (req, res) => {
  const apiKey = req.get('x-api-key') || req.query.apiKey;
  if (!apiKey) return res.status(400).json({ error: 'X-API-Key header required' });
  const creds = await store.getApiKeyCredentials(apiKey);
  if (!creds) return res.status(404).json({ error: 'API key not found' });
  const redact = (v) => v ? `${String(v).substring(0, 20)}… (len=${String(v).length})` : null;
  res.json({
    tokenType:   creds.token?.startsWith('eyJ') ? 'JWT-bearer' : (creds.token ? 'non-JWT' : 'missing'),
    token:       redact(creds.token),
    accessToken: redact(creds.accessToken),
    authToken:   redact(creds.authToken),
    email:       creds.email || null,
    hasCookies:  Array.isArray(creds.cookies) ? creds.cookies.length : 0,
  });
});

// ── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function runCleanup() {
  try {
    const { pendingRemoved, apiKeysRemoved } = await store.cleanupExpired(PENDING_SESSION_TTL_MS, API_KEY_TTL_MS);
    if (pendingRemoved > 0 || apiKeysRemoved > 0) {
      console.log(`[cleanup] Expired: ${pendingRemoved} pending session(s), ${apiKeysRemoved} API key(s).`);
    }
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

async function start() {
  if (!store.USE_MEMORY) {
    await db.init();
    console.log('MySQL connected; database and tables ready.');
  } else {
    console.log('Using in-memory store (USE_MEMORY=true).');
  }

  await runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);
  console.log(`Cleanup: pending TTL=${PENDING_SESSION_TTL_MS / 60000}min, interval=${CLEANUP_INTERVAL_MS / 60000}min`);

  app.listen(PORT, () => {
    console.log(`\nShamCash API  →  http://localhost:${PORT}`);
    console.log('');
    console.log('  ── Email/Password Login ──────────────────────────');
    console.log('  POST   /login                    Login → get apiKey');
    console.log('  POST   /login/verify-otp         Complete OTP step');
    console.log('  POST   /login/verify-2fa         Complete 2FA step');
    console.log('  POST   /login/logout             Revoke session');
    console.log('');
    console.log('  ── QR Login ──────────────────────────────────────');
    console.log('  POST   /session/createNew        Generate QR code');
    console.log('  GET    /session/:id/check        Poll → get apiKey');
    console.log('');
    console.log('  ── Sessions ──────────────────────────────────────');
    console.log('  GET    /sessions                 List all API keys');
    console.log('  DELETE /sessions/:key            Revoke an API key');
    console.log('');
    console.log('  ── Account  (header: X-API-Key) ──────────────────');
    console.log('  GET    /account/balance          SYP / EUR / USD');
    console.log('  GET    /account/profile          Name, email, etc.');
    console.log('  GET    /account/personal         Full profile + address');
    console.log('  GET    /account/settings         Currency limits');
    console.log('  GET    /account/favorites        Saved accounts');
    console.log('  GET    /account/exchange         Exchange services');
    console.log('  GET    /account/mtn-wallets      MTN Cash wallets');
    console.log('  GET    /account/syriatel-wallets Syriatel wallets');
    console.log('');
    console.log('  ── Receive QR ────────────────────────────────────');
    console.log('  GET    /account/qr               Receive QR + address');
    console.log('  GET    /account/address/:code    Resolve code → info');
    console.log('');
    console.log('  ── Transactions ──────────────────────────────────');
    console.log('  GET    /account/transactions     Full history');
    console.log('  GET    /account/transaction-logs Simple logs');
    console.log('  GET    /account/transactions-debug ?format=all (try payload formats)');
    console.log('  GET    /account/transactions/:id Single by ID');
    console.log('');
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
