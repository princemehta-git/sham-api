/**
 * Session and API key store. Uses in-memory when USE_MEMORY=true, MySQL otherwise.
 * API keys saved in MySQL can be used later to fetch balance/transactions.
 */

const { randomBytes } = require('crypto');

const USE_MEMORY = process.env.USE_MEMORY === 'true';

const pendingSessions = new Map();
const apiKeys = new Map();

function generateApiKey() {
  return 'sk_' + randomBytes(32).toString('hex');
}

// ---------- In-memory implementation ----------
function createPendingSessionMemory(data) {
  const rawId = (data.sessionId || '').replace(/#XXX$/, '');
  const id = rawId || randomBytes(24).toString('base64url');
  pendingSessions.set(id, {
    sessionId: data.sessionId || id,
    publicKey: data.publicKey,
    infoDevice: data.infoDevice || {},
    createdAt: Date.now(),
    encPayload: data.encPayload,
    aesKeyEnc: data.aesKeyEnc,
    ...data,
  });
  return id;
}

function getPendingSessionMemory(sessionId) {
  return pendingSessions.get(sessionId) || null;
}

function setPendingSessionMemory(sessionId, data) {
  const existing = pendingSessions.get(sessionId) || {};
  pendingSessions.set(sessionId, { ...existing, ...data });
}

function deletePendingSessionMemory(sessionId) {
  pendingSessions.delete(sessionId);
}

function listApiKeysMemory() {
  return Array.from(apiKeys.entries()).map(([key, row]) => ({
    apiKey: key,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    email: row.credentials?.email || null,
    label: row.credentials?.label || null,
    infoDevice: row.credentials?.infoDevice,
  }));
}

function deleteApiKeyMemory(apiKey) {
  return apiKeys.delete(apiKey);
}

function createApiKeyMemory(sessionId, credentials) {
  const key = generateApiKey();
  apiKeys.set(key, { sessionId, credentials, createdAt: Date.now() });
  return key;
}

function getApiKeyCredentialsMemory(apiKey) {
  const row = apiKeys.get(apiKey);
  return row ? row.credentials : null;
}

function getApiKeySessionMemory(apiKey) {
  const row = apiKeys.get(apiKey);
  return row ? row.sessionId : null;
}

// ---------- MySQL implementation ----------
async function createPendingSessionMySQL(data) {
  const db = require('./db');
  const rawId = (data.sessionId || '').replace(/#XXX$/, '');
  const id = rawId || randomBytes(24).toString('base64url');
  const now = Date.now();
  await db.query(
    `INSERT INTO pending_sessions (session_id, public_key, info_device, enc_payload, aes_key_enc, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE public_key = VALUES(public_key), info_device = VALUES(info_device),
     enc_payload = VALUES(enc_payload), aes_key_enc = VALUES(aes_key_enc)`,
    [
      id,
      data.publicKey || null,
      JSON.stringify(data.infoDevice || {}),
      data.encPayload || null,
      data.aesKeyEnc || null,
      now,
    ]
  );
  return id;
}

async function getPendingSessionMySQL(sessionId) {
  const db = require('./db');
  const rows = await db.query('SELECT * FROM pending_sessions WHERE session_id = ?', [sessionId]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    sessionId: r.session_id,
    publicKey: r.public_key,
    infoDevice: typeof r.info_device === 'string' ? JSON.parse(r.info_device || '{}') : (r.info_device || {}),
    createdAt: Number(r.created_at),
    encPayload: r.enc_payload,
    aesKeyEnc: r.aes_key_enc,
  };
}

async function setPendingSessionMySQL(sessionId, data) {
  const db = require('./db');
  const existing = await getPendingSessionMySQL(sessionId);
  const merged = { ...existing, ...data };
  await db.query(
    `UPDATE pending_sessions SET public_key = ?, info_device = ?, enc_payload = ?, aes_key_enc = ? WHERE session_id = ?`,
    [
      merged.publicKey ?? null,
      JSON.stringify(merged.infoDevice || {}),
      merged.encPayload ?? null,
      merged.aesKeyEnc ?? null,
      sessionId,
    ]
  );
}

async function deletePendingSessionMySQL(sessionId) {
  const db = require('./db');
  await db.query('DELETE FROM pending_sessions WHERE session_id = ?', [sessionId]);
}

async function createApiKeyMySQL(sessionId, credentials) {
  const db = require('./db');
  const key = generateApiKey();
  const now = Date.now();
  const cred = credentials || {};
  await db.query(
    'INSERT INTO api_keys (api_key, session_id, credentials, email, label, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [key, sessionId, JSON.stringify(cred), cred.email || null, cred.label || null, now]
  );
  return key;
}

async function getApiKeyCredentialsMySQL(apiKey) {
  const db = require('./db');
  const rows = await db.query('SELECT credentials FROM api_keys WHERE api_key = ?', [apiKey]);
  if (!rows.length) return null;
  const cred = rows[0].credentials;
  return typeof cred === 'string' ? JSON.parse(cred) : cred;
}

async function getApiKeySessionMySQL(apiKey) {
  const db = require('./db');
  const rows = await db.query('SELECT session_id FROM api_keys WHERE api_key = ?', [apiKey]);
  return rows.length ? rows[0].session_id : null;
}

async function listApiKeysMySQL() {
  const db = require('./db');
  const rows = await db.query(
    'SELECT api_key, session_id, created_at, credentials, email, label FROM api_keys ORDER BY created_at DESC'
  );
  return rows.map(r => {
    const cred = typeof r.credentials === 'string' ? JSON.parse(r.credentials || '{}') : (r.credentials || {});
    return {
      apiKey: r.api_key,
      sessionId: r.session_id,
      createdAt: Number(r.created_at),
      email: r.email || cred.email || null,
      label: r.label || cred.label || null,
      infoDevice: cred.infoDevice,
    };
  });
}

async function deleteApiKeyMySQL(apiKey) {
  const db = require('./db');
  const rows = await db.query('DELETE FROM api_keys WHERE api_key = ?', [apiKey]);
  return rows.affectedRows > 0;
}

// ---------- Cleanup (expire old records) ----------
function cleanupExpiredPendingSessionsMemory(cutoffMs) {
  const cutoff = Date.now() - cutoffMs;
  let removed = 0;
  for (const [id, s] of pendingSessions.entries()) {
    if (s.createdAt < cutoff) {
      pendingSessions.delete(id);
      removed++;
    }
  }
  return removed;
}

function cleanupExpiredApiKeysMemory(cutoffMs) {
  if (cutoffMs <= 0) return 0;
  const cutoff = Date.now() - cutoffMs;
  let removed = 0;
  for (const [key, row] of apiKeys.entries()) {
    if (row.createdAt < cutoff) {
      apiKeys.delete(key);
      removed++;
    }
  }
  return removed;
}

async function cleanupExpiredPendingSessionsMySQL(cutoffMs) {
  const db = require('./db');
  const cutoff = Date.now() - cutoffMs;
  const [result] = await db.getPool().execute('DELETE FROM pending_sessions WHERE created_at < ?', [cutoff]);
  return (result && result.affectedRows) || 0;
}

async function cleanupExpiredApiKeysMySQL(cutoffMs) {
  if (cutoffMs <= 0) return 0;
  const db = require('./db');
  const cutoff = Date.now() - cutoffMs;
  const [result] = await db.getPool().execute('DELETE FROM api_keys WHERE created_at < ?', [cutoff]);
  return (result && result.affectedRows) || 0;
}

/** Run cleanup: remove pending sessions older than pendingTtlMs and optionally api_keys older than apiKeyTtlMs (0 = skip). Returns { pendingRemoved, apiKeysRemoved }. */
async function cleanupExpired(pendingTtlMs, apiKeyTtlMs = 0) {
  const pendingRemoved = USE_MEMORY
    ? cleanupExpiredPendingSessionsMemory(pendingTtlMs)
    : await cleanupExpiredPendingSessionsMySQL(pendingTtlMs);
  const apiKeysRemoved = USE_MEMORY
    ? cleanupExpiredApiKeysMemory(apiKeyTtlMs)
    : await cleanupExpiredApiKeysMySQL(apiKeyTtlMs);
  return { pendingRemoved, apiKeysRemoved };
}

// ---------- Unified async API ----------
async function createPendingSession(data) {
  return USE_MEMORY ? createPendingSessionMemory(data) : createPendingSessionMySQL(data);
}

async function getPendingSession(sessionId) {
  return USE_MEMORY ? getPendingSessionMemory(sessionId) : getPendingSessionMySQL(sessionId);
}

async function setPendingSession(sessionId, data) {
  return USE_MEMORY ? setPendingSessionMemory(sessionId, data) : setPendingSessionMySQL(sessionId, data);
}

async function deletePendingSession(sessionId) {
  return USE_MEMORY ? deletePendingSessionMemory(sessionId) : deletePendingSessionMySQL(sessionId);
}

async function createApiKey(sessionId, credentials) {
  return USE_MEMORY ? createApiKeyMemory(sessionId, credentials) : createApiKeyMySQL(sessionId, credentials);
}

async function getApiKeyCredentials(apiKey) {
  return USE_MEMORY ? getApiKeyCredentialsMemory(apiKey) : getApiKeyCredentialsMySQL(apiKey);
}

async function getApiKeySession(apiKey) {
  return USE_MEMORY ? getApiKeySessionMemory(apiKey) : getApiKeySessionMySQL(apiKey);
}

async function listApiKeys() {
  return USE_MEMORY ? listApiKeysMemory() : listApiKeysMySQL();
}

async function deleteApiKey(apiKey) {
  return USE_MEMORY ? deleteApiKeyMemory(apiKey) : deleteApiKeyMySQL(apiKey);
}

module.exports = {
  createPendingSession,
  getPendingSession,
  setPendingSession,
  deletePendingSession,
  createApiKey,
  getApiKeyCredentials,
  getApiKeySession,
  listApiKeys,
  deleteApiKey,
  generateApiKey,
  cleanupExpired,
  pendingSessions,
  apiKeys,
  USE_MEMORY,
};
