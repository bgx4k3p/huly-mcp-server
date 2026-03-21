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
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer, PKG_VERSION } from './mcpShared.mjs';
import { pool } from './pool.mjs';
import {
  PORT, MCP_AUTH_TOKEN as API_TOKEN, ALLOWED_ORIGINS,
  RATE_LIMIT, RATE_WINDOW_MS, MAX_BODY_SIZE
} from './config.mjs';

// ── Rate Limiting ─────────────────────────────────────────────

/** @type {Map<string, { count: number, resetAt: number }>} */
const rateLimitStore = new Map();

function checkRateLimit(ip) {
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

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// ── Session Management ────────────────────────────────────────

/** @type {Map<string, { server: Object, transport: StreamableHTTPServerTransport }>} */
const sessions = new Map();

/**
 * Get or create a session for a given session ID.
 * Stateful mode: each client gets a persistent session.
 */
function getOrCreateSession(sessionId) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const { server, TOOLS } = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });

  transport.onclose = () => {
    const sid = transport.sessionId;
    if (sid) sessions.delete(sid);
  };

  server.connect(transport);

  // We'll store it after the first request sets the session ID
  return { server, transport, TOOLS };
}

// ── Helpers ───────────────────────────────────────────────────

function jsonResponse(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function setCorsHeaders(req, res) {
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
}

function checkAuth(req) {
  if (!API_TOKEN) return true;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return false;
  if (Buffer.byteLength(token) !== Buffer.byteLength(API_TOKEN)) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(API_TOKEN));
}

/**
 * Parse JSON body from an incoming request.
 */
function parseBody(req) {
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

// ── Main Request Handler ──────────────────────────────────────

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
      const session = getOrCreateSession(sessionId);
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

// ── Server ────────────────────────────────────────────────────

const server = createServer(handleRequest);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Port taken — use OS-assigned port
    console.error(`Port ${PORT} in use, requesting available port...`);
    server.listen(0, () => {
      const actualPort = server.address().port;
      console.log(`Huly MCP Server v${PKG_VERSION} (Streamable HTTP) listening on port ${actualPort}`);
      console.log(`MCP endpoint: http://localhost:${actualPort}/mcp`);
      console.log(`Health check: http://localhost:${actualPort}/health`);
      if (API_TOKEN) console.log('Bearer token authentication enabled');
    });
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`Huly MCP Server v${PKG_VERSION} (Streamable HTTP) listening on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  if (API_TOKEN) console.log('Bearer token authentication enabled');
});

// Graceful shutdown
function shutdown(signal) {
  console.error(`${signal} received, shutting down...`);
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();

  // Close all sessions
  for (const session of sessions.values()) {
    session.transport.close().catch(() => {});
    session.server.close().catch(() => {});
  }
  sessions.clear();
  pool.clearAll();

  server.close(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
