const express = require('express');
const { db } = require('../db');
const { sendError } = require('../common');
const { requireUser } = require('../auth');

const router = express.Router();

router.get('/', requireUser, (req, res) => {
  const notifications = db.prepare(`
    SELECT id, type, title, body, screen, read_at AS readAt, created_at AS createdAt
    FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL').get(req.user.id).total;
  return res.json({ notifications, unread });
});

router.post('/read-all', requireUser, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(new Date().toISOString(), req.user.id);
  return res.json({ ok: true });
});

router.post('/:id/read', requireUser, (req, res) => {
  const result = db.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?')
    .run(new Date().toISOString(), req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Notification not found.');
  return res.json({ ok: true });
});

router.delete('/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Notification not found.');
  return res.json({ ok: true });
});

module.exports = { router };
