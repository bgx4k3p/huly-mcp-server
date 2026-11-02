/**
 * Request guards and helpers for the HTTP transport: JSON responses, origin checks, CORS, bearer auth and body
 * parsing.
 */
import crypto from 'node:crypto';

/** An error with the HTTP status the client should receive. */
export class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code
   * @param {string} message - Message sent to the client
   */
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Send a JSON response.
 * @param {Object} res - HTTP response
 * @param {number} status - HTTP status code
 * @param {*} data - Response body
 */
export function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Send a JSON-RPC error with no request id, the shape MCP clients expect from the transport.
 * @param {Object} res - HTTP response
 * @param {number} status - HTTP status code
 * @param {string} message - Error message
 */
export function rpcError(res, status, message) {
  jsonResponse(res, status, { jsonrpc: '2.0', error: { code: -32000, message }, id: null });
}

/**
 * Whether a browser origin may call the server. Requests without an Origin header (non-browser clients) are not
 * subject to this check.
 * @param {string|undefined} origin - Origin request header
 * @param {'*'|Set<string>} allowedOrigins - Configured origins
 * @returns {boolean}
 */
export function originAllowed(origin, allowedOrigins) {
  return origin === undefined || allowedOrigins === '*' || allowedOrigins.has(origin);
}

/**
 * Set CORS and security headers. Only an allowed browser origin is echoed back.
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 * @param {'*'|Set<string>} allowedOrigins - Configured origins
 */
export function setCorsHeaders(req, res, allowedOrigins) {
  const origin = req.headers.origin;
  if (origin !== undefined && originAllowed(origin, allowedOrigins)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Huly-Response-Mode');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * Identify the caller's MCP access token. Every configured token is compared in constant time, so the response
 * time does not reveal which one, if any, came close.
 * @param {Object} req - HTTP request
 * @param {Array<{name: string, token: string}>} tokens - Configured tokens
 * @returns {string|null} The matching token's name, "anonymous" when no tokens are configured, or null
 */
export function authenticate(req, tokens) {
  if (tokens.length === 0) return 'anonymous';
  const header = req.headers.authorization || '';
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const digest = value => crypto.createHash('sha256').update(value).digest();
  const presentedDigest = digest(presented);
  let matched = null;
  for (const { name, token } of tokens) {
    if (crypto.timingSafeEqual(presentedDigest, digest(token)) && matched === null) matched = name;
  }
  return presented.length > 0 ? matched : null;
}

/**
 * Read and parse a JSON request body.
 * @param {Object} req - HTTP request
 * @param {number} maxBytes - Largest accepted body
 * @returns {Promise<*>} Parsed body, or undefined when empty
 * @throws {HttpError} 413 when the body is too large, 400 when it is not valid JSON
 */
export function parseBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      // Keep draining an oversized body without storing it, so the client still receives the 413.
      if (size > maxBytes) return;
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > maxBytes) return reject(new HttpError(413, 'Request body too large'));
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
