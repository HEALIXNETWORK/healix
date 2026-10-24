require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { db } = require('./db');
const { sendError, asyncRoute, stringField, rateLimiter, audit, getSetting } = require('./common');
const {
  COOKIE_SECURE,
  hashPassword,
  verifyPassword,
  hashToken,
  requestToken,
  clearSessionCookie,
  issueSession,
  rolesFor,
  doctorStatusFor,
  requireUser
} = require('./auth');
const { aiCapabilities, generateReply, AiError } = require('./ai');
const attachments = require('./routes/attachments');
const care = require('./routes/care');
const admin = require('./routes/admin');
const notifications = require('./routes/notifications');
const content = require('./routes/content');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const publicPath = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (!res.getHeader('Content-Security-Policy')) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  }
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return next();
});
// Defense in depth alongside SameSite=Strict cookies: reject state-changing API calls from other origins.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || !req.headers.origin) return next();
  let originHost = null;
  try {
    originHost = new URL(req.headers.origin).host;
  } catch {
    originHost = null;
  }
  if (originHost !== req.headers.host) return sendError(res, 403, 'Cross-site requests are not allowed.');
  return next();
});
app.use(express.json({ limit: '32kb' }));
app.use(express.static(publicPath, { index: 'index.html', maxAge: '1h' }));

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const ai = aiCapabilities();
  return res.json({
    aiConfigured: ai.configured,
    aiImages: ai.images,
    aiDocuments: ai.documents,
    attachmentMaxBytes: attachments.MAX_BYTES,
    registrationOpen: getSetting('registration_open') !== 'false',
    doctorRegistrationOpen: getSetting('doctor_registration_open') !== 'false',
    announcement: getSetting('announcement') || '',
    departments: care.DEPARTMENTS
  });
});

const limitAuthAttempts = rateLimiter({
  max: Number(process.env.AUTH_RATE_LIMIT_MAX) || 20,
  windowMs: 15 * 60 * 1000,
  key: (req) => req.ip,
  message: 'Too many sign-in attempts. Please wait and try again.'
});

function profileFor(userId) {
  const profile = db.prepare('SELECT preferences FROM user_profiles WHERE user_id = ?').get(userId);
  const settings = db.prepare('SELECT preferences, notification_settings FROM user_settings WHERE user_id = ?').get(userId);
  return {
    profile: JSON.parse(profile?.preferences || '{}'),
    settings: JSON.parse(settings?.preferences || '{"speechEnabled":false,"hydrationGoalMl":0}'),
    notifications: JSON.parse(settings?.notification_settings || '{}')
  };
}

function sessionPayload(user) {
  return {
    user: { id: user.id, name: user.name, email: user.email, roles: rolesFor(user.id) },
    doctorStatus: doctorStatusFor(user.id),
    unreadNotifications: db.prepare('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL').get(user.id).total,
    ...profileFor(user.id)
  };
}

app.post('/api/auth/register', limitAuthAttempts, asyncRoute(async (req, res) => {
  const name = stringField(req.body?.name, 2, 80);
  const email = stringField(req.body?.email, 5, 254)?.toLowerCase();
  const password = req.body?.password;
  const accountType = req.body?.accountType ?? 'patient';
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendError(res, 400, 'Enter a name and a valid email address.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return sendError(res, 400, 'Use a password between 12 and 128 characters.');
  }
  // Administrator accounts cannot be self-registered; see scripts/grant-role.js.
  if (!['patient', 'doctor'].includes(accountType)) return sendError(res, 400, 'Choose a personal or doctor account.');
  if (getSetting('registration_open') === 'false') return sendError(res, 403, 'New registrations are temporarily closed.');
  if (accountType === 'doctor' && getSetting('doctor_registration_open') === 'false') {
    return sendError(res, 403, 'Doctor registrations are temporarily closed.');
  }

  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  try {
    const createUser = db.transaction(() => {
      db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, name, email, passwordHash, now);
      db.prepare('INSERT INTO user_profiles (user_id, preferences, updated_at) VALUES (?, ?, ?)')
        .run(userId, '{}', now);
      db.prepare('INSERT INTO user_settings (user_id, preferences, notification_settings, updated_at) VALUES (?, ?, ?, ?)')
        .run(userId, JSON.stringify({ speechEnabled: false, hydrationGoalMl: 0 }), '{}', now);
      db.prepare("INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'patient', ?)").run(userId, now);
      if (accountType === 'doctor') {
        // Selecting "doctor" grants only the unverified doctor workspace; verification is an administrator decision.
        db.prepare("INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'doctor', ?)").run(userId, now);
        db.prepare('INSERT INTO doctor_profiles (user_id, created_at, updated_at) VALUES (?, ?, ?)').run(userId, now, now);
      }
      audit({ ip: req.ip, user: { id: userId } }, 'auth.registered', 'user', userId, { accountType });
    });
    createUser();
    issueSession(userId, res);
    return res.status(201).json(sessionPayload({ id: userId, name, email }));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return sendError(res, 409, 'An account with that email already exists.');
    throw error;
  }
}));

app.post('/api/auth/login', limitAuthAttempts, asyncRoute(async (req, res) => {
  const email = stringField(req.body?.email, 5, 254)?.toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== 'string' || password.length > 128) {
    return sendError(res, 400, 'Enter your email address and password.');
  }
  const user = db.prepare('SELECT id, name, email, password_hash, status FROM users WHERE email = ?').get(email);
  const valid = user ? await verifyPassword(password, user.password_hash) : false;
  if (!valid) {
    if (user) audit({ ip: req.ip }, 'auth.login_failed', 'user', user.id);
    return sendError(res, 401, 'Email or password is incorrect.');
  }
  if (user.status !== 'active') {
    return sendError(res, 403, 'This account is suspended. Contact the HEALIX administrator if you believe this is a mistake.');
  }
  issueSession(user.id, res);
  audit({ ip: req.ip, user }, 'auth.login', 'user', user.id);
  return res.json(sessionPayload(user));
}));

app.post('/api/auth/logout', (req, res) => {
  const token = requestToken(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get('/api/session', requireUser, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json(sessionPayload(req.user));
});

app.put('/api/profile', requireUser, (req, res) => {
  const name = stringField(req.body?.name, 2, 80);
  if (!name) return sendError(res, 400, 'Name must be between 2 and 80 characters.');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  return res.json({ user: { ...req.user, name } });
});

app.post('/api/account/password', requireUser, limitAuthAttempts, asyncRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || currentPassword.length > 128) return sendError(res, 400, 'Enter your current password.');
  if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 128) {
    return sendError(res, 400, 'Use a new password between 12 and 128 characters.');
  }
  const stored = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id).password_hash;
  if (!(await verifyPassword(currentPassword, stored))) return sendError(res, 401, 'Your current password is incorrect.');
  const passwordHash = await hashPassword(newPassword);
  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionTokenHash);
    audit(req, 'auth.password_changed', 'user', req.user.id);
  })();
  return res.json({ ok: true });
}));

app.post('/api/account/sessions/revoke-others', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(req.user.id, req.sessionTokenHash);
  audit(req, 'auth.sessions_revoked', 'user', req.user.id, { count: result.changes });
  return res.json({ ok: true, revoked: result.changes });
});

app.put('/api/settings', requireUser, (req, res) => {
  const speechEnabled = req.body?.speechEnabled;
  const hydrationGoalMl = req.body?.hydrationGoalMl;
  if (typeof speechEnabled !== 'boolean' || !Number.isInteger(hydrationGoalMl) || hydrationGoalMl < 0 || hydrationGoalMl > 10000) {
    return sendError(res, 400, 'Choose a valid voice response preference and a daily goal from 0 to 10,000 ml.');
  }
  const settings = { ...profileFor(req.user.id).settings, speechEnabled, hydrationGoalMl };
  saveSettings(req.user.id, settings);
  return res.json({ settings });
});

function saveSettings(userId, settings) {
  db.prepare(`
    INSERT INTO user_settings (user_id, preferences, notification_settings, updated_at)
    VALUES (?, ?, '{}', ?)
    ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at
  `).run(userId, JSON.stringify(settings), new Date().toISOString());
}

// Consent to send messages to the external AI provider is recorded once per account and can be withdrawn.
app.put('/api/settings/ai-consent', requireUser, (req, res) => {
  const consent = req.body?.consent;
  if (typeof consent !== 'boolean') return sendError(res, 400, 'Choose whether to share messages with the AI provider.');
  const settings = { ...profileFor(req.user.id).settings, aiConsent: consent };
  db.transaction(() => {
    saveSettings(req.user.id, settings);
    audit(req, consent ? 'privacy.ai_consent_given' : 'privacy.ai_consent_withdrawn', 'user', req.user.id);
  })();
  return res.json({ settings });
});

function attachmentsForMessage(messageId) {
  return db.prepare(`
    SELECT id, original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes
    FROM attachments WHERE message_id = ? ORDER BY created_at
  `).all(messageId);
}

app.get('/api/account/export', requireUser, (req, res) => {
  const conversations = db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE user_id = ? ORDER BY created_at
  `).all(req.user.id).map((conversation) => ({
    ...conversation,
    messages: db.prepare(`
      SELECT id, role, content, feedback, created_at AS createdAt FROM chat_messages
      WHERE conversation_id = ? ORDER BY created_at
    `).all(conversation.id).map(({ id, ...message }) => ({ ...message, attachments: attachmentsForMessage(id) }))
  }));
  const data = {
    exportedAt: new Date().toISOString(),
    user: req.user,
    ...profileFor(req.user.id),
    conversations,
    hydration: db.prepare(`
      SELECT amount_ml AS amountMl, recorded_at AS recordedAt FROM hydration_records
      WHERE user_id = ? ORDER BY recorded_at
    `).all(req.user.id),
    appointments: db.prepare(`
      SELECT title, scheduled_at AS scheduledAt, notes, created_at AS createdAt
      FROM appointments WHERE user_id = ? ORDER BY scheduled_at
    `).all(req.user.id),
    consultations: db.prepare(`
      SELECT consultations.reason, consultations.preferred_time AS preferredTime, consultations.status,
        consultations.scheduled_at AS scheduledAt, consultations.doctor_note AS doctorNote,
        consultations.created_at AS createdAt, users.name AS doctorName
      FROM consultations JOIN users ON users.id = consultations.doctor_id
      WHERE consultations.patient_id = ? ORDER BY consultations.created_at
    `).all(req.user.id),
    attachments: db.prepare(`
      SELECT original_name AS name, mime_type AS mimeType, size_bytes AS sizeBytes, purpose, created_at AS createdAt
      FROM attachments WHERE user_id = ? ORDER BY created_at
    `).all(req.user.id),
    notifications: db.prepare(`
      SELECT title, body, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at
    `).all(req.user.id),
    doctorProfile: req.user.roles.includes('doctor')
      ? db.prepare('SELECT * FROM doctor_profiles WHERE user_id = ?').get(req.user.id)
      : null
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="healix-data-export.json"');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(JSON.stringify(data, null, 2));
});

app.delete('/api/account', requireUser, (req, res) => {
  if (req.user.roles.includes('admin')) {
    const admins = db.prepare("SELECT COUNT(*) AS total FROM user_roles JOIN users ON users.id = user_roles.user_id WHERE role_id = 'admin' AND users.status = 'active'").get().total;
    if (admins <= 1) return sendError(res, 409, 'Grant another administrator before deleting the only administrator account.');
  }
  db.transaction(() => {
    audit(req, 'account.deleted', 'user', req.user.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  })();
  attachments.removeUserFiles(req.user.id);
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get('/api/hydration', requireUser, (req, res) => {
  const day = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
    ? req.query.date
    : new Date().toISOString().slice(0, 10);
  const timezoneOffset = req.query.timezoneOffset === undefined ? 0 : Number(req.query.timezoneOffset);
  const utcMidnight = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(utcMidnight.getTime()) || !Number.isInteger(timezoneOffset) || timezoneOffset < -840 || timezoneOffset > 840) {
    return sendError(res, 400, 'Choose a valid date and time zone.');
  }
  if (utcMidnight.toISOString().slice(0, 10) !== day) {
    return sendError(res, 400, 'Choose a valid date and time zone.');
  }
  const start = new Date(utcMidnight.getTime() + timezoneOffset * 60000).toISOString();
  const end = new Date(new Date(start).getTime() + 86400000).toISOString();
  const records = db.prepare(`
    SELECT id, amount_ml AS amountMl, recorded_at AS recordedAt
    FROM hydration_records WHERE user_id = ? AND recorded_at >= ? AND recorded_at < ?
    ORDER BY recorded_at DESC
  `).all(req.user.id, start, end);
  return res.json({ date: day, records, totalMl: records.reduce((sum, record) => sum + record.amountMl, 0) });
});

app.post('/api/hydration', requireUser, (req, res) => {
  const amountMl = req.body?.amountMl;
  if (!Number.isInteger(amountMl) || amountMl < 1 || amountMl > 5000) {
    return sendError(res, 400, 'Water amount must be between 1 and 5,000 ml.');
  }
  const record = { id: crypto.randomUUID(), amountMl, recordedAt: new Date().toISOString() };
  db.prepare('INSERT INTO hydration_records (id, user_id, amount_ml, recorded_at) VALUES (?, ?, ?, ?)')
    .run(record.id, req.user.id, record.amountMl, record.recordedAt);
  return res.status(201).json({ record });
});

app.delete('/api/hydration/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM hydration_records WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Water record not found.');
  return res.json({ ok: true });
});

app.get('/api/conversations', requireUser, (req, res) => {
  const conversations = db.prepare(`
    SELECT conversations.id, conversations.title, conversations.created_at AS createdAt,
      conversations.updated_at AS updatedAt,
      (SELECT content FROM chat_messages WHERE conversation_id = conversations.id ORDER BY created_at DESC LIMIT 1) AS preview
    FROM conversations WHERE user_id = ? ORDER BY updated_at DESC
  `).all(req.user.id);
  return res.json({ conversations });
});

app.post('/api/conversations', requireUser, (req, res) => {
  const now = new Date().toISOString();
  const conversation = { id: crypto.randomUUID(), title: 'New conversation', createdAt: now, updatedAt: now, preview: null };
  db.prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(conversation.id, req.user.id, conversation.title, now, now);
  return res.status(201).json({ conversation });
});

app.get('/api/conversations/:id/messages', requireUser, (req, res) => {
  const owned = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!owned) return sendError(res, 404, 'Conversation not found.');
  const messages = db.prepare(`
    SELECT id, role, content, feedback, created_at AS createdAt FROM chat_messages
    WHERE conversation_id = ? ORDER BY created_at
  `).all(req.params.id).map((message) => ({ ...message, attachments: attachmentsForMessage(message.id) }));
  return res.json({ messages });
});

app.delete('/api/conversations/:id', requireUser, (req, res) => {
  const storageKeys = db.prepare(`
    SELECT attachments.storage_key FROM attachments
      JOIN chat_messages ON chat_messages.id = attachments.message_id
      JOIN conversations ON conversations.id = chat_messages.conversation_id
    WHERE conversations.id = ? AND conversations.user_id = ?
  `).all(req.params.id, req.user.id).map((row) => row.storage_key);
  const result = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    if (deleted.changes) {
      db.prepare("DELETE FROM shared_patient_records WHERE record_type = 'conversation' AND record_id = ? AND patient_id = ?")
        .run(req.params.id, req.user.id);
    }
    return deleted;
  })();
  if (!result.changes) return sendError(res, 404, 'Conversation not found.');
  attachments.removeStoredFiles(storageKeys);
  return res.json({ ok: true });
});

app.put('/api/messages/:id/feedback', requireUser, (req, res) => {
  const feedback = req.body?.feedback ?? null;
  if (feedback !== null && !['helpful', 'not_helpful'].includes(feedback)) return sendError(res, 400, 'Choose helpful or not helpful.');
  const result = db.prepare(`
    UPDATE chat_messages SET feedback = ?
    WHERE id = ? AND role = 'assistant'
      AND conversation_id IN (SELECT id FROM conversations WHERE user_id = ?)
  `).run(feedback, req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Message not found.');
  return res.json({ ok: true, feedback });
});

function appointmentFromBody(body) {
  const title = stringField(body?.title, 1, 120);
  const scheduledAt = typeof body?.scheduledAt === 'string' ? new Date(body.scheduledAt) : null;
  const notes = typeof body?.notes === 'string' ? body.notes.trim() : '';
  if (!title || !scheduledAt || Number.isNaN(scheduledAt.getTime()) || notes.length > 2000) return null;
  return { title, scheduledAt: scheduledAt.toISOString(), notes };
}

app.get('/api/appointments', requireUser, (req, res) => {
  const appointments = db.prepare(`
    SELECT id, title, scheduled_at AS scheduledAt, notes, created_at AS createdAt, updated_at AS updatedAt
    FROM appointments WHERE user_id = ? ORDER BY scheduled_at
  `).all(req.user.id);
  return res.json({ appointments });
});

app.post('/api/appointments', requireUser, (req, res) => {
  const appointment = appointmentFromBody(req.body);
  if (!appointment) return sendError(res, 400, 'Enter an appointment title, a valid date and time, and notes under 2,000 characters.');
  const now = new Date().toISOString();
  const created = { id: crypto.randomUUID(), ...appointment, createdAt: now, updatedAt: now };
  db.prepare(`
    INSERT INTO appointments (id, user_id, title, scheduled_at, notes, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(created.id, req.user.id, created.title, created.scheduledAt, created.notes, now, now);
  return res.status(201).json({ appointment: created });
});

app.put('/api/appointments/:id', requireUser, (req, res) => {
  const appointment = appointmentFromBody(req.body);
  if (!appointment) return sendError(res, 400, 'Enter an appointment title, a valid date and time, and notes under 2,000 characters.');
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE appointments SET title = ?, scheduled_at = ?, notes = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(appointment.title, appointment.scheduledAt, appointment.notes, now, req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Appointment not found.');
  return res.json({ appointment: { id: req.params.id, ...appointment, updatedAt: now } });
});

app.delete('/api/appointments/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM appointments WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Appointment not found.');
  return res.json({ ok: true });
});

const limitChatRequests = rateLimiter({
  max: 15,
  windowMs: 60 * 1000,
  key: (req) => req.user.id,
  message: 'Please wait a moment before sending another message.'
});
const MAX_MESSAGE_ATTACHMENTS = 4;

app.post('/api/conversations/:id/messages', requireUser, limitChatRequests, asyncRoute(async (req, res) => {
  const conversation = db.prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conversation) return sendError(res, 404, 'Conversation not found.');

  const content = stringField(req.body?.content, 1, 12000);
  const clientRequestId = stringField(req.body?.clientRequestId, 1, 80);
  const attachmentIds = req.body?.attachmentIds ?? [];
  if (!content || !clientRequestId) return sendError(res, 400, 'Enter a message and a valid request identifier.');
  if (!Array.isArray(attachmentIds) || attachmentIds.length > MAX_MESSAGE_ATTACHMENTS
    || attachmentIds.some((id) => typeof id !== 'string') || new Set(attachmentIds).size !== attachmentIds.length) {
    return sendError(res, 400, `Attach up to ${MAX_MESSAGE_ATTACHMENTS} files per message.`);
  }
  if (profileFor(req.user.id).settings.aiConsent !== true) {
    return sendError(res, 403, 'Please agree to share your messages with the AI provider before chatting.');
  }
  const capabilities = aiCapabilities();
  if (!capabilities.configured) {
    return sendError(res, 503, 'AI chat is not configured yet. Set AI_API_KEY on the server, then restart HEALIX.');
  }

  const existing = db.prepare(`
    SELECT id, content FROM chat_messages
    WHERE conversation_id = ? AND client_request_id = ? AND role = 'user'
  `).get(conversation.id, clientRequestId);
  if (existing && existing.content !== content) {
    return sendError(res, 409, 'This message identifier has already been used for different content.');
  }

  const files = attachmentIds.map((id) => db.prepare(`
    SELECT * FROM attachments
    WHERE id = ? AND user_id = ? AND purpose = 'chat' AND (message_id IS NULL OR message_id = ?)
  `).get(id, req.user.id, existing?.id ?? null));
  if (files.some((file) => !file)) {
    return sendError(res, 400, 'One or more attachments are no longer available. Remove them and attach again.');
  }
  if (files.some((file) => file.mime_type.startsWith('image/')) && !capabilities.images) {
    return sendError(res, 422, 'Image understanding is not enabled for the configured AI provider, so images cannot be analyzed. Describe what you see in text instead.');
  }
  if (files.some((file) => file.mime_type === 'application/pdf') && !capabilities.documents) {
    return sendError(res, 422, 'PDF reading is not enabled for the configured AI provider. Type the relevant values or terms into your message instead.');
  }

  const now = new Date().toISOString();
  let userMessageId = existing?.id;
  if (!existing) {
    userMessageId = crypto.randomUUID();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO chat_messages (id, conversation_id, role, content, client_request_id, created_at)
        VALUES (?, ?, 'user', ?, ?, ?)
      `).run(userMessageId, conversation.id, content, clientRequestId, now);
      for (const file of files) db.prepare('UPDATE attachments SET message_id = ? WHERE id = ?').run(userMessageId, file.id);
      const count = db.prepare('SELECT COUNT(*) AS total FROM chat_messages WHERE conversation_id = ?').get(conversation.id).total;
      const title = count === 1 ? content.slice(0, 64) : conversation.title;
      db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
        .run(title, now, conversation.id, req.user.id);
    })();
  }

  // Only the newest message's files are sent to the provider; earlier files are referenced by name.
  const history = db.prepare(`
    SELECT id, role, content FROM chat_messages WHERE conversation_id = ?
    ORDER BY created_at DESC LIMIT 21
  `).all(conversation.id).reverse().map((message) => {
    const linked = db.prepare('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at').all(message.id);
    if (!linked.length) return { role: message.role, content: message.content };
    if (message.id === userMessageId) {
      return {
        role: message.role,
        content: message.content,
        attachments: linked.map((file) => ({ name: file.original_name, mimeType: file.mime_type, data: attachments.readAttachment(file) }))
      };
    }
    const names = linked.map((file) => file.original_name).join(', ');
    return { role: message.role, content: `${message.content}\n\n[Earlier attachment(s), not re-sent: ${names}]` };
  });

  let reply;
  try {
    reply = await generateReply(history);
  } catch (error) {
    if (error instanceof AiError) return sendError(res, error.status, error.message);
    throw error;
  }
  const responseTime = new Date().toISOString();
  const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: reply, feedback: null, attachments: [], createdAt: responseTime };
  db.prepare(`
    INSERT INTO chat_messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(assistantMessage.id, conversation.id, assistantMessage.role, assistantMessage.content, responseTime);
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
    .run(responseTime, conversation.id, req.user.id);
  return res.json({ message: assistantMessage, userMessageId });
}));

app.use('/api/attachments', attachments.router);
app.use('/api/notifications', notifications.router);
app.use('/api/admin', admin.router);
app.use('/api', care.router);
app.use('/api', content.router);

app.use('/api', (req, res) => sendError(res, 404, 'API endpoint not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'Request body must be valid JSON.');
  }
  if (error.type === 'entity.too.large') {
    return sendError(res, 413, 'That file or request is too large.');
  }
  console.error('Request failed:', error.message);
  return sendError(res, 500, 'Something went wrong. Please try again.');
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`HEALIX is available at http://localhost:${PORT}`);
  });
}

module.exports = { app };
