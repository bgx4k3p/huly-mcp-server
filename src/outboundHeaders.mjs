/**
 * Scoped outbound header injection for protected Huly deployments.
 *
 * Outbound headers are sent ONLY to:
 *   - HULY_URL (caller-provided)
 *   - origins advertised by Huly's own /config.json response (*_URL fields)
 *
 * This is a TRUST DELEGATION, not a guarantee of safety. If an operator's
 * /config.json advertises a *_URL pointing to a third-party origin they do
 * not control (e.g., a public CDN, a vendor SaaS), the configured outbound
 * headers WILL be sent to that origin. Gateway credentials (CF Access
 * service tokens, X-API-Key, etc.) are bearer-style secrets; transmitting
 * them to an untrusted origin is a credential leak.
 *
 * OPERATOR REQUIREMENT: ensure every *_URL value in your Huly server's
 * config.json points to an origin you control and trust to receive these
 * headers.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_VALUE_RE = /^[\x20-\x7E\t]*$/;
const OUTBOUND_HEADER_PREFIX = 'HULY_OUTBOUND_HEADER_';
const FETCH_WRAPPER_SYMBOL = Symbol.for('huly.outboundFetchWrapper');
const BANNED_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization']);

let _parsed = null;
let _wrapperInstalled = false;
let _originalFetch = null;
let _startupLogged = false;
const _allowedOrigins = new Set();

function normalizeHeaderKey(name) {
  return name.toLowerCase();
}

function validateHeaderName(name, source) {
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(`${source} contains invalid header name: ${name}`);
  }
  if (BANNED_HEADERS.has(normalizeHeaderKey(name))) {
    throw new Error(`${source} cannot set forbidden outbound header: ${name}`);
  }
}

function validateHeaderValue(value, source, name) {
  if (!HEADER_VALUE_RE.test(value)) {
    throw new Error(`${source} contains invalid value for outbound header: ${name}`);
  }
}

function addHeader(map, seen, name, value, source) {
  const headerName = String(name);
  const headerValue = String(value).trim();
  const key = normalizeHeaderKey(headerName);

  validateHeaderName(headerName, source);
  if (headerValue === '') {
    throw new Error(`${source} sets empty value for outbound header: ${headerName}`);
  }
  validateHeaderValue(headerValue, source, headerName);

  if (seen.has(key)) {
    const existing = seen.get(key);
    if (existing.value !== headerValue) {
      throw new Error(`Conflicting values for outbound header ${headerName}`);
    }
    return;
  }

  seen.set(key, { name: headerName, value: headerValue });
  map.set(headerName, headerValue);
}

function parseJsonHeaders(map, seen) {
  const raw = process.env.HULY_OUTBOUND_HEADERS_JSON;
  if (raw === undefined || raw === '') return;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`HULY_OUTBOUND_HEADERS_JSON must be a valid JSON object: ${error.message}`);
  }

  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('HULY_OUTBOUND_HEADERS_JSON must be a JSON object');
  }

  for (const [name, value] of Object.entries(parsed)) {
    addHeader(map, seen, name, value, 'HULY_OUTBOUND_HEADERS_JSON');
  }
}

function parseDiscreteHeaders(map, seen) {
  for (const [envName, value] of Object.entries(process.env)) {
    if (!envName.startsWith(OUTBOUND_HEADER_PREFIX)) continue;
    const suffix = envName.slice(OUTBOUND_HEADER_PREFIX.length);
    if (!suffix) {
      throw new Error(`${OUTBOUND_HEADER_PREFIX} entries must include a header name suffix`);
    }
    const headerName = suffix.replaceAll('_', '-');
    addHeader(map, seen, headerName, value ?? '', envName);
  }
}

export function getOutboundHeaders() {
  if (_parsed) return _parsed;

  const headers = new Map();
  const seen = new Map();
  parseJsonHeaders(headers, seen);
  parseDiscreteHeaders(headers, seen);

  _parsed = { headers, isEmpty: headers.size === 0 };
  return _parsed;
}

function originFor(url, baseUrl) {
  return new URL(url, baseUrl).origin;
}

function registerOriginPair(origin) {
  _allowedOrigins.add(origin);
  if (origin.startsWith('wss://')) {
    _allowedOrigins.add(`https://${origin.slice('wss://'.length)}`);
  } else if (origin.startsWith('ws://')) {
    _allowedOrigins.add(`http://${origin.slice('ws://'.length)}`);
  }
}

export function registerOutboundOrigin(url, baseUrl) {
  if (!url) return;
  registerOriginPair(originFor(url, baseUrl));
}

export function registerOriginsFromServerConfig(config, hulyUrl) {
  if (!config || typeof config !== 'object') return;

  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith('_URL') || typeof value !== 'string' || value.trim() === '') continue;
    registerOutboundOrigin(value, hulyUrl);
  }
}

function requestOrigin(input) {
  if (input instanceof Request) return new URL(input.url).origin;
  return new URL(input).origin;
}

function withOutboundHeaders(request) {
  const { headers } = getOutboundHeaders();
  if (!request.headers.has('Accept-Encoding')) {
    request.headers.set('Accept-Encoding', 'identity');
  }
  for (const [name, value] of headers) {
    if (!request.headers.has(name)) {
      request.headers.set(name, value);
    }
  }
  return request;
}

function installOutboundFetchWrapper() {
  if (_wrapperInstalled) return;
  if (globalThis.fetch?.[FETCH_WRAPPER_SYMBOL]) {
    _wrapperInstalled = true;
    return;
  }

  _originalFetch = globalThis.fetch;
  if (typeof _originalFetch !== 'function') {
    throw new Error('globalThis.fetch is not available; cannot install Huly outbound header wrapper');
  }

  const wrappedFetch = async (input, init) => {
    const origin = requestOrigin(input);
    if (!_allowedOrigins.has(origin)) {
      return _originalFetch(input, init);
    }

    const merged = new Request(input, init);
    return _originalFetch(withOutboundHeaders(merged));
  };

  Object.defineProperty(wrappedFetch, FETCH_WRAPPER_SYMBOL, {
    value: true,
    enumerable: false
  });

  globalThis.fetch = wrappedFetch;
  _wrapperInstalled = true;
}

export function ensureOutboundHeaders(hulyUrl) {
  const parsed = getOutboundHeaders();
  installOutboundFetchWrapper();
  registerOutboundOrigin(hulyUrl);
  if (!parsed.isEmpty && !_startupLogged) {
    const headerNames = [...parsed.headers.keys()].join(', ');
    process.stderr.write(`[huly-mcp] outbound headers configured: [${headerNames}]; seeded origin: ${originFor(hulyUrl)}\n`);
    _startupLogged = true;
  }
}

export function createOutboundSocketFactory() {
  if (getOutboundHeaders().isEmpty) return null;

  return (url) => {
    let WebSocket;
    try {
      WebSocket = require('ws');
    } catch {
      throw new Error('The "ws" package is required for Huly outbound WebSocket headers.');
    }

    const origin = new URL(url).origin;
    const wsOpts = _allowedOrigins.has(origin)
      ? { headers: Object.fromEntries(getOutboundHeaders().headers) }
      : undefined;
    const ws = new WebSocket(url, undefined, wsOpts);
    const client = {
      get readyState() {
        return ws.readyState;
      },
      send: (data) => {
        if (data instanceof Blob) {
          void data.arrayBuffer().then((buffer) => {
            ws.send(buffer);
          });
        } else {
          ws.send(data);
        }
      },
      close: (code) => {
        ws.close(code);
      }
    };
    ws.on('message', (data) => {
      if (client.onmessage != null) {
        let eventData = data;
        if (typeof Buffer !== 'undefined' && data instanceof Buffer) {
          eventData = new Uint8Array(data).buffer;
        }
        const event = {
          data: eventData,
          type: 'message',
          target: undefined
        };
        client.onmessage(event);
      }
    });
    ws.on('close', (code, reason) => {
      if (client.onclose != null) {
        const closeEvent = {
          code,
          reason,
          wasClean: code === 1000,
          type: 'close',
          target: undefined
        };
        client.onclose(closeEvent);
      }
    });
    ws.on('open', () => {
      if (client.onopen != null) {
        const event = {
          type: 'open',
          target: undefined
        };
        client.onopen(event);
      }
    });
    ws.on('error', (error) => {
      if (client.onerror != null) {
        const event = {
          type: 'error',
          target: undefined,
          error
        };
        client.onerror(event);
      }
    });
    return client;
  };
}

export function __resetForTests() {
  if (_originalFetch) {
    globalThis.fetch = _originalFetch;
  }
  _parsed = null;
  _wrapperInstalled = false;
  _originalFetch = null;
  _startupLogged = false;
  _allowedOrigins.clear();
}
