/**
 * Request guards and helpers for the HTTP transport: JSON responses, CORS, bearer auth and body parsing.
 */
import crypto from 'node:crypto';
import { ALLOWED_ORIGINS, MAX_BODY_SIZE, MCP_AUTH_TOKEN as API_TOKEN } from '../config.mjs';

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
 * Set CORS and security headers. A wildcard origin is sent only when no auth token is configured; otherwise
 * only origins listed in ALLOWED_ORIGINS are echoed back.
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
export function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS === '*' && !API_TOKEN) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (ALLOWED_ORIGINS !== '*') {
    const allowed = ALLOWED_ORIGINS.split(',').map(o => o.trim());
    if (allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Huly-Response-Mode');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

/**
 * Check the bearer token in constant time. Every request passes when MCP_AUTH_TOKEN is not set.
 * @param {Object} req - HTTP request
 * @returns {boolean}
 */
export function checkAuth(req) {
  if (!API_TOKEN) return true;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(API_TOKEN)) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN));
}

/**
 * Read and parse a JSON request body, rejecting bodies over MAX_BODY_SIZE.
 * @param {Object} req - HTTP request
 * @returns {Promise<*>} Parsed body, or undefined when empty
 * @throws {Error} When the body is too large or not valid JSON
 */
export function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}
