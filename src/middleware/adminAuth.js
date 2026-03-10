/**
 * Admin authentication middleware using JWT (2-hour expiry).
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'shamcash-admin-secret-change-me';
const JWT_EXPIRY = '2h';

function generateToken(username) {
  return jwt.sign({ username, role: 'admin' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

/**
 * Middleware: require admin JWT in Authorization header or cookie.
 */
function requireAdmin(req, res, next) {
  const token = req.cookies?.admin_token
    || req.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.admin = decoded;
  next();
}

module.exports = { generateToken, verifyToken, requireAdmin };
