/**
 * Scoped outbound header injection for protected Huly deployments.
 *
 * Headers come from HULY_OUTBOUND_HEADERS_JSON (a JSON object) and HULY_OUTBOUND_HEADER_<NAME>
 * variables (underscores in <NAME> become hyphens). They are added to fetch requests (via a
 * wrapper installed on globalThis.fetch) and to WebSocket upgrades (via a socket factory),
 * but ONLY for registered origins:
 *   - HULY_URL (caller-provided)
 *   - origins advertised by Huly's own /config.json response (*_URL fields)
 *   - the transactor endpoint returned by workspace login
 * A ws:// or wss:// origin also registers its http:// or https:// counterpart.
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

/**
 * Normalize a header name for case-insensitive comparison.
 * @param {string} name
 * @returns {string} Lower-cased name
 */
function normalizeHeaderKey(name) {
  return name.toLowerCase();
}

/**
 * Validate a header name as an RFC 9110 token that is not a banned credential header.
 * @param {string} name - Header name
 * @param {string} source - Env var name used in error messages
 * @throws {Error} When the name is not a valid token or is Authorization, Cookie or Proxy-Authorization
 */
function validateHeaderName(name, source) {
  if (!HEADER_NAME_RE.test(name)) {
    throw new Error(`${source} contains invalid header name: ${name}`);
  }
  if (BANNED_HEADERS.has(normalizeHeaderKey(name))) {
    throw new Error(`${source} cannot set forbidden outbound header: ${name}`);
  }
}

/**
 * Validate that a header value contains only printable ASCII and tabs.
 * @param {string} value - Header value
 * @param {string} source - Env var name used in error messages
 * @param {string} name - Header name used in error messages
 * @throws {Error} When the value contains other characters
 */
function validateHeaderValue(value, source, name) {
  if (!HEADER_VALUE_RE.test(value)) {
    throw new Error(`${source} contains invalid value for outbound header: ${name}`);
  }
}

/**
 * Validate one configured header and add it to the result map. The value is trimmed; a header
 * repeated with the same value (case-insensitive name) is ignored.
 * @param {Map<string, string>} map - Headers keyed by their configured name
 * @param {Map<string, {name: string, value: string}>} seen - Entries keyed by lower-cased name
 * @param {*} name - Header name
 * @param {*} value - Header value
 * @param {string} source - Env var name used in error messages
 * @throws {Error} When the name or value is invalid, the value is empty, or the header conflicts
 *   with an earlier value
 */
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

/**
 * Add headers from HULY_OUTBOUND_HEADERS_JSON; unset or empty adds nothing.
 * @param {Map<string, string>} map - Result map
 * @param {Map<string, {name: string, value: string}>} seen - Entries keyed by lower-cased name
 * @throws {Error} When the value is not a JSON object or contains an invalid header
 */
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

/**
 * Add headers from HULY_OUTBOUND_HEADER_<NAME> env vars, turning underscores in <NAME> into hyphens.
 * @param {Map<string, string>} map - Result map
 * @param {Map<string, {name: string, value: string}>} seen - Entries keyed by lower-cased name
 * @throws {Error} When a variable has no name suffix or defines an invalid header
 */
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

/**
 * Parse the configured outbound headers once and cache the result for the process.
 * @returns {{headers: Map<string, string>, isEmpty: boolean}}
 * @throws {Error} When the header configuration is invalid
 */
export function getOutboundHeaders() {
  if (_parsed) return _parsed;

  const headers = new Map();
  const seen = new Map();
  parseJsonHeaders(headers, seen);
  parseDiscreteHeaders(headers, seen);

  _parsed = { headers, isEmpty: headers.size === 0 };
  return _parsed;
}

/**
 * Return the origin of a URL, resolved against an optional base.
 * @param {string} url
 * @param {string} [baseUrl]
 * @returns {string}
 */
function originFor(url, baseUrl) {
  return new URL(url, baseUrl).origin;
}

/**
 * Allow an origin; a ws:// or wss:// origin also allows its http:// or https:// counterpart.
 * @param {string} origin
 */
function registerOriginPair(origin) {
  _allowedOrigins.add(origin);
  if (origin.startsWith('wss://')) {
    _allowedOrigins.add(`https://${origin.slice('wss://'.length)}`);
  } else if (origin.startsWith('ws://')) {
    _allowedOrigins.add(`http://${origin.slice('ws://'.length)}`);
  }
}

/**
 * Allow the origin of a URL to receive outbound headers; an empty URL is ignored.
 * @param {string} [url] - Absolute URL, or relative to baseUrl
 * @param {string} [baseUrl] - Base for resolving a relative URL
 * @throws {TypeError} When the URL cannot be parsed
 */
export function registerOutboundOrigin(url, baseUrl) {
  if (!url) return;
  registerOriginPair(originFor(url, baseUrl));
}

/**
 * Allow every non-empty string *_URL value in a Huly /config.json response.
 * @param {Object|null|undefined} config - Parsed server config; non-objects are ignored
 * @param {string} hulyUrl - Base for resolving relative URLs
 */
export function registerOriginsFromServerConfig(config, hulyUrl) {
  if (!config || typeof config !== 'object') return;

  for (const [key, value] of Object.entries(config)) {
    if (!key.endsWith('_URL') || typeof value !== 'string' || value.trim() === '') continue;
    registerOutboundOrigin(value, hulyUrl);
  }
}

/**
 * Return the origin of a fetch input.
 * @param {Request|string|URL} input
 * @returns {string}
 */
function requestOrigin(input) {
  if (input instanceof Request) return new URL(input.url).origin;
  return new URL(input).origin;
}

/**
 * Add the configured headers to a request without overriding headers it already has, and set
 * Accept-Encoding: identity when the request does not specify an encoding.
 * @param {Request} request - Mutated in place
 * @returns {Request} The same request
 */
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

/**
 * Replace globalThis.fetch with a wrapper that adds outbound headers to requests for allowed
 * origins. Idempotent, including when another copy of this module installed the wrapper.
 * @throws {Error} When globalThis.fetch is not a function
 */
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

/**
 * Validate the header configuration, install the fetch wrapper and allow the Huly URL's origin.
 * The wrapper is installed even when no headers are configured. Logs the configured header
 * names (not values) to stderr once.
 * @param {string} hulyUrl - Huly base URL
 * @throws {Error} When the header configuration is invalid or fetch is unavailable
 */
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

/**
 * Create a WebSocket factory for the Huly SDK that adds outbound headers to upgrade requests for
 * allowed origins. The returned client adapts the `ws` package to the browser-style
 * onmessage/onclose/onopen/onerror interface the SDK expects.
 * @returns {((url: string) => Object)|null} Factory, or null when no headers are configured
 *   (the factory throws when the `ws` package cannot be loaded)
 */
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

/**
 * Test hook: restore the original fetch and clear the cached headers, allowed origins and
 * startup-log flag. Not for production use.
 */
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
