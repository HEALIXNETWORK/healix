const crypto = require('node:crypto');
const { db } = require('./db');

function sendError(res, status, message) {
  return res.status(status).json({ error: message });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function stringField(value, min, max) {
  return typeof value === 'string' && value.trim().length >= min && value.trim().length <= max
    ? value.trim()
    : null;
}

function optionalString(value, max) {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : null;
}

// In-memory sliding-window limiter. Suitable for the single-instance deployment this app targets.
function rateLimiter({ max, windowMs, key, message }) {
  const attempts = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const id = key(req);
    const recent = (attempts.get(id) || []).filter((time) => now - time < windowMs);
    if (recent.length >= max) return sendError(res, 429, message);
    recent.push(now);
    attempts.set(id, recent);
    if (attempts.size > 10000) {
      for (const [entry, times] of attempts) {
        if (!times.some((time) => now - time < windowMs)) attempts.delete(entry);
      }
    }
    return next();
  };
}

// Audit entries record who did what to which record. Never put health content in `details`.
function audit(req, action, targetType = null, targetId = null, details = {}) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_user_id, action, target_type, target_id, details, ip_address, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), req?.user?.id || null, action, targetType, targetId, JSON.stringify(details), req?.ip || null, new Date().toISOString());
}

function notify(userId, type, title, body = '', screen = null) {
  db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body, screen, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), userId, type, title.slice(0, 160), body.slice(0, 1000), screen, new Date().toISOString());
}

function getSetting(key) {
  return db.prepare('SELECT value FROM system_settings WHERE key = ?').get(key)?.value ?? null;
}

module.exports = { sendError, asyncRoute, stringField, optionalString, rateLimiter, audit, notify, getSetting };
