import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { EventEmitter } from 'events';

import {
  __resetForTests,
  createOutboundSocketFactory,
  ensureOutboundHeaders,
  getOutboundHeaders,
  registerOriginsFromServerConfig,
  registerOutboundOrigin
} from '../src/outboundHeaders.mjs';

const require = createRequire(import.meta.url);
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_STDERR_WRITE = process.stderr.write;
const ENV_PREFIX = 'HULY_OUTBOUND_HEADER_';

function clearOutboundEnv() {
  delete process.env.HULY_OUTBOUND_HEADERS_JSON;
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(ENV_PREFIX)) delete process.env[key];
  }
}

function setJson(value) {
  process.env.HULY_OUTBOUND_HEADERS_JSON = value;
}

function setHeadersEnv() {
  process.env.HULY_OUTBOUND_HEADERS_JSON = '{"X-API-Key":"secret"}';
}

function spyFetch() {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    return new Response('ok');
  };
  globalThis.fetch = fetch;
  return { fetch, calls };
}

beforeEach(() => {
  __resetForTests();
  clearOutboundEnv();
  globalThis.fetch = ORIGINAL_FETCH;
  process.stderr.write = () => true;
});

afterEach(() => {
  __resetForTests();
  clearOutboundEnv();
  globalThis.fetch = ORIGINAL_FETCH;
  process.stderr.write = ORIGINAL_STDERR_WRITE;
});

describe('outbound header parsing', () => {
  it('parses a valid JSON object into a Map', () => {
    setJson('{"X-API-Key":" secret ","X-Tenant":"team"}');

    const parsed = getOutboundHeaders();

    assert.equal(parsed.isEmpty, false);
    assert.equal(parsed.headers.get('X-API-Key'), 'secret');
    assert.equal(parsed.headers.get('X-Tenant'), 'team');
  });

  it('rejects invalid JSON with the env var name in the error', () => {
    setJson('{nope');

    assert.throws(() => getOutboundHeaders(), /HULY_OUTBOUND_HEADERS_JSON/);
  });

  it('rejects JSON values that are not objects', () => {
    for (const value of ['[]', '"x"', '1']) {
      __resetForTests();
      clearOutboundEnv();
      setJson(value);
      assert.throws(() => getOutboundHeaders(), /must be a JSON object/);
    }
  });

  it('parses discrete env vars with underscore-to-dash normalization', () => {
    process.env.HULY_OUTBOUND_HEADER_X_API_KEY = 'secret';

    const parsed = getOutboundHeaders();

    assert.equal(parsed.headers.get('X-API-KEY'), 'secret');
  });

  it('allows duplicate JSON and discrete headers with the same value', () => {
    setJson('{"X-API-Key":"secret"}');
    process.env.HULY_OUTBOUND_HEADER_X_API_KEY = ' secret ';

    const parsed = getOutboundHeaders();

    assert.equal(parsed.headers.get('X-API-Key'), 'secret');
  });

  it('rejects duplicate JSON and discrete headers with different values', () => {
    setJson('{"X-API-Key":"json-value"}');
    process.env.HULY_OUTBOUND_HEADER_X_API_KEY = 'env-value';

    assert.throws(() => getOutboundHeaders(), /Conflicting values/);
  });

  it('rejects duplicate headers case-insensitively', () => {
    setJson('{"x-api-key":"json-value"}');
    process.env.HULY_OUTBOUND_HEADER_X_API_KEY = 'env-value';

    assert.throws(() => getOutboundHeaders(), /Conflicting values/);
  });

  it('accepts RFC token header names including backtick', () => {
    setJson('{"X-Weird-`":"ok"}');

    assert.equal(getOutboundHeaders().headers.get('X-Weird-`'), 'ok');
  });

  it('rejects invalid header names', () => {
    for (const name of ['Bad Header', 'Bad:Header', 'Bad\nHeader', 'Bad(Header)', 'Bad@Header']) {
      __resetForTests();
      clearOutboundEnv();
      setJson(JSON.stringify({ [name]: 'x' }));
      assert.throws(() => getOutboundHeaders(), /invalid header name/);
    }
  });

  it('rejects invalid header values', () => {
    for (const value of ['bad\rvalue', 'bad\nvalue', 'bad\u0000value', 'bad\u00E9value']) {
      __resetForTests();
      clearOutboundEnv();
      setJson(JSON.stringify({ 'X-Test': value }));
      assert.throws(() => getOutboundHeaders(), /invalid value/);
    }
  });

  it('rejects empty header values after trimming', () => {
    setJson('{"X-Test":"   "}');

    assert.throws(() => getOutboundHeaders(), /empty value/);
  });

  it('rejects forbidden header names case-insensitively after normalization', () => {
    const cases = [
      () => { process.env.HULY_OUTBOUND_HEADER_AUTHORIZATION = 'x'; },
      () => setJson('{"authorization":"x"}'),
      () => setJson('{"Cookie":"x"}'),
      () => setJson('{"Proxy-Authorization":"x"}')
    ];

    for (const setup of cases) {
      __resetForTests();
      clearOutboundEnv();
      setup();
      assert.throws(() => getOutboundHeaders(), /forbidden outbound header/);
    }
  });
});

describe('outbound origin registration and fetch wrapping', () => {
  it('registers absolute origins and injects headers for string URLs', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://x.example.com/path?q=1');

    await fetch('https://x.example.com/other');

    const request = calls[0][0];
    assert.ok(request instanceof Request);
    assert.equal(request.url, 'https://x.example.com/other');
    assert.equal(request.headers.get('X-API-Key'), 'secret');
  });

  it('keeps ports in registered origins', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://x.example.com:8443/path');

    await fetch('https://x.example.com:8443/other');

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
  });

  it('registers websocket origins and their HTTP equivalents', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://seed.example.com');
    registerOutboundOrigin('wss://x.example.com/foo');
    registerOutboundOrigin('ws://y.example.com/foo');

    await fetch('https://x.example.com/other');
    await fetch('http://y.example.com/other');

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[1][0].headers.get('X-API-Key'), 'secret');
  });

  it('registers relative URLs against the Huly base URL', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://huly.example.com');
    registerOutboundOrigin('/files', 'https://huly.example.com');

    await fetch('https://huly.example.com/files');

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
  });

  it('registers URL-ish values from server config and ignores everything else', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://huly.example.com');
    registerOriginsFromServerConfig({
      ACCOUNTS_URL: 'https://accounts.example.com',
      COLLABORATOR_URL: 'wss://collab.example.com',
      REKONI_URL: 'https://rekoni.example.com',
      FILES_URL: '/files',
      UPLOAD_URL: null,
      PUSH_URL: 123,
      OTHER: 'https://ignored.example.com'
    }, 'https://huly.example.com');

    await fetch('https://accounts.example.com');
    await fetch('https://collab.example.com');
    await fetch('https://rekoni.example.com');
    await fetch('https://huly.example.com/files');
    await fetch('https://ignored.example.com');

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[1][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[2][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[3][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[4][0], 'https://ignored.example.com');
  });

  it('injects headers for URL and Request inputs without mutating the original Request', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://x.example.com');

    await fetch(new URL('https://x.example.com/url-object'));
    const originalRequest = new Request('https://x.example.com/request', {
      headers: { 'X-Original': 'yes' }
    });
    await fetch(originalRequest);

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[1][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[1][0].headers.get('X-Original'), 'yes');
    assert.equal(originalRequest.headers.has('X-API-Key'), false);
    assert.equal(originalRequest.bodyUsed, false);
  });

  it('honors fetch Request plus init precedence and never overwrites caller headers', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://x.example.com');

    const request = new Request('https://x.example.com/request', {
      headers: { 'X-A': 'req-val', 'x-api-key': 'caller-secret' }
    });
    await fetch(request, {
      method: 'POST',
      headers: { 'X-A': 'init-val' },
      body: 'hello'
    });

    const upstream = calls[0][0];
    assert.equal(upstream.method, 'POST');
    assert.equal(await upstream.text(), 'hello');
    assert.equal(upstream.headers.get('X-A'), 'init-val');
    assert.equal(upstream.headers.get('X-API-Key'), 'secret');
  });

  it('does not modify unregistered-origin fetch calls', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://x.example.com');

    await fetch('https://other.example.com/path', { headers: { 'X-Test': 'yes' } });

    assert.equal(calls[0][0], 'https://other.example.com/path');
    assert.deepEqual(calls[0][1], { headers: { 'X-Test': 'yes' } });
  });

  it('preserves caller-provided outbound headers in any case', async () => {
    for (const callerName of ['X-API-Key', 'x-api-key', 'X-API-KEY']) {
      __resetForTests();
      clearOutboundEnv();
      setHeadersEnv();
      const { calls } = spyFetch();
      ensureOutboundHeaders('https://x.example.com');

      await fetch('https://x.example.com/path', { headers: { [callerName]: 'caller' } });

      assert.equal(calls[0][0].headers.get('X-API-Key'), 'caller');
    }
  });

  it('installs the fetch wrapper only once', () => {
    setHeadersEnv();
    spyFetch();
    ensureOutboundHeaders('https://one.example.com');
    const wrapped = globalThis.fetch;

    ensureOutboundHeaders('https://two.example.com');

    assert.equal(globalThis.fetch, wrapped);
    assert.equal(globalThis.fetch[Symbol.for('huly.outboundFetchWrapper')], true);
  });

  it('logs configured header names to stderr once without values', () => {
    setHeadersEnv();
    spyFetch();
    const writes = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...args) => {
      writes.push(String(chunk));
      if (typeof args.at(-1) === 'function') args.at(-1)();
      return true;
    };

    try {
      ensureOutboundHeaders('https://one.example.com/path');
      ensureOutboundHeaders('https://two.example.com/path');
    } finally {
      process.stderr.write = originalWrite;
    }

    assert.equal(writes.length, 1);
    assert.match(writes[0], /\[huly-mcp\] outbound headers configured: \[X-API-Key\]/);
    assert.match(writes[0], /seeded origin: https:\/\/one\.example\.com/);
    assert.doesNotMatch(writes[0], /secret/);
  });

  it('preserves method, signal, body, and headers end-to-end', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    const controller = new AbortController();
    ensureOutboundHeaders('https://x.example.com');

    await fetch('https://x.example.com/path', {
      method: 'POST',
      signal: controller.signal,
      body: 'payload',
      headers: { 'X-Other': 'value' }
    });

    const request = calls[0][0];
    assert.equal(request.method, 'POST');
    assert.equal(request.signal.aborted, false);
    controller.abort();
    assert.equal(request.signal.aborted, true);
    assert.equal(await request.text(), 'payload');
    assert.equal(request.headers.get('X-Other'), 'value');
    assert.equal(request.headers.get('X-API-Key'), 'secret');
  });

  it('does not install a wrapper when no outbound headers are configured', () => {
    const { fetch: original } = spyFetch();

    ensureOutboundHeaders('https://x.example.com');

    assert.equal(globalThis.fetch, original);
  });

  it('supports multiple client origins through the same global wrapper', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://one.example.com');
    const wrapped = globalThis.fetch;
    ensureOutboundHeaders('https://two.example.com');

    await fetch('https://one.example.com/path');
    await fetch('https://two.example.com/path');

    assert.equal(globalThis.fetch, wrapped);
    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
    assert.equal(calls[1][0].headers.get('X-API-Key'), 'secret');
  });

  it('reset restores the original fetch reference and allows clean reinstall', async () => {
    setHeadersEnv();
    const { calls } = spyFetch();
    ensureOutboundHeaders('https://one.example.com');
    const wrapped = globalThis.fetch;

    __resetForTests();

    assert.notEqual(globalThis.fetch, wrapped);
    clearOutboundEnv();
    setHeadersEnv();
    ensureOutboundHeaders('https://two.example.com');
    await fetch('https://two.example.com/path');

    assert.equal(calls[0][0].headers.get('X-API-Key'), 'secret');
  });
});

describe('outbound websocket factory', () => {
  let wsPath;
  let previousWsCache;

  class MockWebSocket extends EventEmitter {
    static calls = [];
    static instances = [];

    constructor(url, protocols, options) {
      super();
      this.url = url;
      this.protocols = protocols;
      this.options = options;
      this.readyState = 1;
      this.sent = [];
      this.closedWith = null;
      MockWebSocket.calls.push([url, protocols, options]);
      MockWebSocket.instances.push(this);
    }

    send(data) {
      this.sent.push(data);
    }

    close(code) {
      this.closedWith = code;
    }
  }

  beforeEach(() => {
    wsPath = require.resolve('ws');
    previousWsCache = require.cache[wsPath];
    MockWebSocket.calls = [];
    MockWebSocket.instances = [];
    require.cache[wsPath] = {
      id: wsPath,
      filename: wsPath,
      loaded: true,
      exports: MockWebSocket
    };
  });

  afterEach(() => {
    if (previousWsCache) {
      require.cache[wsPath] = previousWsCache;
    } else {
      delete require.cache[wsPath];
    }
  });

  it('returns null when no headers are configured', () => {
    assert.equal(createOutboundSocketFactory(), null);
  });

  it('passes headers to registered websocket origins only', () => {
    setHeadersEnv();
    ensureOutboundHeaders('https://huly.example.com');
    registerOutboundOrigin('wss://ws.example.com');

    const factory = createOutboundSocketFactory();
    factory('wss://ws.example.com/path');
    factory('wss://other.example.com/path');

    assert.deepEqual(MockWebSocket.calls[0], [
      'wss://ws.example.com/path',
      undefined,
      { headers: { 'X-API-Key': 'secret' } }
    ]);
    assert.deepEqual(MockWebSocket.calls[1], [
      'wss://other.example.com/path',
      undefined,
      undefined
    ]);
  });

  it('returns a browser-like socket wrapper and dispatches events', async () => {
    setHeadersEnv();
    ensureOutboundHeaders('https://huly.example.com');
    registerOutboundOrigin('wss://ws.example.com');

    const socket = createOutboundSocketFactory()('wss://ws.example.com/path');
    const ws = MockWebSocket.instances[0];
    const events = [];
    socket.onopen = (event) => events.push(event.type);
    socket.onmessage = (event) => {
      events.push(event.type);
      assert.ok(event.data instanceof ArrayBuffer);
    };
    socket.onclose = (event) => {
      events.push(event.type);
      assert.equal(event.code, 1000);
      assert.equal(event.wasClean, true);
    };
    socket.onerror = (event) => {
      events.push(event.type);
      assert.equal(event.error.message, 'boom');
    };

    ws.emit('open');
    ws.emit('message', Buffer.from('abc'));
    ws.emit('close', 1000, 'done');
    ws.emit('error', new Error('boom'));
    socket.send('hello');
    socket.close(1001);

    assert.equal(socket.readyState, 1);
    assert.deepEqual(events, ['open', 'message', 'close', 'error']);
    assert.deepEqual(ws.sent, ['hello']);
    assert.equal(ws.closedWith, 1001);

    socket.send(new Blob(['blob']));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(ws.sent[1] instanceof ArrayBuffer);
  });
});
