/**
 * Encryption layer — mimics the ShamCash MOBILE app (libapp.so / encrypt_helper_new.dart).
 *
 * Mobile scheme (confirmed from binary + string analysis):
 *   • Fixed AES string key: SHAMCASH_AES_KEY (24 chars used as-is → AES-192-GCM)
 *   • Session/create body: yv() → random zo() key + RSA-PKCS1-V1_5 wrap → { encData, aesKey }
 *   • Authenticated account calls: BZ() → body encrypted with FIXED key → { encData }
 *   • Responses with data.encData decrypted with FIXED key (mobile, no forge cookie)
 *
 * Key format: "base64(ciphertext+tag).base64(iv)"  (both encrypt and decrypt)
 */

const forge = require('node-forge');

const FORGE_IV_LENGTH = 12;
const GCM_TAG_LENGTH  = 16;

/**
 * zo() — 16 random bytes → base64url-with-padding string (24 chars).
 * One-time AES key for Session/create (yv function).
 */
function zo() {
  const raw = forge.random.getBytesSync(16);
  return forge.util.encode64(raw).replace(/\+/g, '-').replace(/\//g, '_');
}
const generatePublicKeyRaw = zo;

/**
 * ef(plaintext, keyString) — AES-192-GCM encrypt with 24-char string key.
 * Returns "base64(ct+tag).base64(iv)" or null on error.
 */
function ef(plaintext, keyString) {
  if (!plaintext || !keyString) return null;
  const iv = forge.random.getBytesSync(FORGE_IV_LENGTH);
  const cipher = forge.cipher.createCipher('AES-GCM', keyString);
  cipher.start({ iv });
  cipher.update(forge.util.createBuffer(String(plaintext), 'utf8'));
  cipher.finish();
  const ct  = cipher.output.getBytes();
  const tag = cipher.mode.tag.getBytes();
  return forge.util.encode64(ct + tag) + '.' + forge.util.encode64(iv);
}
const encryptForgeFormat = ef;

/**
 * df(encData, keyString) — AES-192-GCM decrypt "base64(ct+tag).base64(iv)".
 * Returns decrypted UTF-8 string, or null on failure.
 */
function df(encData, keyString) {
  if (!encData || !keyString) return null;
  const parts = String(encData).split('.');
  if (parts.length !== 2) return null;
  try {
    const ctAndTag = forge.util.decode64(parts[0]);
    const iv       = forge.util.decode64(parts[1]);
    if (!ctAndTag || !iv || ctAndTag.length < GCM_TAG_LENGTH) return null;
    const ct  = ctAndTag.slice(0, -GCM_TAG_LENGTH);
    const tag = ctAndTag.slice(-GCM_TAG_LENGTH);
    const decipher = forge.cipher.createDecipher('AES-GCM', keyString);
    decipher.start({
      iv:  forge.util.createBuffer(iv,  'binary'),
      tag: forge.util.createBuffer(tag, 'binary'),
    });
    decipher.update(forge.util.createBuffer(ct, 'binary'));
    if (!decipher.finish()) return null;
    return decipher.output.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * encryptBody(plaintextJson, fixedAesKey) — mobile BZ function.
 * Encrypts with the FIXED AES key (not a per-session key like web).
 * Returns { encData } or null.
 */
function encryptBody(plaintextJson, fixedAesKey) {
  const encData = ef(plaintextJson, fixedAesKey);
  return encData ? { encData } : null;
}

/**
 * decryptResponse(encData, fixedAesKey) — mobile SL function.
 * Decrypts data.encData from response using FIXED AES key.
 * Returns parsed JSON or null.
 */
function decryptResponse(encData, fixedAesKey) {
  if (!encData || !fixedAesKey) return null;
  try {
    const json = df(encData, fixedAesKey);
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/**
 * normalizePem — PKCS#1 or PKCS#8 RSA public key for node-forge.
 * Handles keys with spaces or newlines; strips quotes from .env.
 */
function normalizePem(pem) {
  if (!pem || typeof pem !== 'string') return null;
  const trimmed = pem.trim().replace(/^["']|["']$/g, '');
  const formats = [
    ['-----BEGIN RSA PUBLIC KEY-----', '-----END RSA PUBLIC KEY-----'],
    ['-----BEGIN PUBLIC KEY-----', '-----END PUBLIC KEY-----'],
  ];
  for (const [begin, end] of formats) {
    const i = trimmed.indexOf(begin);
    const j = trimmed.indexOf(end);
    if (i !== -1 && j !== -1 && j > i) {
      const body64 = trimmed.slice(i + begin.length, j).trim().replace(/\s+/g, '').replace(/(.{64})/g, '$1\n').trim();
      return `${begin}\n${body64}\n${end}`;
    }
  }
  return null;
}

/**
 * encryptSessionCheck(payload, rsaPem) — yv() function.
 * Used for Session/create: random zo() key + RSA-PKCS1-V1_5.
 * Returns { encData, aesKey } or null.
 * On failure, sets encryptSessionCheck.lastError for diagnostics.
 */
function encryptSessionCheck(payload, rsaPem) {
  encryptSessionCheck.lastError = null;
  if (!payload || !rsaPem) {
    encryptSessionCheck.lastError = !rsaPem ? 'SHAMCASH_SERVER_PUBLIC_KEY is empty' : 'payload is empty';
    return null;
  }
  const pem = normalizePem(rsaPem);
  if (!pem) {
    encryptSessionCheck.lastError = 'Invalid PEM format: expected -----BEGIN RSA PUBLIC KEY----- ... -----END RSA PUBLIC KEY-----';
    return null;
  }
  let publicKey;
  try {
    publicKey = forge.pki.publicKeyFromPem(pem);
  } catch (e) {
    encryptSessionCheck.lastError = `RSA key parse failed: ${e.message}`;
    return null;
  }
  const json      = JSON.stringify(payload);
  const aesKeyStr = zo();
  const encData   = ef(json, aesKeyStr);
  if (!encData) {
    encryptSessionCheck.lastError = 'AES encryption failed';
    return null;
  }
  let aesKeyB64;
  try {
    aesKeyB64 = forge.util.encode64(publicKey.encrypt(aesKeyStr, 'RSAES-PKCS1-V1_5'));
  } catch (e) {
    encryptSessionCheck.lastError = `RSA encrypt failed: ${e.message}`;
    return null;
  }
  return { encData, aesKey: aesKeyB64 };
}

// ── Legacy forge-cookie helpers (kept for backward compatibility) ─────────────
function decryptForgeCookie(encryptedForge, aesKeyString) { return df(encryptedForge, aesKeyString); }
function encryptWithForgeKey(plaintextJson, key)          { const e = ef(plaintextJson, key); return e ? { encData: e } : null; }
function decryptWithForgeKey(encData, key)                { try { const s = df(encData, key); return s ? JSON.parse(s) : null; } catch { return null; } }

module.exports = {
  zo,
  generatePublicKeyRaw,
  ef,
  df,
  encryptForgeFormat,
  encryptBody,
  decryptResponse,
  encryptSessionCheck,
  normalizePem,
  decryptForgeCookie,
  encryptWithForgeKey,
  decryptWithForgeKey,
  FORGE_IV_LENGTH,
  GCM_TAG_LENGTH,
};
