import test from 'node:test';
import assert from 'node:assert/strict';
import { createProxyServer } from './server.mjs';

async function serve(server, run) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run('http://127.0.0.1:' + server.address().port); }
  finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

const origin = 'https://studio.example';
const payload = (url = 'https://example.com/data') => ({
  url, method: 'GET', headers: { accept: 'text/plain' }, body: ''
});

test('proxies an allowlisted request and returns CORS headers', async () => {
  let called;
  const server = createProxyServer({
    allowedHosts: ['example.com'], allowedOrigins: [origin],
    upstream: async (url, options, address) => {
      called = { url: url.href, method: options.method, address };
      return { status: 200, statusText: 'OK', headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') };
    },
  });
  await serve(server, async base => {
    const response = await fetch(base + '/v1/fetch', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(called.url, 'https://example.com/data');
    assert.equal(called.method, 'GET');
    assert.equal(result.status, 200);
    assert.equal(Buffer.from(result.body, 'base64').toString(), 'ok');
  });
});

test('rejects hosts outside the allowlist without contacting upstream', async () => {
  let called = false;
  const server = createProxyServer({
    allowedHosts: ['example.com'], allowedOrigins: [origin],
    upstream: async () => { called = true; throw new Error('unexpected upstream call'); },
  });
  await serve(server, async base => {
    const response = await fetch(base + '/v1/fetch', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload('https://not-allowed.example/')),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /allowlist/);
    assert.equal(called, false);
  });
});

test('rejects redirects outside the allowlist', async () => {
  let calls = 0;
  const server = createProxyServer({
    allowedHosts: ['example.com'], allowedOrigins: [origin],
    upstream: async () => {
      calls++;
      return { status: 302, statusText: 'Found', headers: { location: 'https://other.example/' }, body: Buffer.alloc(0) };
    },
  });
  await serve(server, async base => {
    const response = await fetch(base + '/v1/fetch', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /allowlist/);
    assert.equal(calls, 1);
  });
});

test('rejects browser origins not explicitly configured', async () => {
  let called = false;
  const server = createProxyServer({
    allowedHosts: ['example.com'], allowedOrigins: [origin],
    upstream: async () => { called = true; throw new Error('unexpected upstream call'); },
  });
  await serve(server, async base => {
    const response = await fetch(base + '/v1/fetch', {
      method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    assert.equal(response.status, 403);
    assert.equal(called, false);
  });
});

test('limits requests from one client', async () => {
  let calls = 0;
  const server = createProxyServer({
    allowedHosts: ['example.com'], allowedOrigins: [origin], rateLimit: 1,
    upstream: async () => {
      calls++;
      return { status: 200, statusText: 'OK', headers: {}, body: Buffer.alloc(0) };
    },
  });
  await serve(server, async base => {
    const request = () => fetch(base + '/v1/fetch', {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(payload()),
    });
    assert.equal((await request()).status, 200);
    const limited = await request();
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    assert.equal(calls, 1);
  });
});

test('refuses wildcard host and origin configuration', () => {
  assert.throws(() => createProxyServer({ allowedHosts: ['*'], allowedOrigins: [origin] }), /exact DNS names/);
  assert.throws(() => createProxyServer({ allowedHosts: ['example.com'], allowedOrigins: ['*'] }), /exact HTTP\(S\) origins/);
});
