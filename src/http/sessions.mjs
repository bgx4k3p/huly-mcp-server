/**
 * Streamable HTTP sessions: one MCP server and transport per connected client, owned by the access token that
 * opened it, expired after a period of inactivity and capped in number.
 */
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server.mjs';

/**
 * Create a session store.
 * @param {Object} options
 * @param {number} options.idleMs - Inactivity after which a session is closed
 * @param {number} options.maxSessions - Largest number of open sessions
 * @returns {Object} Store with open, get, close, closeAll, size and stop
 */
export function createSessionStore({ idleMs, maxSessions }) {
  const sessions = new Map();

  const close = async sessionId => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    sessions.delete(sessionId);
    await session.transport.close().catch(() => {});
    await session.server.close().catch(() => {});
    return true;
  };

  const sweep = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const [sessionId, session] of sessions) {
      if (session.lastSeen < cutoff) void close(sessionId);
    }
  }, Math.min(idleMs, 60000));
  sweep.unref();

  return {
    /**
     * Open a new, uninitialized session for an access token. It is registered once the transport assigns its
     * id during the initialize request.
     * @param {string} tokenName - Access token that opens the session
     * @param {string|undefined} responseMode - Huly-Response-Mode for the session
     * @returns {Promise<{server: Object, transport: StreamableHTTPServerTransport, tokenName: string}>}
     * @throws {Error} When the session limit is reached
     */
    async open(tokenName, responseMode) {
      if (sessions.size >= maxSessions) throw new Error('Too many open sessions');
      const { server } = createMcpServer({ responseMode });
      const session = { server, tokenName, lastSeen: Date.now() };
      session.transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: sessionId => { sessions.set(sessionId, session); },
        onsessionclosed: sessionId => { sessions.delete(sessionId); }
      });
      session.transport.onclose = () => {
        if (session.transport.sessionId) sessions.delete(session.transport.sessionId);
      };
      await server.connect(session.transport);
      return session;
    },

    /**
     * Look up a live session and mark it active.
     * @param {string} sessionId - Mcp-Session-Id header value
     * @returns {Object|undefined}
     */
    get(sessionId) {
      const session = sessions.get(sessionId);
      if (session) session.lastSeen = Date.now();
      return session;
    },

    close,

    /** Close every session. */
    async closeAll() {
      await Promise.all([...sessions.keys()].map(close));
    },

    /** @returns {number} Number of open sessions */
    get size() {
      return sessions.size;
    },

    /** Stop the idle sweep. */
    stop() {
      clearInterval(sweep);
    }
  };
}
