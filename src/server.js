require('dotenv').config();

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { promisify } = require('node:util');
const { db } = require('./db');

const app = express();
const scrypt = promisify(crypto.scrypt);
const PORT = Number(process.env.PORT) || 3000;
const SESSION_DAYS = 14;
const COOKIE_NAME = 'healix_session';
const COOKIE_SECURE = process.env.SESSION_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
const publicPath = path.join(__dirname, '..', 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
  if (COOKIE_SECURE) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return next();
});
app.use(express.static(publicPath, { index: 'index.html', maxAge: '1h' }));

app.get('/api/config', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ aiConfigured: Boolean(process.env.AI_API_KEY) });
});

const authAttempts = new Map();
function limitAuthAttempts(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const recent = (authAttempts.get(key) || []).filter((time) => now - time < 15 * 60 * 1000);
  if (recent.length >= 20) {
    return res.status(429).json({ error: 'Too many sign-in attempts. Please wait and try again.' });
  }
  recent.push(now);
  authAttempts.set(key, recent);
  return next();
}

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

function requireUser(req, res, next) {
  const token = requestToken(req);
  if (!token) return sendError(res, 401, 'Please sign in to continue.');

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const session = db.prepare(`
    SELECT users.id, users.name, users.email
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).get(tokenHash, new Date().toISOString());
  if (!session) return sendError(res, 401, 'Your session has expired. Please sign in again.');

  req.user = session;
  req.sessionTokenHash = tokenHash;
  return next();
}

function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
    .run(crypto.createHash('sha256').update(token).digest('hex'), userId, expiresAt, now.toISOString());
  setSessionCookie(res, token);
}

function profileFor(userId) {
  const profile = db.prepare('SELECT preferences FROM user_profiles WHERE user_id = ?').get(userId);
  const settings = db.prepare('SELECT preferences, notification_settings FROM user_settings WHERE user_id = ?').get(userId);
  return {
    profile: JSON.parse(profile?.preferences || '{}'),
    settings: JSON.parse(settings?.preferences || '{"speechEnabled":false,"hydrationGoalMl":0}'),
    notifications: JSON.parse(settings?.notification_settings || '{}')
  };
}

app.post('/api/auth/register', limitAuthAttempts, asyncRoute(async (req, res) => {
  const name = stringField(req.body?.name, 2, 80);
  const email = stringField(req.body?.email, 5, 254)?.toLowerCase();
  const password = req.body?.password;
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return sendError(res, 400, 'Enter a name and a valid email address.');
  }
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return sendError(res, 400, 'Use a password between 12 and 128 characters.');
  }

  const salt = crypto.randomBytes(16);
  const passwordHash = await scrypt(password, salt, 64);
  const now = new Date().toISOString();
  const userId = crypto.randomUUID();
  try {
    const createUser = db.transaction(() => {
      db.prepare('INSERT INTO users (id, name, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, name, email, `${salt.toString('hex')}:${passwordHash.toString('hex')}`, now);
      db.prepare('INSERT INTO user_profiles (user_id, preferences, updated_at) VALUES (?, ?, ?)')
        .run(userId, '{}', now);
      db.prepare('INSERT INTO user_settings (user_id, preferences, notification_settings, updated_at) VALUES (?, ?, ?, ?)')
        .run(userId, JSON.stringify({ speechEnabled: false, hydrationGoalMl: 0 }), '{}', now);
    });
    createUser();
    issueSession(userId, res);
    return res.status(201).json({ user: { id: userId, name, email }, ...profileFor(userId) });
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
  const user = db.prepare('SELECT id, name, email, password_hash FROM users WHERE email = ?').get(email);
  let valid = false;
  if (user) {
    const [saltHex, hashHex] = user.password_hash.split(':');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
    valid = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  if (!valid) return sendError(res, 401, 'Email or password is incorrect.');
  issueSession(user.id, res);
  return res.json({ user: { id: user.id, name: user.name, email: user.email }, ...profileFor(user.id) });
}));

app.post('/api/auth/logout', (req, res) => {
  const token = requestToken(req);
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

app.get('/api/session', requireUser, (req, res) => {
  return res.json({ user: req.user, ...profileFor(req.user.id) });
});

app.put('/api/profile', requireUser, (req, res) => {
  const name = stringField(req.body?.name, 2, 80);
  if (!name) return sendError(res, 400, 'Name must be between 2 and 80 characters.');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  return res.json({ user: { ...req.user, name } });
});

app.put('/api/settings', requireUser, (req, res) => {
  const speechEnabled = req.body?.speechEnabled;
  const hydrationGoalMl = req.body?.hydrationGoalMl;
  if (typeof speechEnabled !== 'boolean' || !Number.isInteger(hydrationGoalMl) || hydrationGoalMl < 0 || hydrationGoalMl > 10000) {
    return sendError(res, 400, 'Choose a valid voice response preference and a daily goal from 0 to 10,000 ml.');
  }
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO user_settings (user_id, preferences, notification_settings, updated_at)
    VALUES (?, ?, '{}', ?)
    ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at
  `).run(req.user.id, JSON.stringify({ speechEnabled, hydrationGoalMl }), now);
  return res.json({ settings: { speechEnabled, hydrationGoalMl } });
});

app.get('/api/account/export', requireUser, (req, res) => {
  const conversations = db.prepare(`
    SELECT id, title, created_at AS createdAt, updated_at AS updatedAt
    FROM conversations WHERE user_id = ? ORDER BY created_at
  `).all(req.user.id).map((conversation) => ({
    ...conversation,
    messages: db.prepare(`
      SELECT role, content, created_at AS createdAt FROM chat_messages
      WHERE conversation_id = ? ORDER BY created_at
    `).all(conversation.id)
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
    `).all(req.user.id)
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="healix-data-export.json"');
  res.setHeader('Cache-Control', 'no-store');
  return res.send(JSON.stringify(data, null, 2));
});

app.delete('/api/account', requireUser, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
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
    SELECT id, role, content, created_at AS createdAt FROM chat_messages
    WHERE conversation_id = ? ORDER BY created_at
  `).all(req.params.id);
  return res.json({ messages });
});

app.delete('/api/conversations/:id', requireUser, (req, res) => {
  const result = db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Conversation not found.');
  return res.json({ ok: true });
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

const chatAttempts = new Map();
function limitChatRequests(req, res, next) {
  const now = Date.now();
  const key = req.user.id;
  const recent = (chatAttempts.get(key) || []).filter((time) => now - time < 60 * 1000);
  if (recent.length >= 15) return sendError(res, 429, 'Please wait a moment before sending another message.');
  recent.push(now);
  chatAttempts.set(key, recent);
  return next();
}

app.post('/api/conversations/:id/messages', requireUser, limitChatRequests, asyncRoute(async (req, res) => {
  const conversation = db.prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!conversation) return sendError(res, 404, 'Conversation not found.');

  const content = stringField(req.body?.content, 1, 12000);
  const clientRequestId = stringField(req.body?.clientRequestId, 1, 80);
  if (!content || !clientRequestId) return sendError(res, 400, 'Enter a message and a valid request identifier.');
  if (!process.env.AI_API_KEY) {
    return sendError(res, 503, 'AI chat is not configured yet. Set AI_API_KEY on the server, then restart HEALIX.');
  }

  const existing = db.prepare(`
    SELECT id, content FROM chat_messages
    WHERE conversation_id = ? AND client_request_id = ? AND role = 'user'
  `).get(conversation.id, clientRequestId);
  if (existing && existing.content !== content) {
    return sendError(res, 409, 'This message identifier has already been used for different content.');
  }

  const now = new Date().toISOString();
  if (!existing) {
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, client_request_id, created_at)
      VALUES (?, ?, 'user', ?, ?, ?)
    `).run(crypto.randomUUID(), conversation.id, content, clientRequestId, now);
    const count = db.prepare('SELECT COUNT(*) AS total FROM chat_messages WHERE conversation_id = ?').get(conversation.id).total;
    const title = count === 1 ? content.slice(0, 64) : conversation.title;
    db.prepare('UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
      .run(title, now, conversation.id, req.user.id);
  }

  const history = db.prepare(`
    SELECT role, content FROM chat_messages WHERE conversation_id = ?
    ORDER BY created_at DESC LIMIT 21
  `).all(conversation.id).reverse();
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'gpt-4o-mini';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const providerResponse = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are HEALIX AI, an assistant for general health education, not a clinician. Do not diagnose or prescribe. Be clear about uncertainty, ask concise follow-up questions when important context is missing, and give cautious general information. For medicine questions, consider allergies, pregnancy, age, conditions, and interactions; do not invent dosages or facts, and recommend a pharmacist or clinician for personal advice. If symptoms may indicate an emergency, advise the user to contact local emergency services immediately. Never claim to have examined the user or accessed health records. Encourage professional care when appropriate.'
          },
          ...history.map((message) => ({ role: message.role, content: message.content }))
        ]
      }),
      signal: controller.signal
    }));
    if (!providerResponse.ok) {
      console.error(`AI provider returned HTTP ${providerResponse.status}.`);
      return sendError(res, 502, 'The AI service could not complete this response. Please try again.');
    }
    const data = await providerResponse.json();
    const reply = data.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim() || reply.trim().length > 12000) {
      console.error('AI provider returned an empty or invalid response.');
      return sendError(res, 502, 'The AI service returned an unreadable response. Please try again.');
    }
    const responseTime = new Date().toISOString();
    const assistantMessage = { id: crypto.randomUUID(), role: 'assistant', content: reply.trim(), createdAt: responseTime };
    db.prepare(`
      INSERT INTO chat_messages (id, conversation_id, role, content, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(assistantMessage.id, conversation.id, assistantMessage.role, assistantMessage.content, responseTime);
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ? AND user_id = ?')
      .run(responseTime, conversation.id, req.user.id);
    return res.json({ message: assistantMessage });
  } catch (error) {
    console.error(error.name === 'AbortError' ? 'AI provider request timed out.' : 'AI provider request failed.');
    return sendError(res, 502, error.name === 'AbortError'
      ? 'The AI service took too long to respond. Please try again.'
      : 'The AI service is temporarily unavailable. Please try again.');
  } finally {
    clearTimeout(timeout);
  }
});

app.use('/api', (req, res) => sendError(res, 404, 'API endpoint not found.'));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return sendError(res, 400, 'Request body must be valid JSON.');
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
