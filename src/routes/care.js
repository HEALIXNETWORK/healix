const crypto = require('node:crypto');
const express = require('express');
const { db } = require('../db');
const { sendError, stringField, optionalString, audit, notify } = require('../common');
const { requireUser, requireRole, requireVerifiedDoctor, doctorStatusFor } = require('../auth');

const router = express.Router();

const PROFILE_FIELDS = {
  specialization: 120,
  qualifications: 500,
  registrationNumber: 80,
  registrationAuthority: 160,
  registrationCountry: 80,
  clinicName: 160,
  clinicAddress: 300,
  bio: 1500,
  availabilityNote: 300
};
// Hospital-style departments used to group the directory. Doctors choose one as their specialization.
const DEPARTMENTS = [
  'General Medicine', 'Cardiology', 'Dermatology', 'Pediatrics', 'Obstetrics & Gynecology', 'Orthopedics',
  'Neurology', 'Psychiatry', 'ENT (Ear, Nose & Throat)', 'Ophthalmology', 'Gastroenterology', 'Pulmonology',
  'Endocrinology', 'Nephrology', 'Urology', 'Oncology', 'Dentistry', 'Physiotherapy', 'Other'
];
// Changing any of these after verification sends the profile back for review.
const CREDENTIAL_FIELDS = ['specialization', 'qualifications', 'registrationNumber', 'registrationAuthority', 'registrationCountry'];

function doctorProfileRow(userId) {
  const profile = db.prepare(`
    SELECT specialization, qualifications, registration_number AS registrationNumber,
      registration_authority AS registrationAuthority, registration_country AS registrationCountry,
      years_experience AS yearsExperience, clinic_name AS clinicName, clinic_address AS clinicAddress,
      bio, availability_note AS availabilityNote, accepting_consultations AS acceptingConsultations,
      verification_status AS verificationStatus, verified_at AS verifiedAt, updated_at AS updatedAt
    FROM doctor_profiles WHERE user_id = ?
  `).get(userId);
  return profile && { ...profile, acceptingConsultations: Boolean(profile.acceptingConsultations) };
}

function notifyAdmins(type, title, body, screen) {
  const admins = db.prepare(`
    SELECT users.id FROM user_roles JOIN users ON users.id = user_roles.user_id
    WHERE user_roles.role_id = 'admin' AND users.status = 'active'
  `).all();
  for (const admin of admins) notify(admin.id, type, title, body, screen);
}

const directoryColumns = `
  users.id, users.name, doctor_profiles.specialization, doctor_profiles.qualifications,
  doctor_profiles.years_experience AS yearsExperience, doctor_profiles.clinic_name AS clinicName,
  doctor_profiles.clinic_address AS clinicAddress, doctor_profiles.bio,
  doctor_profiles.availability_note AS availabilityNote,
  doctor_profiles.accepting_consultations AS acceptingConsultations,
  doctor_profiles.registration_authority AS registrationAuthority,
  doctor_profiles.registration_country AS registrationCountry, doctor_profiles.verified_at AS verifiedAt
`;

// Directory: only verified doctors with active accounts are ever listed.
router.get('/doctors', requireUser, (req, res) => {
  const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
  const like = `%${query.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
  const doctors = db.prepare(`
    SELECT ${directoryColumns}
    FROM doctor_profiles JOIN users ON users.id = doctor_profiles.user_id
    WHERE doctor_profiles.verification_status = 'verified' AND users.status = 'active'
      AND (? = '' OR users.name LIKE ? ESCAPE '\\' OR doctor_profiles.specialization LIKE ? ESCAPE '\\'
        OR doctor_profiles.clinic_name LIKE ? ESCAPE '\\' OR doctor_profiles.clinic_address LIKE ? ESCAPE '\\')
    ORDER BY doctor_profiles.specialization, users.name
    LIMIT 500
  `).all(query, like, like, like, like).map((doctor) => ({ ...doctor, acceptingConsultations: Boolean(doctor.acceptingConsultations) }));
  return res.json({ doctors });
});

// --- Doctor workspace --------------------------------------------------------------------------

router.get('/doctor/profile', requireUser, requireRole('doctor'), (req, res) => {
  const profile = doctorProfileRow(req.user.id);
  if (!profile) return sendError(res, 404, 'Doctor profile not found.');
  const verification = db.prepare(`
    SELECT doctor_verifications.id, doctor_verifications.status, doctor_verifications.reviewer_notes AS reviewerNotes,
      doctor_verifications.submitted_at AS submittedAt, doctor_verifications.reviewed_at AS reviewedAt,
      attachments.original_name AS credentialName
    FROM doctor_verifications LEFT JOIN attachments ON attachments.id = doctor_verifications.credential_attachment_id
    WHERE doctor_verifications.doctor_user_id = ?
    ORDER BY doctor_verifications.submitted_at DESC LIMIT 1
  `).get(req.user.id) || null;
  return res.json({ profile, verification });
});

router.put('/doctor/profile', requireUser, requireRole('doctor'), (req, res) => {
  const current = doctorProfileRow(req.user.id);
  if (!current) return sendError(res, 404, 'Doctor profile not found.');
  const next = {};
  for (const [field, max] of Object.entries(PROFILE_FIELDS)) {
    const value = optionalString(req.body?.[field], max);
    if (value === null) return sendError(res, 400, `Check the ${field.replace(/[A-Z]/g, (c) => ` ${c.toLowerCase()}`)} field (maximum ${max} characters).`);
    next[field] = value;
  }
  if (next.specialization && !DEPARTMENTS.includes(next.specialization)) {
    return sendError(res, 400, 'Choose your department from the list.');
  }
  const years = req.body?.yearsExperience;
  if (years !== null && years !== undefined && (!Number.isInteger(years) || years < 0 || years > 70)) {
    return sendError(res, 400, 'Years of experience must be a whole number from 0 to 70.');
  }
  next.yearsExperience = years ?? null;
  if (typeof req.body?.acceptingConsultations !== 'boolean') return sendError(res, 400, 'Choose whether you are accepting consultation requests.');
  next.acceptingConsultations = req.body.acceptingConsultations ? 1 : 0;

  const credentialsChanged = CREDENTIAL_FIELDS.some((field) => current[field] !== next[field]);
  const requiresReview = current.verificationStatus === 'verified' && credentialsChanged;
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE doctor_profiles SET specialization = @specialization, qualifications = @qualifications,
        registration_number = @registrationNumber, registration_authority = @registrationAuthority,
        registration_country = @registrationCountry, years_experience = @yearsExperience,
        clinic_name = @clinicName, clinic_address = @clinicAddress, bio = @bio,
        availability_note = @availabilityNote, accepting_consultations = @acceptingConsultations, updated_at = @now
      WHERE user_id = @userId
    `).run({ ...next, now, userId: req.user.id });
    if (requiresReview) {
      db.prepare(`
        UPDATE doctor_profiles SET verification_status = 'pending_verification', verified_at = NULL, verified_by = NULL
        WHERE user_id = ?
      `).run(req.user.id);
      audit(req, 'doctor.credentials_changed', 'user', req.user.id);
    }
  })();
  return res.json({ profile: doctorProfileRow(req.user.id), requiresReview });
});

router.post('/doctor/verification', requireUser, requireRole('doctor'), (req, res) => {
  const profile = doctorProfileRow(req.user.id);
  if (!profile) return sendError(res, 404, 'Doctor profile not found.');
  if (profile.verificationStatus === 'verified') return sendError(res, 409, 'Your credentials are already verified.');
  const missing = CREDENTIAL_FIELDS.filter((field) => !profile[field]);
  if (missing.length) {
    return sendError(res, 400, 'Complete your specialization, qualifications, and professional registration details before submitting.');
  }
  const pending = db.prepare("SELECT id FROM doctor_verifications WHERE doctor_user_id = ? AND status = 'submitted'").get(req.user.id);
  if (pending) return sendError(res, 409, 'A verification request is already awaiting review.');

  let credentialId = null;
  if (req.body?.credentialAttachmentId !== undefined && req.body?.credentialAttachmentId !== null) {
    const attachment = db.prepare("SELECT id FROM attachments WHERE id = ? AND user_id = ? AND purpose = 'credential'")
      .get(req.body.credentialAttachmentId, req.user.id);
    if (!attachment) return sendError(res, 400, 'Upload the credential document again and resubmit.');
    credentialId = attachment.id;
  }
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO doctor_verifications (id, doctor_user_id, registration_number, registration_authority,
        registration_country, qualifications, specialization, credential_attachment_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.user.id, profile.registrationNumber, profile.registrationAuthority, profile.registrationCountry,
      profile.qualifications, profile.specialization, credentialId, now);
    db.prepare("UPDATE doctor_profiles SET verification_status = 'pending_verification', updated_at = ? WHERE user_id = ?")
      .run(now, req.user.id);
    audit(req, 'doctor.verification_submitted', 'doctor_verification', id);
    notifyAdmins('verification.submitted', 'New doctor verification request', `${req.user.name} submitted professional credentials for review.`, 'admin');
  })();
  return res.status(201).json({ verification: { id, status: 'submitted', submittedAt: now } });
});

const doctorConsultationColumns = `
  consultations.id, consultations.reason, consultations.preferred_time AS preferredTime, consultations.status,
  consultations.scheduled_at AS scheduledAt, consultations.doctor_note AS doctorNote,
  consultations.created_at AS createdAt, consultations.updated_at AS updatedAt, patients.name AS patientName
`;

function sharesFor(consultationId) {
  return db.prepare(`
    SELECT shared_patient_records.id, shared_patient_records.record_type AS recordType,
      shared_patient_records.record_id AS recordId, shared_patient_records.created_at AS createdAt,
      conversations.title
    FROM shared_patient_records LEFT JOIN conversations ON conversations.id = shared_patient_records.record_id
    WHERE shared_patient_records.consultation_id = ? AND shared_patient_records.revoked_at IS NULL
    ORDER BY shared_patient_records.created_at
  `).all(consultationId);
}

router.get('/doctor/consultations', requireUser, requireVerifiedDoctor, (req, res) => {
  const consultations = db.prepare(`
    SELECT ${doctorConsultationColumns}
    FROM consultations JOIN users AS patients ON patients.id = consultations.patient_id
    WHERE consultations.doctor_id = ?
    ORDER BY CASE consultations.status WHEN 'requested' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END, consultations.created_at DESC
  `).all(req.user.id).map((consultation) => ({
    ...consultation,
    shares: consultation.status === 'accepted' ? sharesFor(consultation.id) : []
  }));
  return res.json({ consultations });
});

router.post('/doctor/consultations/:id/respond', requireUser, requireVerifiedDoctor, (req, res) => {
  const consultation = db.prepare('SELECT id, patient_id, status FROM consultations WHERE id = ? AND doctor_id = ?')
    .get(req.params.id, req.user.id);
  if (!consultation) return sendError(res, 404, 'Consultation not found.');
  const action = req.body?.action;
  const note = optionalString(req.body?.note, 1000);
  if (note === null) return sendError(res, 400, 'Keep your note under 1,000 characters.');
  const transitions = { accept: ['requested', 'accepted'], decline: ['requested', 'declined'], complete: ['accepted', 'completed'] };
  if (!transitions[action]) return sendError(res, 400, 'Choose accept, decline, or complete.');
  const [from, to] = transitions[action];
  if (consultation.status !== from) return sendError(res, 409, `This consultation is ${consultation.status} and cannot be changed that way.`);
  let scheduledAt = null;
  if (action === 'accept') {
    const date = typeof req.body?.scheduledAt === 'string' ? new Date(req.body.scheduledAt) : null;
    if (!date || Number.isNaN(date.getTime()) || date.getTime() < Date.now() - 60000) {
      return sendError(res, 400, 'Choose a future date and time for the consultation.');
    }
    scheduledAt = date.toISOString();
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`
      UPDATE consultations SET status = ?, scheduled_at = COALESCE(?, scheduled_at), doctor_note = ?, updated_at = ?
      WHERE id = ?
    `).run(to, scheduledAt, note, now, consultation.id);
    if (to !== 'accepted') {
      db.prepare('UPDATE shared_patient_records SET revoked_at = ? WHERE consultation_id = ? AND revoked_at IS NULL').run(now, consultation.id);
    }
    audit(req, `consultation.${to}`, 'consultation', consultation.id);
    const titles = { accepted: 'Consultation request accepted', declined: 'Consultation request declined', completed: 'Consultation marked complete' };
    notify(consultation.patient_id, `consultation.${to}`, titles[to], `Dr. ${req.user.name} updated your consultation request.`, 'appointments');
  })();
  return res.json({ ok: true, status: to });
});

// A doctor can read a conversation only while the patient's share is active on an accepted consultation.
router.get('/doctor/consultations/:id/shares/:shareId', requireUser, requireVerifiedDoctor, (req, res) => {
  const share = db.prepare(`
    SELECT shared_patient_records.id, shared_patient_records.record_id, shared_patient_records.patient_id
    FROM shared_patient_records JOIN consultations ON consultations.id = shared_patient_records.consultation_id
    WHERE shared_patient_records.id = ? AND shared_patient_records.consultation_id = ?
      AND shared_patient_records.doctor_id = ? AND shared_patient_records.revoked_at IS NULL
      AND shared_patient_records.record_type = 'conversation' AND consultations.status = 'accepted'
  `).get(req.params.shareId, req.params.id, req.user.id);
  if (!share) return sendError(res, 404, 'This shared record is not available.');
  const conversation = db.prepare('SELECT id, title FROM conversations WHERE id = ? AND user_id = ?').get(share.record_id, share.patient_id);
  if (!conversation) return sendError(res, 404, 'This shared record is no longer available.');
  const messages = db.prepare(`
    SELECT chat_messages.id, chat_messages.role, chat_messages.content, chat_messages.created_at AS createdAt,
      (SELECT COUNT(*) FROM attachments WHERE attachments.message_id = chat_messages.id) AS attachmentCount
    FROM chat_messages WHERE conversation_id = ? ORDER BY created_at
  `).all(conversation.id);
  audit(req, 'patient_record.viewed', 'shared_patient_record', share.id);
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ conversation: { title: conversation.title, messages } });
});

// --- Patient consultations ---------------------------------------------------------------------

router.post('/consultations', requireUser, (req, res) => {
  const doctorId = stringField(req.body?.doctorId, 1, 80);
  const reason = stringField(req.body?.reason, 1, 1000);
  const preferredTime = optionalString(req.body?.preferredTime, 120);
  if (!doctorId || !reason || preferredTime === null) {
    return sendError(res, 400, 'Choose a doctor, describe the reason in under 1,000 characters, and keep the preferred time short.');
  }
  if (doctorId === req.user.id) return sendError(res, 400, 'You cannot request a consultation with yourself.');
  const doctor = db.prepare(`
    SELECT users.id FROM doctor_profiles JOIN users ON users.id = doctor_profiles.user_id
    WHERE users.id = ? AND users.status = 'active' AND doctor_profiles.verification_status = 'verified'
      AND doctor_profiles.accepting_consultations = 1
  `).get(doctorId);
  if (!doctor) return sendError(res, 404, 'This doctor is not currently accepting consultation requests.');
  const open = db.prepare(`
    SELECT COUNT(*) AS total FROM consultations WHERE patient_id = ? AND status = 'requested'
  `).get(req.user.id).total;
  if (open >= 5) return sendError(res, 429, 'You have several requests awaiting a response. Cancel one or wait for a reply first.');

  const now = new Date().toISOString();
  const consultation = { id: crypto.randomUUID(), status: 'requested', reason, preferredTime, createdAt: now };
  db.transaction(() => {
    db.prepare(`
      INSERT INTO consultations (id, patient_id, doctor_id, reason, preferred_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(consultation.id, req.user.id, doctor.id, reason, preferredTime, now, now);
    notify(doctor.id, 'consultation.requested', 'New consultation request', `${req.user.name} requested a consultation.`, 'doctor');
  })();
  return res.status(201).json({ consultation });
});

router.get('/consultations', requireUser, (req, res) => {
  const consultations = db.prepare(`
    SELECT consultations.id, consultations.reason, consultations.preferred_time AS preferredTime, consultations.status,
      consultations.scheduled_at AS scheduledAt, consultations.doctor_note AS doctorNote,
      consultations.created_at AS createdAt, doctors.id AS doctorId, doctors.name AS doctorName,
      doctor_profiles.specialization
    FROM consultations
      JOIN users AS doctors ON doctors.id = consultations.doctor_id
      LEFT JOIN doctor_profiles ON doctor_profiles.user_id = consultations.doctor_id
    WHERE consultations.patient_id = ?
    ORDER BY consultations.created_at DESC
  `).all(req.user.id).map((consultation) => ({ ...consultation, shares: sharesFor(consultation.id) }));
  return res.json({ consultations });
});

router.post('/consultations/:id/cancel', requireUser, (req, res) => {
  const consultation = db.prepare(`
    SELECT id, doctor_id, status FROM consultations WHERE id = ? AND patient_id = ?
  `).get(req.params.id, req.user.id);
  if (!consultation) return sendError(res, 404, 'Consultation not found.');
  if (!['requested', 'accepted'].includes(consultation.status)) return sendError(res, 409, 'This consultation can no longer be cancelled.');
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare("UPDATE consultations SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, consultation.id);
    db.prepare('UPDATE shared_patient_records SET revoked_at = ? WHERE consultation_id = ? AND revoked_at IS NULL').run(now, consultation.id);
    notify(consultation.doctor_id, 'consultation.cancelled', 'Consultation cancelled', `${req.user.name} cancelled a consultation.`, 'doctor');
  })();
  return res.json({ ok: true });
});

router.post('/consultations/:id/shares', requireUser, (req, res) => {
  const consultation = db.prepare(`
    SELECT id, doctor_id, status FROM consultations WHERE id = ? AND patient_id = ?
  `).get(req.params.id, req.user.id);
  if (!consultation) return sendError(res, 404, 'Consultation not found.');
  if (consultation.status !== 'accepted') return sendError(res, 409, 'You can share records after the doctor accepts the consultation.');
  if (doctorStatusFor(consultation.doctor_id) !== 'verified') return sendError(res, 409, "This doctor's verification is no longer active.");
  const conversation = db.prepare('SELECT id FROM conversations WHERE id = ? AND user_id = ?').get(req.body?.conversationId, req.user.id);
  if (!conversation) return sendError(res, 404, 'Conversation not found.');
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(`
      INSERT INTO shared_patient_records (id, consultation_id, patient_id, doctor_id, record_type, record_id, created_at)
      VALUES (?, ?, ?, ?, 'conversation', ?, ?)
      ON CONFLICT(consultation_id, record_type, record_id) DO UPDATE SET revoked_at = NULL, created_at = excluded.created_at
    `).run(id, consultation.id, req.user.id, consultation.doctor_id, conversation.id, now);
    audit(req, 'patient_record.shared', 'consultation', consultation.id);
    notify(consultation.doctor_id, 'record.shared', 'A patient shared a conversation', `${req.user.name} shared an AI conversation for your consultation.`, 'doctor');
  })();
  return res.status(201).json({ shares: sharesFor(consultation.id) });
});

router.delete('/consultations/:id/shares/:shareId', requireUser, (req, res) => {
  const result = db.prepare(`
    UPDATE shared_patient_records SET revoked_at = ?
    WHERE id = ? AND consultation_id = ? AND patient_id = ? AND revoked_at IS NULL
  `).run(new Date().toISOString(), req.params.shareId, req.params.id, req.user.id);
  if (!result.changes) return sendError(res, 404, 'Shared record not found.');
  audit(req, 'patient_record.share_revoked', 'shared_patient_record', req.params.shareId);
  return res.json({ ok: true });
});

module.exports = { router, notifyAdmins, DEPARTMENTS };
