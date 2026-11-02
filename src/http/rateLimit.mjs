/**
 * Fixed-window request rate limiting per client address for the HTTP transport.
 */
import { RATE_LIMIT, RATE_WINDOW_MS } from '../config.mjs';

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitStore = new Map();

/**
 * Count a request from a client address against the current window.
 * @param {string} ip - Client address
 * @returns {{allowed: boolean, remaining: number, resetAt: number}}
 */
export function checkRateLimit(ip) {
  const now = Date.now();
  let entry = rateLimitStore.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    rateLimitStore.set(ip, entry);
  }
  entry.count++;
  return {
    allowed: entry.count <= RATE_LIMIT,
    remaining: Math.max(0, RATE_LIMIT - entry.count),
    resetAt: entry.resetAt
  };
}

// Drop expired windows so the store does not grow with every address ever seen.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, RATE_WINDOW_MS).unref();
