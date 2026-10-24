const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert/strict');
const { useTemporaryStorage, createClient } = require('./helpers');

const testDirectory = useTemporaryStorage();
const { app } = require('../src/server');
const { db, uploadsPath } = require('../src/db');

let server;
let baseUrl;
const client = createClient(() => baseUrl);
const { request } = client;

// Chat users agree to share messages with the AI provider, as the UI asks them to on first send.
async function register(...args) {
  const account = await client.register(...args);
  const consent = await request('/api/settings/ai-consent', { method: 'PUT', cookie: account.cookie, json: { consent: true } });
  assert.equal(consent.status, 200);
  return account;
}

// A local stand-in for an OpenAI-compatible endpoint, so the real provider integration code runs
// end to end without network access or credentials. The app itself never fabricates replies.
let provider;
let providerUrl;
const providerRequests = [];
let providerStatus = 200;
let geminiResponse = null;
const busyModels = new Set();

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const PDF = Buffer.from('%PDF-1.4\nlab report\n');

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  provider = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      providerRequests.push({ url: req.url, authorization: req.headers.authorization, googKey: req.headers['x-goog-api-key'], body: JSON.parse(body) });
      if ([...busyModels].some((model) => req.url.includes(`/models/${model}:`))) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 503, message: 'high demand' } }));
      }
      res.writeHead(providerStatus, { 'Content-Type': 'application/json' });
      if (providerStatus !== 200) return res.end(JSON.stringify({ error: { message: 'upstream failure' } }));
      if (req.url.includes(':generateContent')) {
        return res.end(JSON.stringify(geminiResponse || { candidates: [{ content: { role: 'model', parts: [{ text: `Gemini reply ${providerRequests.length}` }] }, finishReason: 'STOP' }] }));
      }
      return res.end(JSON.stringify({ choices: [{ message: { content: `Provider reply ${providerRequests.length}` } }] }));
    });
  });
  provider.listen(0);
  await new Promise((resolve) => provider.once('listening', resolve));
  providerUrl = `http://127.0.0.1:${provider.address().port}/v1`;
});

beforeEach(() => {
  process.env.AI_PROVIDER = 'openai-compatible';
  process.env.AI_API_KEY = 'test-key';
  process.env.AI_BASE_URL = providerUrl;
  process.env.AI_MODEL = 'test-model';
  delete process.env.AI_IMAGE_INPUT;
  delete process.env.AI_PDF_INPUT;
  providerStatus = 200;
  geminiResponse = null;
  busyModels.clear();
  delete process.env.AI_FALLBACK_MODELS;
  providerRequests.length = 0;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await new Promise((resolve) => provider.close(resolve));
  db.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

async function newConversation(cookie) {
  return (await (await request('/api/conversations', { method: 'POST', cookie })).json()).conversation.id;
}

function send(cookie, conversationId, content, extra = {}) {
  return request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', cookie, json: { content, clientRequestId: extra.clientRequestId || crypto.randomUUID(), ...extra }
  });
}

function upload(cookie, body, type, name = 'file') {
  return request('/api/attachments', { method: 'POST', cookie, headers: { 'Content-Type': type, 'X-File-Name': name }, body });
}

test('without AI credentials chat reports setup is required and stores no reply', async () => {
  delete process.env.AI_API_KEY;
  const user = await register('No Key', 'nokey@example.test');
  const config = await (await request('/api/config')).json();
  assert.equal(config.aiConfigured, false);
  const conversationId = await newConversation(user.cookie);
  const response = await send(user.cookie, conversationId, 'What is hydration?');
  assert.equal(response.status, 503);
  assert.equal(providerRequests.length, 0);
  const messages = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.deepEqual(messages.messages, []);
});

test('configured provider replies are persisted with the safety prompt and history', async () => {
  const user = await register('Chat User', 'chat@example.test');
  const other = await register('Other Chat', 'otherchat@example.test');
  const conversationId = await newConversation(user.cookie);

  const first = await send(user.cookie, conversationId, 'Can I take ibuprofen for a headache?');
  assert.equal(first.status, 200);
  const reply = (await first.json()).message;
  assert.equal(reply.content, 'Provider reply 1');
  assert.equal(providerRequests[0].url, '/v1/chat/completions');
  assert.equal(providerRequests[0].authorization, 'Bearer test-key');
  assert.equal(providerRequests[0].body.model, 'test-model');
  const systemPrompt = providerRequests[0].body.messages[0];
  assert.equal(systemPrompt.role, 'system');
  assert.match(systemPrompt.content, /do not prescribe/i);
  assert.match(systemPrompt.content, /emergency services/i);

  await send(user.cookie, conversationId, 'I am also taking another medicine.');
  assert.deepEqual(providerRequests[1].body.messages.slice(1).map((message) => message.role), ['user', 'assistant', 'user']);

  const history = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.equal(history.messages.length, 4);
  const list = await (await request('/api/conversations', { cookie: user.cookie })).json();
  assert.equal(list.conversations[0].title, 'Can I take ibuprofen for a headache?');

  assert.equal((await request(`/api/messages/${reply.id}/feedback`, { method: 'PUT', cookie: user.cookie, json: { feedback: 'helpful' } })).status, 200);
  assert.equal((await request(`/api/messages/${reply.id}/feedback`, { method: 'PUT', cookie: other.cookie, json: { feedback: 'not_helpful' } })).status, 404);
  assert.equal((await request(`/api/conversations/${conversationId}/messages`, { cookie: other.cookie })).status, 404);
  assert.equal((await send(other.cookie, conversationId, 'Intrusion')).status, 404);

  const report = await request('/api/reports', { method: 'POST', cookie: user.cookie, json: { targetType: 'message', targetId: reply.id, reason: 'Inaccurate' } });
  assert.equal(report.status, 201);
  assert.equal((await request('/api/reports', { method: 'POST', cookie: other.cookie, json: { targetType: 'message', targetId: reply.id, reason: 'x' } })).status, 404);
});

test('provider failures return an error, keep the question, and can be retried', async () => {
  const user = await register('Retry User', 'retry@example.test');
  const conversationId = await newConversation(user.cookie);
  providerStatus = 500;
  const failed = await send(user.cookie, conversationId, 'Explain blood pressure', { clientRequestId: 'retry-1' });
  assert.equal(failed.status, 502);
  let history = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.deepEqual(history.messages.map((message) => message.role), ['user']);

  providerStatus = 200;
  const retried = await send(user.cookie, conversationId, 'Explain blood pressure', { clientRequestId: 'retry-1' });
  assert.equal(retried.status, 200);
  history = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.deepEqual(history.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal((await send(user.cookie, conversationId, 'Different text', { clientRequestId: 'retry-1' })).status, 409);
});

test('attachments are validated by content, private to their owner, and limited by provider capability', async () => {
  const user = await register('Attach User', 'attach@example.test');
  const other = await register('Attach Other', 'attachother@example.test');

  assert.equal((await upload(user.cookie, PNG, 'image/jpeg')).status, 415, 'declared type must match content');
  assert.equal((await upload(user.cookie, Buffer.from('MZ executable'), 'application/pdf')).status, 415);
  assert.equal((await upload(user.cookie, Buffer.from('plain text'), 'text/plain')).status, 415);
  assert.equal((await upload(user.cookie, Buffer.alloc(9 * 1024 * 1024, 1), 'image/png')).status, 413);
  assert.equal((await request('/api/attachments', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: PNG })).status, 401);

  const uploaded = await upload(user.cookie, PNG, 'image/png', encodeURIComponent('../../rash photo.png'));
  assert.equal(uploaded.status, 201);
  const image = (await uploaded.json()).attachment;
  assert.equal(image.name, '.._.._rash photo.png');
  const content = await request(`/api/attachments/${image.id}/content`, { cookie: user.cookie });
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), PNG);
  assert.equal((await request(`/api/attachments/${image.id}/content`, { cookie: other.cookie })).status, 404);

  const conversationId = await newConversation(user.cookie);
  const otherConversation = await newConversation(other.cookie);
  assert.equal((await send(other.cookie, otherConversation, 'Look', { attachmentIds: [image.id] })).status, 400, "cannot use someone else's file");

  const disabled = await send(user.cookie, conversationId, 'What is this rash?', { attachmentIds: [image.id] });
  assert.equal(disabled.status, 422);
  assert.equal(providerRequests.length, 0);

  process.env.AI_IMAGE_INPUT = 'true';
  const config = await (await request('/api/config')).json();
  assert.equal(config.aiImages, true);
  assert.equal(config.aiDocuments, false);
  const sent = await send(user.cookie, conversationId, 'What is this rash?', { attachmentIds: [image.id] });
  assert.equal(sent.status, 200);
  const parts = providerRequests[0].body.messages.at(-1).content;
  assert.equal(parts[0].type, 'text');
  assert.equal(parts[1].type, 'image_url');
  assert.equal(parts[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`);
  const history = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.equal(history.messages[0].attachments[0].id, image.id);
  assert.equal((await request(`/api/attachments/${image.id}`, { method: 'DELETE', cookie: user.cookie })).status, 404, 'sent files are removed with the conversation');

  await send(user.cookie, conversationId, 'Thanks');
  assert.equal(typeof providerRequests[1].body.messages[1].content, 'string', 'earlier images are not re-sent');
  assert.match(providerRequests[1].body.messages[1].content, /not re-sent/);

  const pdf = (await (await upload(user.cookie, PDF, 'application/pdf', 'labs.pdf')).json()).attachment;
  assert.equal((await send(user.cookie, conversationId, 'Explain my labs', { attachmentIds: [pdf.id] })).status, 422);
  process.env.AI_PDF_INPUT = 'true';
  assert.equal((await send(user.cookie, conversationId, 'Explain my labs', { attachmentIds: [pdf.id] })).status, 200);
  assert.equal(providerRequests.at(-1).body.messages.at(-1).content[1].type, 'file');

  const storedFile = path.join(uploadsPath, user.user.id, image.id);
  assert.ok(fs.existsSync(storedFile));
  assert.equal((await request(`/api/conversations/${conversationId}`, { method: 'DELETE', cookie: user.cookie })).status, 200);
  assert.equal(fs.existsSync(storedFile), false);
  assert.equal(db.prepare('SELECT COUNT(*) AS total FROM attachments WHERE user_id = ?').get(user.user.id).total, 0);

  const leftover = (await (await upload(user.cookie, PNG, 'image/png')).json()).attachment;
  assert.equal((await request('/api/account', { method: 'DELETE', cookie: user.cookie })).status, 200);
  assert.equal(fs.existsSync(path.join(uploadsPath, user.user.id, leftover.id)), false);
});

test('Gemini provider sends native requests with images and handles blocked replies', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_MODEL = 'gemini-test';
  process.env.AI_BASE_URL = providerUrl.replace(/\/v1$/, '/v1beta');
  const config = await (await request('/api/config')).json();
  assert.equal(config.aiImages, true, 'Gemini reads images by default');
  assert.equal(config.aiDocuments, true, 'Gemini reads PDFs by default');

  const user = await register('Gemini User', 'gemini@example.test');
  const conversationId = await newConversation(user.cookie);
  assert.equal((await send(user.cookie, conversationId, 'Hello')).status, 200);
  const image = (await (await upload(user.cookie, PNG, 'image/png', 'skin.png')).json()).attachment;
  const reply = await send(user.cookie, conversationId, 'What is this?', { attachmentIds: [image.id] });
  assert.equal(reply.status, 200);
  assert.equal((await reply.json()).message.content, 'Gemini reply 2');

  const sent = providerRequests[1];
  assert.equal(sent.url, '/v1beta/models/gemini-test:generateContent');
  assert.equal(sent.googKey, 'test-key');
  assert.equal(sent.authorization, undefined, 'key is not sent as a bearer token');
  assert.match(sent.body.systemInstruction.parts[0].text, /do not prescribe/i);
  assert.deepEqual(sent.body.contents.map((content) => content.role), ['user', 'model', 'user']);
  assert.deepEqual(sent.body.contents[2].parts[1], { inlineData: { mimeType: 'image/png', data: PNG.toString('base64') } });

  geminiResponse = { promptFeedback: { blockReason: 'SAFETY' } };
  const blocked = await send(user.cookie, conversationId, 'Blocked question');
  assert.equal(blocked.status, 422);
  const history = await (await request(`/api/conversations/${conversationId}/messages`, { cookie: user.cookie })).json();
  assert.equal(history.messages.at(-1).role, 'user', 'no assistant message is stored for a blocked reply');

  geminiResponse = null;
  assert.equal((await send(user.cookie, conversationId, 'Follow-up')).status, 200);
  const merged = providerRequests.at(-1).body.contents;
  assert.deepEqual(merged.map((content) => content.role), ['user', 'model', 'user', 'model', 'user'], 'consecutive user turns are merged');

  process.env.AI_IMAGE_INPUT = 'false';
  assert.equal((await (await request('/api/config')).json()).aiImages, false);
});

test('chat requires recorded AI consent, which survives other settings changes and can be withdrawn', async () => {
  const user = await client.register('Consent User', 'consent@example.test');
  const conversationId = await newConversation(user.cookie);
  assert.equal((await send(user.cookie, conversationId, 'Hello')).status, 403);
  assert.equal(providerRequests.length, 0);

  await request('/api/settings/ai-consent', { method: 'PUT', cookie: user.cookie, json: { consent: true } });
  await request('/api/settings', { method: 'PUT', cookie: user.cookie, json: { speechEnabled: true, hydrationGoalMl: 2000 } });
  const session = await (await request('/api/session', { cookie: user.cookie })).json();
  assert.equal(session.settings.aiConsent, true);
  assert.equal((await send(user.cookie, conversationId, 'Hello')).status, 200);

  await request('/api/settings/ai-consent', { method: 'PUT', cookie: user.cookie, json: { consent: false } });
  assert.equal((await send(user.cookie, conversationId, 'Again')).status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action LIKE 'privacy.ai_consent_%' AND target_id = ?").get(user.user.id).total, 2);
});

test('Gemini falls back to the next model when the main model is busy', async () => {
  process.env.AI_PROVIDER = 'gemini';
  process.env.AI_MODEL = 'main-model';
  process.env.AI_FALLBACK_MODELS = 'backup-model';
  process.env.AI_BASE_URL = providerUrl.replace(/\/v1$/, '/v1beta');
  const user = await register('Fallback User', 'fallback@example.test');
  const conversationId = await newConversation(user.cookie);

  busyModels.add('main-model');
  const reply = await send(user.cookie, conversationId, 'Are you there?');
  assert.equal(reply.status, 200);
  assert.deepEqual(providerRequests.map((item) => item.url.match(/models\/([^:]+)/)[1]), ['main-model', 'backup-model']);

  busyModels.add('backup-model');
  const unavailable = await send(user.cookie, conversationId, 'And now?');
  assert.equal(unavailable.status, 503);
  assert.match((await unavailable.json()).error, /busy/i);
});
