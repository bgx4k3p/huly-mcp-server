/**
 * Fixed-window request rate limiting per client address for the HTTP transport.
 */

/**
 * The address a request is rate limited by. Behind a trusted reverse proxy that is the last X-Forwarded-For
 * entry, the address the proxy itself received the request from; otherwise the socket's peer address.
 * @param {Object} req - HTTP request
 * @param {boolean} trustProxy - Whether X-Forwarded-For comes from a trusted proxy
 * @returns {string}
 */
export function clientAddress(req, trustProxy) {
  if (trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',').map(part => part.trim()).filter(Boolean);
    if (forwarded.length > 0) return forwarded.at(-1);
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Create a rate limiter allowing `limit` requests per address per window.
 * @param {Object} options
 * @param {number} options.limit - Requests allowed per window
 * @param {number} options.windowMs - Window length
 * @returns {{check: (address: string) => {allowed: boolean, remaining: number, resetAt: number}, stop: () => void}}
 */
export function createRateLimiter({ limit, windowMs }) {
  const windows = new Map();
  // Drop expired windows so the store does not grow with every address ever seen.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [address, entry] of windows) {
      if (now > entry.resetAt) windows.delete(address);
    }
  }, windowMs);
  sweep.unref();

  return {
    check(address) {
      const now = Date.now();
      let entry = windows.get(address);
      if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + windowMs };
        windows.set(address, entry);
      }
      entry.count++;
      return { allowed: entry.count <= limit, remaining: Math.max(0, limit - entry.count), resetAt: entry.resetAt };
    },
    stop() {
      clearInterval(sweep);
    }
  };
}
