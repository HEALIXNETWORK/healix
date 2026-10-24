const crypto = require('node:crypto');
const express = require('express');
const { db } = require('../db');
const { sendError, stringField, rateLimiter } = require('../common');
const { requireUser } = require('../auth');
const { notifyAdmins } = require('./care');

const router = express.Router();

// Only administrator-approved (published) content is visible to users.
router.get('/content', requireUser, (req, res) => {
  const category = ['relaxation', 'education'].includes(req.query.category) ? req.query.category : null;
  const content = db.prepare(`
    SELECT id, category, title, summary, body, published_at AS publishedAt
    FROM health_content WHERE status = 'published' AND (? IS NULL OR category = ?)
    ORDER BY published_at DESC LIMIT 100
  `).all(category, category);
  return res.json({ content });
});

const limitReports = rateLimiter({
  max: 10,
  windowMs: 60 * 60 * 1000,
  key: (req) => req.user.id,
  message: 'You have sent several reports recently. Please try again later.'
});

// Users can report a directory listing or an AI reply in their own conversation. For an AI reply,
// only that reply's text is shared with administrators, which the interface tells the user first.
router.post('/reports', requireUser, limitReports, (req, res) => {
  const targetType = req.body?.targetType;
  const targetId = stringField(req.body?.targetId, 1, 80);
  const reason = stringField(req.body?.reason, 1, 1000);
  if (!['doctor', 'message'].includes(targetType) || !targetId || !reason) {
    return sendError(res, 400, 'Choose what you are reporting and describe the problem in under 1,000 characters.');
  }
  let snapshot = '';
  if (targetType === 'doctor') {
    const doctor = db.prepare('SELECT user_id FROM doctor_profiles WHERE user_id = ?').get(targetId);
    if (!doctor) return sendError(res, 404, 'Doctor not found.');
  } else {
    const message = db.prepare(`
      SELECT chat_messages.content FROM chat_messages JOIN conversations ON conversations.id = chat_messages.conversation_id
      WHERE chat_messages.id = ? AND conversations.user_id = ? AND chat_messages.role = 'assistant'
    `).get(targetId, req.user.id);
    if (!message) return sendError(res, 404, 'Message not found.');
    snapshot = message.content;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO reports (id, reporter_id, target_type, target_id, reason, snapshot, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, targetType, targetId, reason, snapshot, now, now);
    notifyAdmins('report.created', 'New report submitted', `A ${targetType === 'doctor' ? 'doctor listing' : 'AI response'} was reported.`, 'admin');
  })();
  return res.status(201).json({ report: { id, status: 'open' } });
});

module.exports = { router };
