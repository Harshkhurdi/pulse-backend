const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../index');

// Ephemeral server shared by all HTTP tests. The app itself listens only
// when run directly (require.main === module), so tests own the port.
let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  return new Promise((resolve) => server.close(resolve));
});

async function req(method, path, { headers = {}, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON body is fine; callers assert on what they need.
  }
  return { status: res.status, headers: res.headers, json, text };
}

test('local configuration is complete', () => {
  assert.equal(app.pulseConfig.envOk, true);
  assert.deepEqual(app.pulseConfig.configurationIssues, []);
});

test('GET / serves the health payload', async () => {
  const { status, json } = await req('GET', '/');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.service, 'Pulse Backend API');
  assert.equal(json.envOk, true);
  assert.equal('configurationIssues' in json, false);
});

test('GET /api/health serves the same payload', async () => {
  const { status, json } = await req('GET', '/api/health');
  assert.equal(status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.envOk, true);
  assert.equal(typeof json.timestamp, 'string');
});

test('GET /favicon.ico is suppressed with 204', async () => {
  const { status } = await req('GET', '/favicon.ico');
  assert.equal(status, 204);
});

test('POST /api/generate-update without a token is 401', async () => {
  const { status, json } = await req('POST', '/api/generate-update', {
    body: { boardText: 'board', today: '2026-09-06' },
  });
  assert.equal(status, 401);
  assert.match(json.error, /Unauthorized/i);
});

test('POST /api/generate-update with a malformed token is 401', async () => {
  const { status, json } = await req('POST', '/api/generate-update', {
    headers: { Authorization: 'Bearer not.a.jwt' },
    body: { boardText: 'board', today: '2026-09-06' },
  });
  assert.equal(status, 401);
  assert.match(json.error, /Unauthorized/i);
});

test('auth runs before body validation (garbage token + empty body = 401, not 400)', async () => {
  const { status } = await req('POST', '/api/suggest-subtasks', {
    headers: { Authorization: 'Bearer garbage' },
    body: {},
  });
  assert.equal(status, 401);
});

test('CORS echoes an allowed origin', async () => {
  const { status, headers } = await req('GET', '/api/health', {
    headers: { Origin: 'http://localhost:5173' },
  });
  assert.equal(status, 200);
  assert.equal(headers.get('access-control-allow-origin'), 'http://localhost:5173');
});

test('CORS omits the allow header for disallowed origins', async () => {
  const { headers } = await req('GET', '/api/health', {
    headers: { Origin: 'http://evil.example' },
  });
  assert.equal(headers.get('access-control-allow-origin'), null);
});

test('CORS preflight for authenticated POST succeeds', async () => {
  const { status, headers } = await req('OPTIONS', '/api/generate-update', {
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
  assert.equal(status, 204);
  assert.match(headers.get('access-control-allow-methods'), /POST/);
  assert.match(headers.get('access-control-allow-headers'), /Authorization/i);
  assert.match(headers.get('access-control-allow-headers'), /Content-Type/i);
});

// Uses its own X-Forwarded-For identity so the earlier tests' requests
// (same server, default IP bucket) never drain this limit window.
test('rate limit allows 20 requests per minute then returns 429', async () => {
  const ip = '198.51.100.77';
  const headers = { 'X-Forwarded-For': ip };
  for (let i = 0; i < 20; i++) {
    const { status } = await req('GET', '/api/health', { headers });
    assert.equal(status, 200, `request ${i + 1} of 20 should pass`);
  }
  const { status, json } = await req('GET', '/api/health', { headers });
  assert.equal(status, 429);
  assert.match(json.error, /Too many requests/i);
});

test('rate limit buckets are per client IP', async () => {
  const { status } = await req('GET', '/api/health', {
    headers: { 'X-Forwarded-For': '198.51.100.78' },
  });
  assert.equal(status, 200);
});
