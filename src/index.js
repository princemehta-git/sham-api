require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const store = require('./lib/store');

const app = express();
const PORT = process.env.PORT || 3000;

const PENDING_SESSION_TTL_MS = Math.max(0, parseInt(process.env.PENDING_SESSION_TTL_MS, 10) || 15 * 60 * 1000);
const CLEANUP_INTERVAL_MS = Math.max(60 * 1000, parseInt(process.env.CLEANUP_INTERVAL_MS, 10) || 5 * 60 * 1000);

app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'shamcash-api', store: store.USE_MEMORY ? 'memory' : 'mysql' });
});

// ── Admin HTML Pages ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.redirect('/admin');
});
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'login.html'));
});
app.get('/admin/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
});

// ── Admin API Routes ────────────────────────────────────────────────────────
const adminRoutes = require('./routes/admin');
adminRoutes.setupRoutes(app);

// ── Public API (/api/v1) ────────────────────────────────────────────────────
const apiRoutes = require('./routes/api');
apiRoutes.setupRoutes(app);

// ── Error handler ───────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ── Cleanup ─────────────────────────────────────────────────────────────────
async function runCleanup() {
  try {
    const { pendingRemoved } = await store.cleanupExpired(PENDING_SESSION_TTL_MS);
    if (pendingRemoved > 0) {
      console.log(`[cleanup] Removed ${pendingRemoved} expired pending session(s).`);
    }
  } catch (e) {
    console.error('[cleanup] Error:', e.message);
  }
}

// ── Start ───────────────────────────────────────────────────────────────────
async function start() {
  if (!store.USE_MEMORY) {
    const sequelizeLib = require('./lib/sequelize');
    await sequelizeLib.init();
    console.log('MySQL connected; Sequelize models synced.');
  } else {
    console.log('Using in-memory store (USE_MEMORY=true).');
  }

  await runCleanup();
  setInterval(runCleanup, CLEANUP_INTERVAL_MS);

  app.listen(PORT, () => {
    console.log(`\nShamCash API  ->  http://localhost:${PORT}`);
    console.log('');
    console.log('  -- Admin Dashboard ------------------------------------');
    console.log(`  GET    /admin                     Login page`);
    console.log(`  GET    /admin/dashboard            Dashboard`);
    console.log('');
    console.log('  -- Admin API ------------------------------------------');
    console.log('  POST   /admin/api/login            Admin login');
    console.log('  POST   /admin/api/logout           Admin logout');
    console.log('  POST   /admin/api/session/create    Generate QR');
    console.log('  GET    /admin/api/session/:id/check  Poll session');
    console.log('  GET    /admin/api/accounts           List accounts');
    console.log('  DELETE /admin/api/accounts/:addr     Soft-delete');
    console.log('  GET    /admin/api/accounts/:addr/balance');
    console.log('  GET    /admin/api/accounts/:addr/transactions');
    console.log('  GET    /admin/api/accounts/:addr/qr');
    console.log('');
    console.log('  -- Public API -----------------------------------------');
    console.log('  GET    /api/v1?resource=shamcash&action=logs&account_address=...&api_key=...');
    console.log('  GET    /api/v1?resource=shamcash&action=balance&account_address=...&api_key=...');
    console.log('  GET    /api/v1?resource=shamcash&action=find_tx&tx=...&account_address=...&api_key=...');
    console.log('');
  });
}

start().catch((err) => {
  console.error('Startup failed:', err);
  process.exit(1);
});
