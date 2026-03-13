/**
 * Runtime proxy settings. SHAMCASH_PROXY_ONLY from env, overridable via API.
 */
let proxyOnlyOverride = null;

function getProxyOnly() {
  if (proxyOnlyOverride !== null) return proxyOnlyOverride;
  return process.env.SHAMCASH_PROXY_ONLY === 'true';
}

function setProxyOnly(value) {
  proxyOnlyOverride = value === true;
}

module.exports = { getProxyOnly, setProxyOnly };
