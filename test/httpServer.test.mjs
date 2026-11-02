/**
 * Streamable HTTP server: configuration, origin and token checks, session ownership and lifecycle, rate limiting
 * and robustness, exercised over real HTTP on an ephemeral port.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { loadHttpConfig } from '../src/http/config.mjs';
import { createHttpApp } from '../src/http/app.mjs';
import { startHttpServer } from '../src/server.mjs';

const baseConfig = overrides => ({
  host: '127.0.0.1',
  port: 0,
  tokens: [{ name: 'mac', token: 'mac-secret-token' }, { name: 'hermes', token: 'hermes-secret-token' }],
  allowedOrigins: new Set(['https://allowed.test']),
  rateLimit: 1000,
  rateWindowMs: 60000,
  maxBodyBytes: 1024,
  trustProxy: false,
  sessionIdleMs: 60000,
  maxSessions: 10,
  ...overrides
});

const running = [];
after(async () => { await Promise.all(running.map(app => app.close())); });

async function serve(overrides) {
  const app = createHttpApp(baseConfig(overrides));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  running.push(app);
  return { app, url: `http://127.0.0.1:${app.server.address().port}` };
}

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } };

function post(url, body, headers = {}) {
  return fetch(`${url}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body)
  });
}

const bearer = token => ({ Authorization: `Bearer ${token}` });

async function openSession(url, token = 'mac-secret-token') {
  const response = await post(url, initialize, bearer(token));
  await response.text();
  assert.equal(response.status, 200);
  return response.headers.get('mcp-session-id');
}

describe('HTTP configuration', () => {
  it('listens on loopback by default and lets no browser origin in', () => {
    const config = loadHttpConfig({});
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.port, 3001);
    assert.deepEqual(config.tokens, []);
    assert.equal(config.allowedOrigins.size, 0);
  });

  it('refuses to listen beyond loopback without an access token', () => {
    assert.throws(() => loadHttpConfig({ HOST: '0.0.0.0' }), /Refusing to listen on 0\.0\.0\.0 without authentication/);
    assert.equal(loadHttpConfig({ HOST: '0.0.0.0', MCP_AUTH_TOKEN: 'secret' }).host, '0.0.0.0');
  });

  it('reads named tokens alongside the single default token', () => {
    const config = loadHttpConfig({ MCP_AUTH_TOKENS: 'mac:aaa, hermes:bbb', MCP_AUTH_TOKEN: 'ccc' });
    assert.deepEqual(config.tokens, [
      { name: 'mac', token: 'aaa' }, { name: 'hermes', token: 'bbb' }, { name: 'default', token: 'ccc' }
    ]);
  });

  for (const [env, pattern] of [
    [{ MCP_AUTH_TOKENS: 'mac:a,mac:b' }, /defined more than once/],
    [{ MCP_AUTH_TOKENS: 'no-separator' }, /name:token/],
    [{ PORT: 'abc' }, /PORT must be an integer/],
    [{ PORT: '70000' }, /PORT must be an integer from 0 to 65535/],
    [{ HULY_RATE_LIMIT: 'NaN' }, /HULY_RATE_LIMIT must be an integer/],
    [{ HULY_TRUST_PROXY: 'yes' }, /HULY_TRUST_PROXY must be true or false/],
    [{ HULY_MAX_SESSIONS: '0' }, /HULY_MAX_SESSIONS must be an integer from 1/]
  ]) {
    it(`rejects ${JSON.stringify(env)} at startup`, () => {
      assert.throws(() => loadHttpConfig(env), pattern);
    });
  }

  it('accepts PORT=0 as an explicit request for any free port', () => {
    assert.equal(loadHttpConfig({ PORT: '0' }).port, 0);
  });
});

describe('HTTP access', () => {
  it('rejects a browser origin that is not allowed, before anything else', async () => {
    const { url } = await serve();
    const response = await post(url, initialize, { ...bearer('mac-secret-token'), Origin: 'https://evil.test' });
    assert.equal(response.status, 403);
    const preflight = await fetch(`${url}/mcp`, { method: 'OPTIONS', headers: { Origin: 'https://evil.test' } });
    assert.equal(preflight.status, 403);
  });

  it('echoes an allowed origin and serves clients that send none', async () => {
    const { url } = await serve();
    const allowed = await post(url, initialize, { ...bearer('mac-secret-token'), Origin: 'https://allowed.test' });
    await allowed.text();
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.test');
    assert.ok(await openSession(url));
  });

  it('requires a valid access token', async () => {
    const { url } = await serve();
    assert.equal((await post(url, initialize)).status, 401);
    assert.equal((await post(url, initialize, bearer('wrong-token'))).status, 401);
    assert.ok(await openSession(url, 'hermes-secret-token'));
  });

  it('refuses a session presented with a different token than the one that opened it', async () => {
    const { url } = await serve();
    const sessionId = await openSession(url, 'mac-secret-token');
    const swapped = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...bearer('hermes-secret-token'), 'Mcp-Session-Id': sessionId });
    assert.equal(swapped.status, 403);
  });

  it('rate limits before checking the token, so guessing is limited too', async () => {
    const { url } = await serve({ rateLimit: 2 });
    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await post(url, initialize, bearer('guess'))).status);
    assert.deepEqual(statuses, [401, 401, 429]);
  });

  it('rate limits by the forwarded client address only behind a trusted proxy', async () => {
    const trusted = await serve({ rateLimit: 1, trustProxy: true });
    const first = await post(trusted.url, initialize, { 'X-Forwarded-For': '203.0.113.1' });
    const second = await post(trusted.url, initialize, { 'X-Forwarded-For': '203.0.113.2' });
    assert.deepEqual([first.status, second.status], [401, 401], 'different clients get separate windows');

    const direct = await serve({ rateLimit: 1 });
    await post(direct.url, initialize, { 'X-Forwarded-For': '203.0.113.1' });
    const spoofed = await post(direct.url, initialize, { 'X-Forwarded-For': '203.0.113.2' });
    assert.equal(spoofed.status, 429, 'an untrusted header must not buy a fresh window');
  });
});

describe('HTTP sessions', () => {
  it('answers an unknown or expired session with 404, including on DELETE', async () => {
    const { url } = await serve();
    const unknown = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...bearer('mac-secret-token'), 'Mcp-Session-Id': 'no-such-session' });
    assert.equal(unknown.status, 404);
    const deleted = await fetch(`${url}/mcp`, {
      method: 'DELETE', headers: { ...bearer('mac-secret-token'), 'Mcp-Session-Id': 'no-such-session' }
    });
    assert.equal(deleted.status, 404);
  });

  it('expires idle sessions', async () => {
    const { url, app } = await serve({ sessionIdleMs: 50 });
    const sessionId = await openSession(url);
    assert.equal(app.sessions.size, 1);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(app.sessions.size, 0);
    const later = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...bearer('mac-secret-token'), 'Mcp-Session-Id': sessionId });
    assert.equal(later.status, 404);
  });

  it('caps the number of open sessions', async () => {
    const { url } = await serve({ maxSessions: 1 });
    await openSession(url);
    const second = await post(url, initialize, bearer('mac-secret-token'));
    assert.equal(second.status, 503);
  });

  it('registers a session as soon as it is initialized', async () => {
    const { url, app } = await serve();
    const sessionId = await openSession(url);
    assert.ok(app.sessions.get(sessionId), 'the session must be usable by the very next request');
  });
});

describe('HTTP robustness', () => {
  it('answers bad requests with an error status and keeps serving', async () => {
    const { url } = await serve();
    assert.equal((await post(url, '{not json', bearer('mac-secret-token'))).status, 400);
    assert.equal((await post(url, JSON.stringify({ pad: 'x'.repeat(4096) }), bearer('mac-secret-token'))).status, 413);
    assert.equal((await post(url, initialize, { ...bearer('mac-secret-token'), 'Huly-Response-Mode': 'verbose' })).status, 400);
    const malformedHost = await new Promise(resolve => {
      const request = http.request(`${url}/mcp`, { method: 'GET', headers: { Host: '[::bad host' } }, resolve);
      request.on('error', () => resolve({ statusCode: 'error' }));
      request.end();
    });
    assert.notEqual(malformedHost.statusCode, undefined);
    assert.equal((await fetch(`${url}/health`)).status, 200, 'the server is still up');
  });

  it('reports health without revealing version or session count', async () => {
    const { url } = await serve();
    const health = await (await fetch(`${url}/health`)).json();
    assert.deepEqual(Object.keys(health).sort(), ['status', 'timestamp', 'transport']);
    assert.equal(health.status, 'ok');
  });

  it('does not echo the request path for unknown routes', async () => {
    const { url } = await serve();
    assert.deepEqual(await (await fetch(`${url}/secret-admin-path`)).json(), { error: 'Not found' });
  });

  it('exits with an error instead of moving to another port when the port is taken', async () => {
    const { app } = await serve();
    const { port } = app.server.address();
    await assert.rejects(() => startHttpServer(baseConfig({ port })), error => error.code === 'EADDRINUSE');
  });
});
