/**
 * The Streamable HTTP application: request routing and guards, independent of process startup so it can be
 * run and tested on any port.
 */
import { createServer } from 'http';
import { parseMode } from '../responseMode.mjs';
import {
  authenticate,
  HttpError,
  jsonResponse,
  originAllowed,
  parseBody,
  rpcError,
  setCorsHeaders
} from './guards.mjs';
import { clientAddress, createRateLimiter } from './rateLimit.mjs';
import { createSessionStore } from './sessions.mjs';

/**
 * Create the HTTP application.
 * @param {Object} config - Result of `loadHttpConfig`
 * @returns {{server: Object, sessions: Object, close: () => Promise<void>}} Node HTTP server (not yet listening),
 *   the session store, and a function that closes everything
 */
export function createHttpApp(config) {
  const limiter = createRateLimiter({ limit: config.rateLimit, windowMs: config.rateWindowMs });
  const sessions = createSessionStore({ idleMs: config.sessionIdleMs, maxSessions: config.maxSessions });

  /**
   * Handle /mcp after the origin, rate limit and auth checks.
   * @param {Object} req - HTTP request
   * @param {Object} res - HTTP response
   * @param {string} tokenName - Authenticated access token
   */
  async function handleMcp(req, res, tokenName) {
    const method = req.method.toUpperCase();
    const sessionId = req.headers['mcp-session-id'];
    const existing = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !existing) return rpcError(res, 404, 'Session not found; initialize a new session');
    if (existing && existing.tokenName !== tokenName) return rpcError(res, 403, 'Session belongs to another token');

    if (method === 'POST') {
      const body = await parseBody(req, config.maxBodyBytes);
      if (existing) return existing.transport.handleRequest(req, res, body);
      const responseMode = req.headers['huly-response-mode'];
      try {
        parseMode(responseMode, 'Huly-Response-Mode header');
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      let session;
      try {
        session = await sessions.open(tokenName, responseMode);
      } catch (error) {
        throw new HttpError(503, error.message);
      }
      await session.transport.handleRequest(req, res, body);
      // A request that did not initialize a session (the transport rejects it) leaves nothing to keep.
      if (!session.transport.sessionId) {
        await session.transport.close().catch(() => {});
        await session.server.close().catch(() => {});
      }
      return;
    }
    if (method === 'GET') {
      if (!existing) return rpcError(res, 400, 'Missing session ID; send an initialize request first');
      return existing.transport.handleRequest(req, res);
    }
    if (method === 'DELETE') {
      if (!existing) return rpcError(res, 400, 'Missing session ID');
      await sessions.close(sessionId);
      res.writeHead(200);
      return res.end();
    }
    return rpcError(res, 405, 'Method not allowed');
  }

  /**
   * Route one HTTP request. Every failure becomes a response; none can escape and stop the process.
   * @param {Object} req - HTTP request
   * @param {Object} res - HTTP response
   */
  async function handleRequest(req, res) {
    try {
      const method = req.method.toUpperCase();
      const path = (req.url || '/').split('?')[0];
      setCorsHeaders(req, res, config.allowedOrigins);

      if (!originAllowed(req.headers.origin, config.allowedOrigins)) {
        return rpcError(res, 403, 'Origin not allowed');
      }
      if (method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }
      // No version or session count: /health is unauthenticated.
      if (method === 'GET' && path === '/health') {
        return jsonResponse(res, 200, { status: 'ok', transport: 'streamable-http', timestamp: new Date().toISOString() });
      }
      if (path !== '/mcp') return jsonResponse(res, 404, { error: 'Not found' });

      // Rate limit before auth, so guessing tokens is limited too.
      const rate = limiter.check(clientAddress(req, config.trustProxy));
      res.setHeader('X-RateLimit-Limit', config.rateLimit);
      res.setHeader('X-RateLimit-Remaining', rate.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(rate.resetAt / 1000));
      if (!rate.allowed) return rpcError(res, 429, 'Rate limit exceeded');

      const tokenName = authenticate(req, config.tokens);
      if (!tokenName) return rpcError(res, 401, 'Unauthorized');
      console.error(`[http] ${method} /mcp token=${tokenName}`);

      await handleMcp(req, res, tokenName);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error('[http] request failed:', error);
      if (status === 413) res.setHeader('Connection', 'close');
      if (!res.headersSent) rpcError(res, status, status === 500 ? 'Internal server error' : error.message);
      else res.end();
    }
  }

  const server = createServer(handleRequest);
  return {
    server,
    sessions,
    async close() {
      limiter.stop();
      sessions.stop();
      await sessions.closeAll();
      await new Promise(resolve => server.close(() => resolve()));
    }
  };
}
