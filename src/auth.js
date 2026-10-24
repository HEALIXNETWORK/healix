const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { db } = require('./db');
const { sendError } = require('./common');

const scrypt = promisify(crypto.scrypt);
const SESSION_DAYS = 14;
const COOKIE_NAME = 'healix_session';
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const passwordHash = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${passwordHash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, hashHex] = stored.split(':');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requestToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
  return match ? match.slice(COOKIE_NAME.length + 1) : null;
}

function setSessionCookie(res, token) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
}

function clearSessionCookie(res) {
  const secure = COOKIE_SECURE ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
}

function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(hashToken(token), userId, expiresAt, now.toISOString());
  setSessionCookie(res, token);
}

function rolesFor(userId) {
  return db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id').all(userId).map((row) => row.role_id);
}

function doctorStatusFor(userId) {
  return db.prepare('SELECT verification_status FROM doctor_profiles WHERE user_id = ?').get(userId)?.verification_status || null;
}

// Roles and account status are re-read from the database on every request, so suspensions
// and verification changes take effect immediately rather than at the next sign-in.
function requireUser(req, res, next) {
  const token = requestToken(req);
  if (!token) return sendError(res, 401, 'Please sign in to continue.');

  const tokenHash = hashToken(token);
  const session = db.prepare(`
    SELECT users.id, users.name, users.email, users.status
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  if (!session) return sendError(res, 401, 'Your session has expired. Please sign in again.');
  if (session.status !== 'active') {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(session.id);
    clearSessionCookie(res);
    return sendError(res, 403, 'This account is suspended. Contact the HEALIX administrator if you believe this is a mistake.');
  }

  req.user = { id: session.id, name: session.name, email: session.email, roles: rolesFor(session.id) };
  req.sessionTokenHash = tokenHash;
  return next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user?.roles.includes(role)) return sendError(res, 403, 'You do not have permission to do that.');
    return next();
  };
}

function requireVerifiedDoctor(req, res, next) {
  if (!req.user?.roles.includes('doctor')) return sendError(res, 403, 'This area is for doctor accounts.');
  if (doctorStatusFor(req.user.id) !== 'verified') {
    return sendError(res, 403, 'This feature is available after your professional credentials are verified.');
  }
  return next();
}

module.exports = {
  COOKIE_SECURE,
  hashToken,
  hashPassword,
  verifyPassword,
  requestToken,
  clearSessionCookie,
  issueSession,
  rolesFor,
  doctorStatusFor,
  requireUser,
  requireRole,
  requireVerifiedDoctor
};
