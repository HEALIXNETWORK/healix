const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-test-'));
process.env.NODE_ENV = 'test';
process.env.HEALIX_DATABASE_PATH = path.join(testDirectory, 'HEALIX-test.db');
process.env.SESSION_COOKIE_SECURE = 'false';

const { app } = require('../src/server');
const { db } = require('../src/db');
let server;
let baseUrl;

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

async function request(url, { cookie, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (cookie) headers.set('Cookie', cookie);
  return fetch(`${baseUrl}${url}`, { ...options, headers });
}

async function register(name, email) {
  const response = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password: 'correct horse battery' })
  });
  assert.equal(response.status, 201);
  const cookie = response.headers.get('set-cookie').match(/healix_session=([^;]+)/)[1];
  return { cookie, data: await response.json() };
}

test('accounts have isolated hydration and appointment data', async () => {
  const first = await register('First User', 'first@example.test');
  const second = await register('Second User', 'second@example.test');

  const createdRecord = await request('/api/hydration', {
    method: 'POST',
    cookie: first.cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ amountMl: 350 })
  });
  assert.equal(createdRecord.status, 201);
  const record = (await createdRecord.json()).record;

  const privateRecords = await request('/api/hydration', { cookie: second.cookie });
  assert.deepEqual(await privateRecords.json(), {
    date: new Date().toISOString().slice(0, 10),
    records: [],
    totalMl: 0
  });
  const cannotDelete = await request(`/api/hydration/${record.id}`, { method: 'DELETE', cookie: second.cookie });
  assert.equal(cannotDelete.status, 404);

  const appointment = await request('/api/appointments', {
    method: 'POST',
    cookie: first.cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Check-up', scheduledAt: '2030-01-10T10:00:00.000Z', notes: 'Bring questions' })
  });
  assert.equal(appointment.status, 201);
  const appointmentId = (await appointment.json()).appointment.id;
  const secondAppointments = await request('/api/appointments', { cookie: second.cookie });
  assert.deepEqual((await secondAppointments.json()).appointments, []);
  assert.equal((await request(`/api/appointments/${appointmentId}`, { method: 'DELETE', cookie: second.cookie })).status, 404);
});

test('registration validates credentials and account export is user-scoped', async () => {
  const weak = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Test User', email: 'weak@example.test', password: 'short' })
  });
  assert.equal(weak.status, 400);

  const account = await register('Export User', 'export@example.test');
  const created = await request('/api/conversations', { method: 'POST', cookie: account.cookie });
  assert.equal(created.status, 201);
  const conversationId = (await created.json()).conversation.id;
  const exported = await request('/api/account/export', { cookie: account.cookie });
  assert.equal(exported.status, 200);
  const data = await exported.json();
  assert.equal(data.user.email, 'export@example.test');
  assert.equal(data.conversations.length, 1);
  assert.equal(data.conversations[0].id, conversationId);

  const deleted = await request('/api/account', { method: 'DELETE', cookie: account.cookie });
  assert.equal(deleted.status, 200);
  assert.equal((await request('/api/session', { cookie: account.cookie })).status, 401);
});
