#!/usr/bin/env node
/**
 * Huly MCP Server - Streamable HTTP transport entry point.
 *
 * Provides the same MCP tools and resources as the stdio entry point (mcp.mjs)
 * but over HTTP, enabling auto-reconnection, session management, and
 * multi-client support. Compatible with n8n, VS Code, and any MCP client
 * that supports Streamable HTTP transport.
 *
 * Uses built-in Node.js http module (no Express dependency).
 *
 * Features:
 * - Streamable HTTP MCP transport with session management
 * - Bearer token authentication (optional, via MCP_AUTH_TOKEN)
 * - Health check endpoint at /health
 * - CORS support for browser clients
 */

import { createServer } from 'http';
import { MCP_AUTH_TOKEN as API_TOKEN, PORT, RATE_LIMIT } from './config.mjs';
import { checkAuth, jsonResponse, parseBody, setCorsHeaders } from './http/guards.mjs';
import { checkRateLimit } from './http/rateLimit.mjs';
import { closeAllSessions, getOrCreateSession, sessions } from './http/sessions.mjs';
import { PKG_VERSION } from './packageInfo.mjs';
import { pool } from './pool.mjs';

/**
 * Route one HTTP request: CORS preflight, /health, and the /mcp endpoint (auth, rate limit, then the
 * session's transport).
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method.toUpperCase();
  const path = url.pathname;

  setCorsHeaders(req, res);

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health check (no auth)
  if (method === 'GET' && path === '/health') {
    return jsonResponse(res, 200, {
      status: 'ok',
      version: PKG_VERSION,
      transport: 'streamable-http',
      sessions: sessions.size,
      timestamp: new Date().toISOString()
    });
  }

  // All /mcp requests require auth and rate limiting
  if (path === '/mcp') {
    if (!checkAuth(req)) {
      return jsonResponse(res, 401, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized' },
        id: null
      });
    }

    const clientIP = req.socket.remoteAddress || 'unknown';
    const rateResult = checkRateLimit(clientIP);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT);
    res.setHeader('X-RateLimit-Remaining', rateResult.remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(rateResult.resetAt / 1000));
    if (!rateResult.allowed) {
      return jsonResponse(res, 429, {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Rate limit exceeded' },
        id: null
      });
    }

    const sessionId = req.headers['mcp-session-id'];

    if (method === 'POST') {
      const body = await parseBody(req);
      const session = getOrCreateSession(sessionId, req.headers['huly-response-mode']);
      await session.transport.handleRequest(req, res, body);

      // Store session after first request (transport now has a session ID)
      const sid = session.transport.sessionId;
      if (sid && !sessions.has(sid)) {
        sessions.set(sid, session);
      }
      return;
    }

    if (method === 'GET') {
      // SSE stream for server-initiated messages
      if (!sessionId || !sessions.has(sessionId)) {
        return jsonResponse(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Missing or invalid session ID. Send an initialize request first.' },
          id: null
        });
      }
      const session = sessions.get(sessionId);
      await session.transport.handleRequest(req, res);
      return;
    }

    if (method === 'DELETE') {
      // Session termination
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        await session.transport.close();
        await session.server.close();
        sessions.delete(sessionId);
      }
      res.writeHead(200);
      return res.end();
    }

    return jsonResponse(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed' },
      id: null
    });
  }

  return jsonResponse(res, 404, { error: `Not found: ${method} ${path}` });
}

/**
 * Log the endpoints once the server is listening.
 * @param {number} port - Port the server is bound to
 */
function logListening(port) {
  console.log(`Huly MCP Server v${PKG_VERSION} (Streamable HTTP) listening on port ${port}`);
  console.log(`MCP endpoint: http://localhost:${port}/mcp`);
  console.log(`Health check: http://localhost:${port}/health`);
  if (API_TOKEN) console.log('Bearer token authentication enabled');
}

const server = createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Port taken — use OS-assigned port
    console.error(`Port ${PORT} in use, requesting available port...`);
    server.listen(0, () => logListening(server.address().port));
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, () => logListening(PORT));

/**
 * Close all sessions and pooled connections, then exit; forced exit after 10 seconds.
 * @param {string} signal - Signal name, for the log line
 */
function shutdown(signal) {
  console.error(`${signal} received, shutting down...`);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();

  closeAllSessions();
  pool.clearAll();

  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
