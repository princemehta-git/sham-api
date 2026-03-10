/**
 * Sessions management routes.
 * GET  /sessions         - list all active API keys (sessions)
 * DELETE /sessions/:key  - revoke an API key
 */

const store = require('../lib/store');

/**
 * GET /sessions
 * Returns all stored API keys with metadata (no secrets exposed).
 */
async function list(req, res) {
  try {
    const keys = await store.listApiKeys();
    res.json({
      success: true,
      count: keys.length,
      sessions: keys.map(k => ({
        apiKey: k.apiKey,
        email: k.email || null,
        label: k.label || null,
        sessionId: k.sessionId ? k.sessionId.substring(0, 30) + '...' : null,
        createdAt: k.createdAt,
        createdAtHuman: k.createdAt ? new Date(k.createdAt).toISOString() : null,
        infoDevice: k.infoDevice || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/**
 * DELETE /sessions/:key
 * Revoke an API key (removes from DB; does NOT call ShamCash logout).
 */
async function revoke(req, res) {
  const apiKey = req.params.key;
  if (!apiKey) return res.status(400).json({ error: 'API key required' });
  try {
    const deleted = await store.deleteApiKey(apiKey);
    if (!deleted) return res.status(404).json({ error: 'API key not found' });
    res.json({ success: true, message: 'Session revoked' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

module.exports = { list, revoke };
