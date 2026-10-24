const crypto = require('node:crypto');
const fs = require('node:fs');
const express = require('express');
const { db, databasePath } = require('../db');
const { sendError, stringField, optionalString, audit, notify } = require('../common');
const { requireUser, requireRole } = require('../auth');
const { aiCapabilities } = require('../ai');
const { sendAttachmentContent } = require('./attachments');

const router = express.Router();
const startedAt = Date.now();

// Every route in this module is administrator-only. Administrators do not get access to
// users' AI conversations, hydration, or appointments; none of those tables are read here.
router.use(requireUser, requireRole('admin'));
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

function count(sql, ...params) {
  return db.prepare(sql).get(...params).total;
}

router.get('/overview', (req, res) => {
  let sizeBytes = 0;
  for (const file of [databasePath, `${databasePath}-wal`]) {
    try {
      sizeBytes += fs.statSync(file).size;
    } catch {
      // The WAL file may not exist.
    }
  }
  return res.json({
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    nodeVersion: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
    database: {
      sizeBytes,
      integrity: db.pragma('quick_check', { simple: true }),
      migrations: db.prepare('SELECT name, applied_at AS appliedAt FROM schema_migrations ORDER BY name').all()
    },
    ai: aiCapabilities(),
    counts: {
      users: count('SELECT COUNT(*) AS total FROM users'),
      suspendedUsers: count("SELECT COUNT(*) AS total FROM users WHERE status = 'suspended'"),
      verifiedDoctors: count("SELECT COUNT(*) AS total FROM doctor_profiles WHERE verification_status = 'verified'"),
      pendingVerifications: count("SELECT COUNT(*) AS total FROM doctor_verifications WHERE status = 'submitted'"),
      openReports: count("SELECT COUNT(*) AS total FROM reports WHERE status IN ('open', 'reviewing')"),
      activeSessions: count('SELECT COUNT(*) AS total FROM sessions WHERE expires_at > ?', new Date().toISOString())
    }
  });
});

// --- Doctor verification ------------------------------------------------------------------------

router.get('/verifications', (req, res) => {
  const status = ['submitted', 'approved', 'rejected', 'withdrawn'].includes(req.query.status) ? req.query.status : null;
  const verifications = db.prepare(`
    SELECT doctor_verifications.id, doctor_verifications.status, doctor_verifications.registration_number AS registrationNumber,
      doctor_verifications.registration_authority AS registrationAuthority,
      doctor_verifications.registration_country AS registrationCountry, doctor_verifications.qualifications,
      doctor_verifications.specialization, doctor_verifications.reviewer_notes AS reviewerNotes,
      doctor_verifications.submitted_at AS submittedAt, doctor_verifications.reviewed_at AS reviewedAt,
      doctor_verifications.credential_attachment_id IS NOT NULL AS hasCredential,
      users.id AS doctorId, users.name AS doctorName, users.email AS doctorEmail, users.status AS accountStatus,
      doctor_profiles.verification_status AS profileStatus, doctor_profiles.years_experience AS yearsExperience,
      doctor_profiles.clinic_name AS clinicName, doctor_profiles.clinic_address AS clinicAddress,
      reviewers.name AS reviewerName
    FROM doctor_verifications
      JOIN users ON users.id = doctor_verifications.doctor_user_id
      LEFT JOIN doctor_profiles ON doctor_profiles.user_id = users.id
      LEFT JOIN users AS reviewers ON reviewers.id = doctor_verifications.reviewer_id
    WHERE (? IS NULL OR doctor_verifications.status = ?)
    ORDER BY doctor_verifications.status = 'submitted' DESC, doctor_verifications.submitted_at DESC
    LIMIT 200
  `).all(status, status).map((row) => ({ ...row, hasCredential: Boolean(row.hasCredential) }));
  return res.json({ verifications });
});

router.get('/verifications/:id/credential', (req, res) => {
  const row = db.prepare(`
    SELECT attachments.* FROM doctor_verifications
      JOIN attachments ON attachments.id = doctor_verifications.credential_attachment_id
    WHERE doctor_verifications.id = ? AND attachments.purpose = 'credential'
  `).get(req.params.id);
  if (!row) return sendError(res, 404, 'No credential document was submitted with this request.');
  audit(req, 'doctor.credential_viewed', 'doctor_verification', req.params.id);
  return sendAttachmentContent(res, row);
});

router.post('/verifications/:id/decision', (req, res) => {
  const decision = req.body?.decision;
  const notes = optionalString(req.body?.notes, 1000);
  if (!['approve', 'reject'].includes(decision) || notes === null) {
    return sendError(res, 400, 'Choose approve or reject, and keep notes under 1,000 characters.');
  }
  if (decision === 'reject' && !notes) return sendError(res, 400, 'Add a note explaining what the doctor needs to correct.');
  const verification = db.prepare("SELECT id, doctor_user_id FROM doctor_verifications WHERE id = ? AND status = 'submitted'").get(req.params.id);
  if (!verification) return sendError(res, 404, 'Pending verification request not found.');
  if (verification.doctor_user_id === req.user.id) return sendError(res, 403, 'You cannot review your own verification request.');

  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE doctor_verifications SET status = ?, reviewer_id = ?, reviewer_notes = ?, reviewed_at = ? WHERE id = ?
    `).run(decision === 'approve' ? 'approved' : 'rejected', req.user.id, notes, now, verification.id);
    db.prepare(`
      UPDATE doctor_profiles SET verification_status = ?, verified_at = ?, verified_by = ?, updated_at = ? WHERE user_id = ?
    `).run(decision === 'approve' ? 'verified' : 'rejected', decision === 'approve' ? now : null,
      decision === 'approve' ? req.user.id : null, now, verification.doctor_user_id);
    audit(req, decision === 'approve' ? 'doctor.verification_approved' : 'doctor.verification_rejected', 'user', verification.doctor_user_id, { verificationId: verification.id });
    notify(verification.doctor_user_id, `verification.${decision}`,
      decision === 'approve' ? 'Your credentials have been verified' : 'Your verification needs attention',
      decision === 'approve' ? 'Your profile now appears in the HEALIX doctor directory.' : notes, 'doctor');
  })();
  return res.json({ ok: true });
});

router.post('/doctors/:userId/revoke', (req, res) => {
  const notes = stringField(req.body?.notes, 1, 1000);
  if (!notes) return sendError(res, 400, 'Add a reason for revoking verification.');
  const now = new Date().toISOString();
  const result = db.transaction(() => {
    const changed = db.prepare(`
      UPDATE doctor_profiles SET verification_status = 'revoked', verified_at = NULL, verified_by = NULL,
        accepting_consultations = 0, updated_at = ?
      WHERE user_id = ? AND verification_status = 'verified'
    `).run(now, req.params.userId).changes;
    if (!changed) return 0;
    db.prepare(`
      UPDATE shared_patient_records SET revoked_at = ? WHERE doctor_id = ? AND revoked_at IS NULL
    `).run(now, req.params.userId);
    audit(req, 'doctor.verification_revoked', 'user', req.params.userId);
    notify(req.params.userId, 'verification.revoked', 'Your verification was revoked', notes, 'doctor');
    return changed;
  })();
  if (!result) return sendError(res, 404, 'Verified doctor not found.');
  return res.json({ ok: true });
});

// --- Accounts -----------------------------------------------------------------------------------

router.get('/users', (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const users = db.prepare(`
    SELECT users.id, users.name, users.email, users.status, users.status_reason AS statusReason,
      users.created_at AS createdAt,
      (SELECT group_concat(role_id, ',') FROM user_roles WHERE user_roles.user_id = users.id) AS roles,
      doctor_profiles.verification_status AS doctorStatus
    FROM users LEFT JOIN doctor_profiles ON doctor_profiles.user_id = users.id
    WHERE ? = '' OR users.name LIKE ? ESCAPE '\\' OR users.email LIKE ? ESCAPE '\\'
    ORDER BY users.created_at DESC LIMIT 100
  `).all(query, like, like).map((user) => ({ ...user, roles: user.roles ? user.roles.split(',').sort() : [] }));
  return res.json({ users });
});

router.post('/users/:id/status', (req, res) => {
  const status = req.body?.status;
  const reason = optionalString(req.body?.reason, 500);
  if (!['active', 'suspended'].includes(status) || reason === null) {
    return sendError(res, 400, 'Choose active or suspended, and keep the reason under 500 characters.');
  }
  if (status === 'suspended' && !reason) return sendError(res, 400, 'Add a reason for the suspension.');
  if (req.params.id === req.user.id) return sendError(res, 403, 'You cannot change the status of your own account.');
  const target = db.prepare('SELECT id, status FROM users WHERE id = ?').get(req.params.id);
  if (!target) return sendError(res, 404, 'User not found.');
  db.transaction(() => {
    db.prepare('UPDATE users SET status = ?, status_reason = ? WHERE id = ?').run(status, status === 'suspended' ? reason : null, target.id);
    if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    audit(req, status === 'suspended' ? 'user.suspended' : 'user.reinstated', 'user', target.id, { previousStatus: target.status });
  })();
  return res.json({ ok: true });
});

// --- Reports ------------------------------------------------------------------------------------

router.get('/reports', (req, res) => {
  const status = ['open', 'reviewing', 'resolved', 'dismissed'].includes(req.query.status) ? req.query.status : null;
  const reports = db.prepare(`
    SELECT reports.id, reports.target_type AS targetType, reports.target_id AS targetId, reports.reason,
      reports.snapshot, reports.status, reports.resolution_note AS resolutionNote,
      reports.created_at AS createdAt, reports.updated_at AS updatedAt,
      reporters.name AS reporterName, targets.name AS targetName
    FROM reports
      LEFT JOIN users AS reporters ON reporters.id = reports.reporter_id
      LEFT JOIN users AS targets ON reports.target_type = 'doctor' AND targets.id = reports.target_id
    WHERE (? IS NULL OR reports.status = ?)
    ORDER BY reports.status IN ('open', 'reviewing') DESC, reports.created_at DESC LIMIT 200
  `).all(status, status);
  return res.json({ reports });
});

router.put('/reports/:id', (req, res) => {
  const status = req.body?.status;
  const note = optionalString(req.body?.note, 1000);
  if (!['open', 'reviewing', 'resolved', 'dismissed'].includes(status) || note === null) {
    return sendError(res, 400, 'Choose a valid report status and keep the note under 1,000 characters.');
  }
  const result = db.prepare(`
    UPDATE reports SET status = ?, resolution_note = ?, resolved_by = ?, updated_at = ? WHERE id = ?
  `).run(status, note, req.user.id, new Date().toISOString(), req.params.id);
  if (!result.changes) return sendError(res, 404, 'Report not found.');
  audit(req, 'report.updated', 'report', req.params.id, { status });
  return res.json({ ok: true });
});

// --- Approved health content -------------------------------------------------------------------

function contentFromBody(body) {
  const category = ['relaxation', 'education'].includes(body?.category) ? body.category : null;
  const title = stringField(body?.title, 1, 160);
  const summary = optionalString(body?.summary, 300);
  const text = stringField(body?.body, 1, 8000);
  const status = ['draft', 'published'].includes(body?.status) ? body.status : null;
  if (!category || !title || summary === null || !text || !status) return null;
  return { category, title, summary, body: text, status };
}

const contentColumns = `id, category, title, summary, body, status, created_at AS createdAt,
  updated_at AS updatedAt, published_at AS publishedAt`;

router.get('/content', (req, res) => {
  return res.json({ content: db.prepare(`SELECT ${contentColumns} FROM health_content ORDER BY updated_at DESC`).all() });
});

router.post('/content', (req, res) => {
  const content = contentFromBody(req.body);
  if (!content) return sendError(res, 400, 'Enter a category, title, body (up to 8,000 characters), and status.');
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO health_content (id, category, title, summary, body, status, created_by, updated_by, created_at, updated_at, published_at)
    VALUES (@id, @category, @title, @summary, @body, @status, @userId, @userId, @now, @now, @publishedAt)
  `).run({ ...content, id, userId: req.user.id, now, publishedAt: content.status === 'published' ? now : null });
  audit(req, 'content.created', 'health_content', id, { status: content.status });
  return res.status(201).json({ content: db.prepare(`SELECT ${contentColumns} FROM health_content WHERE id = ?`).get(id) });
});

router.put('/content/:id', (req, res) => {
  const content = contentFromBody(req.body);
  if (!content) return sendError(res, 400, 'Enter a category, title, body (up to 8,000 characters), and status.');
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE health_content SET category = @category, title = @title, summary = @summary, body = @body, status = @status,
      updated_by = @userId, updated_at = @now,
      published_at = CASE WHEN @status = 'published' THEN COALESCE(published_at, @now) ELSE NULL END
    WHERE id = @id
  `).run({ ...content, id: req.params.id, userId: req.user.id, now });
  if (!result.changes) return sendError(res, 404, 'Content not found.');
  audit(req, 'content.updated', 'health_content', req.params.id, { status: content.status });
  return res.json({ content: db.prepare(`SELECT ${contentColumns} FROM health_content WHERE id = ?`).get(req.params.id) });
});

router.delete('/content/:id', (req, res) => {
  const result = db.prepare('DELETE FROM health_content WHERE id = ?').run(req.params.id);
  if (!result.changes) return sendError(res, 404, 'Content not found.');
  audit(req, 'content.deleted', 'health_content', req.params.id);
  return res.json({ ok: true });
});

// --- Audit log and settings ---------------------------------------------------------------------

router.get('/audit-logs', (req, res) => {
  const before = typeof req.query.before === 'string' && !Number.isNaN(Date.parse(req.query.before))
    ? new Date(req.query.before).toISOString()
    : '9999-12-31T00:00:00.000Z';
  const logs = db.prepare(`
    SELECT audit_logs.id, audit_logs.action, audit_logs.target_type AS targetType, audit_logs.target_id AS targetId,
      audit_logs.details, audit_logs.ip_address AS ipAddress, audit_logs.created_at AS createdAt,
      users.name AS actorName
    FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_user_id
    WHERE audit_logs.created_at < ?
    ORDER BY audit_logs.created_at DESC LIMIT 100
  `).all(before).map((log) => ({ ...log, details: JSON.parse(log.details || '{}') }));
  return res.json({ logs });
});

router.get('/settings', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM system_settings').all();
  return res.json({ settings: Object.fromEntries(rows.map((row) => [row.key, row.value])) });
});

router.put('/settings', (req, res) => {
  const { registrationOpen, doctorRegistrationOpen, announcement } = req.body || {};
  const text = optionalString(announcement, 500);
  if (typeof registrationOpen !== 'boolean' || typeof doctorRegistrationOpen !== 'boolean' || text === null) {
    return sendError(res, 400, 'Provide both registration switches and an announcement under 500 characters.');
  }
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE system_settings SET value = ?, updated_at = ?, updated_by = ? WHERE key = ?');
  db.transaction(() => {
    update.run(String(registrationOpen), now, req.user.id, 'registration_open');
    update.run(String(doctorRegistrationOpen), now, req.user.id, 'doctor_registration_open');
    update.run(text, now, req.user.id, 'announcement');
    audit(req, 'settings.updated', 'system_settings', null, { registrationOpen, doctorRegistrationOpen, announcementSet: Boolean(text) });
  })();
  return res.json({ ok: true });
});

module.exports = { router };
