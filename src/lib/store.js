/**
 * Unified store for accounts and pending sessions.
 * Uses in-memory Maps when USE_MEMORY=true, Sequelize/MySQL otherwise.
 */

const USE_MEMORY = process.env.USE_MEMORY === 'true';

// ── In-memory stores ─────────────────────────────────────────────────────────
const pendingSessions = new Map();
const accounts = new Map();        // account_address -> { credentials, name, email, ... }
const deletedAccounts = [];        // soft-deleted accounts

// ══════════════════════════════════════════════════════════════════════════════
//  PENDING SESSIONS
// ══════════════════════════════════════════════════════════════════════════════

// ── Memory ───────────────────────────────────────────────────────────────────
function createPendingSessionMemory(data) {
  const id = (data.sessionId || '').replace(/#XXX$/, '') || require('crypto').randomBytes(24).toString('base64url');
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

// ── Sequelize ────────────────────────────────────────────────────────────────
async function createPendingSessionDB(data) {
  const { PendingSession } = require('../models').getModels();
  const id = (data.sessionId || '').replace(/#XXX$/, '') || require('crypto').randomBytes(24).toString('base64url');
  await PendingSession.upsert({
    session_id: id,
    public_key: data.publicKey || null,
    info_device: data.infoDevice || {},
    enc_payload: data.encPayload || null,
    aes_key_enc: data.aesKeyEnc || null,
    account_name: data.accountName || null,
    created_at: Date.now(),
  });
  return id;
}

async function getPendingSessionDB(sessionId) {
  const { PendingSession } = require('../models').getModels();
  const row = await PendingSession.findByPk(sessionId);
  if (!row) return null;
  return {
    sessionId: row.session_id,
    publicKey: row.public_key,
    infoDevice: row.info_device || {},
    createdAt: Number(row.created_at),
    encPayload: row.enc_payload,
    aesKeyEnc: row.aes_key_enc,
    accountName: row.account_name || null,
  };
}

async function setPendingSessionDB(sessionId, data) {
  const { PendingSession } = require('../models').getModels();
  const row = await PendingSession.findByPk(sessionId);
  if (!row) return;
  if (data.publicKey !== undefined) row.public_key = data.publicKey;
  if (data.infoDevice !== undefined) row.info_device = data.infoDevice;
  if (data.encPayload !== undefined) row.enc_payload = data.encPayload;
  if (data.aesKeyEnc !== undefined) row.aes_key_enc = data.aesKeyEnc;
  await row.save();
}

async function deletePendingSessionDB(sessionId) {
  const { PendingSession } = require('../models').getModels();
  await PendingSession.destroy({ where: { session_id: sessionId } });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ACCOUNTS (keyed by account_address)
// ══════════════════════════════════════════════════════════════════════════════

// ── Memory ───────────────────────────────────────────────────────────────────
function createAccountMemory(accountAddress, data) {
  accounts.set(accountAddress, {
    account_address: accountAddress,
    credentials: data.credentials,
    name: data.name || null,
    email: data.email || null,
    session_id: data.sessionId || null,
    label: data.label || null,
    created_at: new Date(),
    updated_at: new Date(),
  });
  return accountAddress;
}

function getAccountMemory(accountAddress) {
  return accounts.get(accountAddress) || null;
}

function listAccountsMemory() {
  return Array.from(accounts.values());
}

function deleteAccountMemory(accountAddress) {
  const acct = accounts.get(accountAddress);
  if (!acct) return false;
  deletedAccounts.push({
    ...acct,
    original_created_at: acct.created_at,
    deleted_at: new Date(),
  });
  accounts.delete(accountAddress);
  return true;
}

function getAccountCredentialsMemory(accountAddress) {
  const acct = accounts.get(accountAddress);
  return acct ? acct.credentials : null;
}

// ── Sequelize ────────────────────────────────────────────────────────────────
async function createAccountDB(accountAddress, data) {
  const { Account } = require('../models').getModels();
  await Account.upsert({
    account_address: accountAddress,
    credentials: data.credentials,
    name: data.name || null,
    email: data.email || null,
    session_id: data.sessionId || null,
    label: data.label || null,
  });
  return accountAddress;
}

async function getAccountDB(accountAddress) {
  const { Account } = require('../models').getModels();
  const row = await Account.findByPk(accountAddress);
  if (!row) return null;
  return row.toJSON();
}

async function listAccountsDB() {
  const { Account } = require('../models').getModels();
  const rows = await Account.findAll({ order: [['created_at', 'DESC']] });
  return rows.map(r => r.toJSON());
}

async function deleteAccountDB(accountAddress) {
  const { Account, DeletedAccount } = require('../models').getModels();
  const acct = await Account.findByPk(accountAddress);
  if (!acct) return false;
  await DeletedAccount.create({
    account_address: acct.account_address,
    name: acct.name,
    email: acct.email,
    credentials: acct.credentials,
    session_id: acct.session_id,
    label: acct.label,
    original_created_at: acct.created_at,
    deleted_at: new Date(),
  });
  await acct.destroy();
  return true;
}

async function getAccountCredentialsDB(accountAddress) {
  const { Account } = require('../models').getModels();
  const row = await Account.findByPk(accountAddress);
  return row ? row.credentials : null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CLEANUP
// ══════════════════════════════════════════════════════════════════════════════

function cleanupExpiredPendingMemory(cutoffMs) {
  const cutoff = Date.now() - cutoffMs;
  let removed = 0;
  for (const [id, s] of pendingSessions.entries()) {
    if (s.createdAt < cutoff) { pendingSessions.delete(id); removed++; }
  }
  return removed;
}

async function cleanupExpiredPendingDB(cutoffMs) {
  const { Op } = require('sequelize');
  const { PendingSession } = require('../models').getModels();
  const cutoff = Date.now() - cutoffMs;
  const count = await PendingSession.destroy({ where: { created_at: { [Op.lt]: cutoff } } });
  return count;
}

async function cleanupExpired(pendingTtlMs) {
  const pendingRemoved = USE_MEMORY
    ? cleanupExpiredPendingMemory(pendingTtlMs)
    : await cleanupExpiredPendingDB(pendingTtlMs);
  return { pendingRemoved };
}

// ══════════════════════════════════════════════════════════════════════════════
//  UNIFIED ASYNC API
// ══════════════════════════════════════════════════════════════════════════════

async function createPendingSession(data) {
  return USE_MEMORY ? createPendingSessionMemory(data) : await createPendingSessionDB(data);
}
async function getPendingSession(sessionId) {
  return USE_MEMORY ? getPendingSessionMemory(sessionId) : await getPendingSessionDB(sessionId);
}
async function setPendingSession(sessionId, data) {
  return USE_MEMORY ? setPendingSessionMemory(sessionId, data) : await setPendingSessionDB(sessionId, data);
}
async function deletePendingSession(sessionId) {
  return USE_MEMORY ? deletePendingSessionMemory(sessionId) : await deletePendingSessionDB(sessionId);
}

async function createAccount(accountAddress, data) {
  return USE_MEMORY ? createAccountMemory(accountAddress, data) : await createAccountDB(accountAddress, data);
}
async function getAccount(accountAddress) {
  return USE_MEMORY ? getAccountMemory(accountAddress) : await getAccountDB(accountAddress);
}
async function listAccounts() {
  return USE_MEMORY ? listAccountsMemory() : await listAccountsDB();
}
async function deleteAccount(accountAddress) {
  return USE_MEMORY ? deleteAccountMemory(accountAddress) : await deleteAccountDB(accountAddress);
}
async function getAccountCredentials(accountAddress) {
  return USE_MEMORY ? getAccountCredentialsMemory(accountAddress) : await getAccountCredentialsDB(accountAddress);
}

module.exports = {
  createPendingSession,
  getPendingSession,
  setPendingSession,
  deletePendingSession,
  createAccount,
  getAccount,
  listAccounts,
  deleteAccount,
  getAccountCredentials,
  cleanupExpired,
  pendingSessions,
  accounts,
  USE_MEMORY,
};
