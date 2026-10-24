const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

// Must be called before requiring the server so the test database and upload folder are used.
function useTemporaryStorage() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healix-test-'));
  process.env.NODE_ENV = 'test';
  process.env.HEALIX_DATABASE_PATH = path.join(directory, 'HEALIX-test.db');
  process.env.HEALIX_UPLOAD_PATH = path.join(directory, 'uploads');
  process.env.SESSION_COOKIE_SECURE = 'false';
  process.env.AUTH_RATE_LIMIT_MAX = '1000';
  delete process.env.AI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  return directory;
}

function createClient(getBaseUrl) {
  async function request(url, { cookie, json, ...options } = {}) {
    const headers = new Headers(options.headers || {});
    if (cookie) headers.set('Cookie', cookie);
    if (json !== undefined) {
      headers.set('Content-Type', 'application/json');
      options.body = JSON.stringify(json);
    }
    return fetch(`${getBaseUrl()}${url}`, { ...options, headers });
  }

  async function register(name, email, accountType = 'patient') {
    const response = await request('/api/auth/register', {
      method: 'POST',
      json: { name, email, password: 'correct horse battery', accountType }
    });
    assert.equal(response.status, 201);
    const cookie = response.headers.get('set-cookie').match(/healix_session=[^;]+/)[0];
    return { cookie, ...(await response.json()) };
  }

  return { request, register };
}

module.exports = { useTemporaryStorage, createClient };
