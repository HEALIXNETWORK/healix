const fs = require('node:fs');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const { useTemporaryStorage, createClient } = require('./helpers');

const testDirectory = useTemporaryStorage();
const { app } = require('../src/server');
const { db } = require('../src/db');

let server;
let baseUrl;
const { request, register } = createClient(() => baseUrl);
const PDF = Buffer.from('%PDF-1.4\n% test credential\n');

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

function grantAdmin(userId) {
  db.prepare("INSERT INTO user_roles (user_id, role_id, granted_at) VALUES (?, 'admin', ?)").run(userId, new Date().toISOString());
}

const profile = {
  specialization: 'General Medicine',
  qualifications: 'MBBS',
  registrationNumber: 'REG-12345',
  registrationAuthority: 'Medical Council',
  registrationCountry: 'Testland',
  yearsExperience: 8,
  clinicName: 'Example Clinic',
  clinicAddress: '1 Example Street',
  bio: '',
  availabilityNote: 'Weekday mornings',
  acceptingConsultations: true
};

async function verifiedDoctor(name, email) {
  const doctor = await register(name, email, 'doctor');
  assert.equal((await request('/api/doctor/profile', { method: 'PUT', cookie: doctor.cookie, json: profile })).status, 200);
  assert.equal((await request('/api/doctor/verification', { method: 'POST', cookie: doctor.cookie, json: {} })).status, 201);
  const verificationId = db.prepare("SELECT id FROM doctor_verifications WHERE doctor_user_id = ? AND status = 'submitted'").get(doctor.user.id).id;
  return { ...doctor, verificationId };
}

test('roles cannot be self-assigned and admin endpoints are enforced by the server', async () => {
  const selfAdmin = await request('/api/auth/register', {
    method: 'POST',
    json: { name: 'Sneaky', email: 'sneaky@example.test', password: 'correct horse battery', accountType: 'admin' }
  });
  assert.equal(selfAdmin.status, 400);

  const patient = await register('Plain Patient', 'plain@example.test');
  assert.deepEqual(patient.user.roles, ['patient']);
  for (const url of ['/api/admin/overview', '/api/admin/users', '/api/admin/verifications', '/api/admin/audit-logs']) {
    assert.equal((await request(url, { cookie: patient.cookie })).status, 403, url);
  }
  assert.equal((await request('/api/doctor/profile', { cookie: patient.cookie })).status, 403);
  const credentialUpload = await request('/api/attachments?purpose=credential', {
    method: 'POST', cookie: patient.cookie, headers: { 'Content-Type': 'application/pdf' }, body: PDF
  });
  assert.equal(credentialUpload.status, 403);
});

test('new doctors start pending and gain verified-only access only after admin approval', async () => {
  const doctor = await register('Dana Doctor', 'dana@example.test', 'doctor');
  assert.equal(doctor.doctorStatus, 'pending_verification');
  assert.deepEqual(doctor.user.roles, ['doctor', 'patient']);
  const patient = await register('Pat Patient', 'pat@example.test');

  assert.equal((await request('/api/doctor/consultations', { cookie: doctor.cookie })).status, 403);
  assert.equal((await request('/api/doctor/verification', { method: 'POST', cookie: doctor.cookie, json: {} })).status, 400);

  const badDepartment = await request('/api/doctor/profile', { method: 'PUT', cookie: doctor.cookie, json: { ...profile, specialization: 'Made-up department' } });
  assert.equal(badDepartment.status, 400);
  const config = await (await request('/api/config')).json();
  assert.ok(config.departments.includes('Cardiology') && config.departments.includes('General Medicine'));
  assert.equal((await request('/api/doctor/profile', { method: 'PUT', cookie: doctor.cookie, json: profile })).status, 200);
  const upload = await request('/api/attachments?purpose=credential', {
    method: 'POST', cookie: doctor.cookie, headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'licence.pdf' }, body: PDF
  });
  assert.equal(upload.status, 201);
  const credentialId = (await upload.json()).attachment.id;
  const submitted = await request('/api/doctor/verification', { method: 'POST', cookie: doctor.cookie, json: { credentialAttachmentId: credentialId } });
  assert.equal(submitted.status, 201);
  const verificationId = (await submitted.json()).verification.id;
  assert.equal((await request('/api/doctor/verification', { method: 'POST', cookie: doctor.cookie, json: {} })).status, 409);

  let directory = await (await request('/api/doctors', { cookie: patient.cookie })).json();
  assert.equal(directory.doctors.length, 0);
  const premature = await request('/api/consultations', { method: 'POST', cookie: patient.cookie, json: { doctorId: doctor.user.id, reason: 'Question' } });
  assert.equal(premature.status, 404);

  const admin = await register('Ada Admin', 'ada@example.test');
  grantAdmin(admin.user.id);
  const pending = await (await request('/api/admin/verifications?status=submitted', { cookie: admin.cookie })).json();
  assert.equal(pending.verifications.length, 1);
  assert.equal(pending.verifications[0].hasCredential, true);
  const credential = await request(`/api/admin/verifications/${verificationId}/credential`, { cookie: admin.cookie });
  assert.equal(credential.status, 200);
  assert.equal(credential.headers.get('content-type'), 'application/pdf');
  assert.equal((await request(`/api/admin/verifications/${verificationId}/credential`, { cookie: patient.cookie })).status, 403);

  assert.equal((await request(`/api/admin/verifications/${verificationId}/decision`, {
    method: 'POST', cookie: admin.cookie, json: { decision: 'reject' }
  })).status, 400, 'rejection requires a note');
  assert.equal((await request(`/api/admin/verifications/${verificationId}/decision`, {
    method: 'POST', cookie: admin.cookie, json: { decision: 'approve', notes: 'Checked against the public register.' }
  })).status, 200);

  directory = await (await request('/api/doctors?q=general', { cookie: patient.cookie })).json();
  assert.equal(directory.doctors.length, 1);
  assert.equal(directory.doctors[0].name, 'Dana Doctor');
  assert.equal(directory.doctors[0].registrationNumber, undefined);
  assert.equal((await request('/api/doctor/consultations', { cookie: doctor.cookie })).status, 200);
  const notifications = await (await request('/api/notifications', { cookie: doctor.cookie })).json();
  assert.ok(notifications.notifications.some((item) => item.type === 'verification.approve'));

  const actions = db.prepare('SELECT action FROM audit_logs').all().map((row) => row.action);
  assert.ok(actions.includes('doctor.verification_approved'));
  assert.ok(actions.includes('doctor.credential_viewed'));

  // Changing registration details after verification sends the profile back for review.
  const changed = await request('/api/doctor/profile', {
    method: 'PUT', cookie: doctor.cookie, json: { ...profile, registrationNumber: 'REG-99999' }
  });
  assert.equal((await changed.json()).requiresReview, true);
  directory = await (await request('/api/doctors', { cookie: patient.cookie })).json();
  assert.equal(directory.doctors.length, 0);
  assert.equal((await request('/api/doctor/consultations', { cookie: doctor.cookie })).status, 403);
});

test('consultation records are shared only with the consulting doctor and only while authorized', async () => {
  const doctor = await verifiedDoctor('Dr Share', 'share-doc@example.test');
  const otherDoctor = await verifiedDoctor('Dr Other', 'other-doc@example.test');
  const admin = await register('Admin Two', 'admin2@example.test');
  grantAdmin(admin.user.id);
  for (const { verificationId } of [doctor, otherDoctor]) {
    await request(`/api/admin/verifications/${verificationId}/decision`, { method: 'POST', cookie: admin.cookie, json: { decision: 'approve' } });
  }
  const patient = await register('Sharing Patient', 'sharing@example.test');
  const stranger = await register('Stranger', 'stranger@example.test');

  assert.equal((await request('/api/consultations', {
    method: 'POST', cookie: doctor.cookie, json: { doctorId: doctor.user.id, reason: 'Self' }
  })).status, 400);
  const requested = await request('/api/consultations', {
    method: 'POST', cookie: patient.cookie, json: { doctorId: doctor.user.id, reason: 'Recurring headaches', preferredTime: 'Mornings' }
  });
  assert.equal(requested.status, 201);
  const consultationId = (await requested.json()).consultation.id;

  assert.deepEqual((await (await request('/api/consultations', { cookie: stranger.cookie })).json()).consultations, []);
  const otherView = await (await request('/api/doctor/consultations', { cookie: otherDoctor.cookie })).json();
  assert.equal(otherView.consultations.length, 0);
  assert.equal((await request(`/api/doctor/consultations/${consultationId}/respond`, {
    method: 'POST', cookie: otherDoctor.cookie, json: { action: 'accept', scheduledAt: '2099-01-01T10:00:00Z' }
  })).status, 404);

  const conversation = await (await request('/api/conversations', { method: 'POST', cookie: patient.cookie })).json();
  const conversationId = conversation.conversation.id;
  assert.equal((await request(`/api/consultations/${consultationId}/shares`, {
    method: 'POST', cookie: patient.cookie, json: { conversationId }
  })).status, 409, 'cannot share before acceptance');

  assert.equal((await request(`/api/doctor/consultations/${consultationId}/respond`, {
    method: 'POST', cookie: doctor.cookie, json: { action: 'accept', scheduledAt: '2099-01-01T10:00:00Z', note: 'See you then.' }
  })).status, 200);

  const strangerConversation = await (await request('/api/conversations', { method: 'POST', cookie: stranger.cookie })).json();
  assert.equal((await request(`/api/consultations/${consultationId}/shares`, {
    method: 'POST', cookie: patient.cookie, json: { conversationId: strangerConversation.conversation.id }
  })).status, 404, "cannot share someone else's conversation");

  const shared = await request(`/api/consultations/${consultationId}/shares`, { method: 'POST', cookie: patient.cookie, json: { conversationId } });
  assert.equal(shared.status, 201);
  const shareId = (await shared.json()).shares[0].id;

  const doctorRead = await request(`/api/doctor/consultations/${consultationId}/shares/${shareId}`, { cookie: doctor.cookie });
  assert.equal(doctorRead.status, 200);
  assert.equal((await request(`/api/doctor/consultations/${consultationId}/shares/${shareId}`, { cookie: otherDoctor.cookie })).status, 404);
  assert.equal((await request(`/api/doctor/consultations/${consultationId}/shares/${shareId}`, { cookie: stranger.cookie })).status, 403);
  // Administrators cannot read conversations either.
  assert.equal((await request(`/api/conversations/${conversationId}/messages`, { cookie: admin.cookie })).status, 404);

  assert.equal((await request(`/api/consultations/${consultationId}/shares/${shareId}`, { method: 'DELETE', cookie: patient.cookie })).status, 200);
  assert.equal((await request(`/api/doctor/consultations/${consultationId}/shares/${shareId}`, { cookie: doctor.cookie })).status, 404);

  const actions = db.prepare("SELECT action FROM audit_logs WHERE action LIKE 'patient_record.%'").all().map((row) => row.action);
  assert.deepEqual(actions.sort(), ['patient_record.share_revoked', 'patient_record.shared', 'patient_record.viewed']);
});

test('suspension blocks existing sessions and sign-in until reinstated', async () => {
  const admin = await register('Suspend Admin', 'suspend-admin@example.test');
  grantAdmin(admin.user.id);
  const user = await register('Target User', 'target@example.test');

  assert.equal((await request(`/api/admin/users/${admin.user.id}/status`, {
    method: 'POST', cookie: admin.cookie, json: { status: 'suspended', reason: 'Self' }
  })).status, 403);
  assert.equal((await request(`/api/admin/users/${user.user.id}/status`, {
    method: 'POST', cookie: admin.cookie, json: { status: 'suspended', reason: 'Abuse report confirmed' }
  })).status, 200);
  assert.equal((await request('/api/session', { cookie: user.cookie })).status, 401);
  const login = await request('/api/auth/login', { method: 'POST', json: { email: 'target@example.test', password: 'correct horse battery' } });
  assert.equal(login.status, 403);

  assert.equal((await request(`/api/admin/users/${user.user.id}/status`, {
    method: 'POST', cookie: admin.cookie, json: { status: 'active' }
  })).status, 200);
  const relogin = await request('/api/auth/login', { method: 'POST', json: { email: 'target@example.test', password: 'correct horse battery' } });
  assert.equal(relogin.status, 200);

  const logs = await (await request('/api/admin/audit-logs', { cookie: admin.cookie })).json();
  assert.ok(logs.logs.some((log) => log.action === 'user.suspended'));
  assert.ok(logs.logs.some((log) => log.action === 'user.reinstated'));
});

test('only published content is visible and system settings control registration', async () => {
  const admin = await register('Content Admin', 'content-admin@example.test');
  grantAdmin(admin.user.id);
  const user = await register('Reader', 'reader@example.test');
  const draft = { category: 'relaxation', title: 'Box breathing', summary: '', body: 'Breathe in for four counts.', status: 'draft' };
  const created = await request('/api/admin/content', { method: 'POST', cookie: admin.cookie, json: draft });
  assert.equal(created.status, 201);
  const contentId = (await created.json()).content.id;
  assert.equal((await (await request('/api/content', { cookie: user.cookie })).json()).content.length, 0);
  await request(`/api/admin/content/${contentId}`, { method: 'PUT', cookie: admin.cookie, json: { ...draft, status: 'published' } });
  assert.equal((await (await request('/api/content?category=relaxation', { cookie: user.cookie })).json()).content.length, 1);
  assert.equal((await request('/api/admin/content', { method: 'POST', cookie: user.cookie, json: draft })).status, 403);

  assert.equal((await request('/api/admin/settings', {
    method: 'PUT', cookie: admin.cookie, json: { registrationOpen: true, doctorRegistrationOpen: false, announcement: '' }
  })).status, 200);
  const blocked = await request('/api/auth/register', {
    method: 'POST', json: { name: 'Late Doctor', email: 'late@example.test', password: 'correct horse battery', accountType: 'doctor' }
  });
  assert.equal(blocked.status, 403);
  await request('/api/admin/settings', {
    method: 'PUT', cookie: admin.cookie, json: { registrationOpen: true, doctorRegistrationOpen: true, announcement: '' }
  });
});

test('password change keeps the current session and signs out other sessions', async () => {
  const first = await register('Password User', 'password@example.test');
  const second = await request('/api/auth/login', { method: 'POST', json: { email: 'password@example.test', password: 'correct horse battery' } });
  const secondCookie = second.headers.get('set-cookie').match(/healix_session=[^;]+/)[0];
  assert.equal((await request('/api/account/password', {
    method: 'POST', cookie: first.cookie, json: { currentPassword: 'wrong password!!', newPassword: 'another long password' }
  })).status, 401);
  assert.equal((await request('/api/account/password', {
    method: 'POST', cookie: first.cookie, json: { currentPassword: 'correct horse battery', newPassword: 'another long password' }
  })).status, 200);
  assert.equal((await request('/api/session', { cookie: first.cookie })).status, 200);
  assert.equal((await request('/api/session', { cookie: secondCookie })).status, 401);
});

test('state-changing requests from another origin are rejected', async () => {
  const user = await register('Origin User', 'origin@example.test');
  const response = await request('/api/hydration', {
    method: 'POST', cookie: user.cookie, headers: { Origin: 'https://evil.example' }, json: { amountMl: 100 }
  });
  assert.equal(response.status, 403);
});
