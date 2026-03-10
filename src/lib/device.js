/**
 * Generate realistic device context (userAgent, deviceName, os, browser) for QR sessions.
 * Stored with the session and with the api_key so all ShamCash requests use the same identity.
 */

const { randomBytes } = require('crypto');

const CHROME_VERSIONS = [118, 119, 120, 121, 122, 123, 124];
const SAFARI_VERSIONS = [16, 17];
const FIREFOX_VERSIONS = [115, 116, 117, 118, 119];

const DEVICE_PROFILES = [
  {
    os: 'Windows',
    osVersion: '10',
    browser: 'Chrome',
    uaTemplate: (v) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    devicePrefix: 'DESKTOP-',
    deviceSuffixLen: 7,
  },
  {
    os: 'Windows',
    osVersion: '11',
    browser: 'Chrome',
    uaTemplate: (v) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    devicePrefix: 'DESKTOP-',
    deviceSuffixLen: 7,
  },
  {
    os: 'Mac',
    osVersion: '10_15_7',
    browser: 'Chrome',
    uaTemplate: (v) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    devicePrefix: 'MacBook-',
    deviceSuffixLen: 6,
  },
  {
    os: 'Mac',
    osVersion: '13_0',
    browser: 'Safari',
    uaTemplate: (v) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${v}.0 Safari/605.1.15`,
    devicePrefix: 'MacBook-',
    deviceSuffixLen: 6,
  },
  {
    os: 'Windows',
    browser: 'Edge',
    uaTemplate: (v) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36 Edg/${v}.0.0.0`,
    devicePrefix: 'DESKTOP-',
    deviceSuffixLen: 7,
  },
  {
    os: 'Linux',
    browser: 'Chrome',
    uaTemplate: (v) =>
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
    devicePrefix: 'ubuntu-',
    deviceSuffixLen: 6,
  },
];

function randomAlnum(len) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let s = '';
  const bytes = randomBytes(len);
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}

/**
 * Returns { userAgent, deviceName, os, browser }.
 * Use for infoDevice in QR and for storing with session / api_key so ShamCash sees a consistent device.
 */
function generateDeviceContext() {
  const profile = DEVICE_PROFILES[Math.floor(Math.random() * DEVICE_PROFILES.length)];
  const version =
    profile.browser === 'Chrome' || profile.browser === 'Edge'
      ? CHROME_VERSIONS[Math.floor(Math.random() * CHROME_VERSIONS.length)]
      : profile.browser === 'Safari'
        ? SAFARI_VERSIONS[Math.floor(Math.random() * SAFARI_VERSIONS.length)]
        : CHROME_VERSIONS[0];
  const userAgent = profile.uaTemplate(version);
  const deviceName =
    profile.devicePrefix + randomAlnum(profile.deviceSuffixLen);
  return {
    userAgent,
    deviceName,
    os: profile.os,
    browser: profile.browser,
  };
}

module.exports = { generateDeviceContext };
