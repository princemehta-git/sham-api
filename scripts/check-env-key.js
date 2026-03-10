#!/usr/bin/env node
/**
 * Run on the server to verify SHAMCASH_SERVER_PUBLIC_KEY is loaded correctly.
 * Usage: node scripts/check-env-key.js
 * Or from project root: node scripts/check-env-key.js
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const k = process.env.SHAMCASH_SERVER_PUBLIC_KEY;
console.log('Has key:', !!k);
console.log('Length:', k ? k.length : 0);
console.log('Starts with BEGIN:', k ? k.includes('-----BEGIN') : false);
console.log('Ends with END:', k ? k.includes('-----END') : false);
console.log('First 60 chars:', k ? JSON.stringify(k.slice(0, 60)) : 'N/A');
console.log('Last 40 chars:', k ? JSON.stringify(k.slice(-40)) : 'N/A');

if (k) {
  try {
    const crypto = require('../src/lib/crypto');
    const r = crypto.encryptSessionCheck({ accessToken: '', sessionId: 'test' }, k);
    console.log('encryptSessionCheck:', r ? 'OK' : 'FAIL', r ? '' : crypto.encryptSessionCheck.lastError);
  } catch (e) {
    console.log('Error:', e.message);
  }
}
