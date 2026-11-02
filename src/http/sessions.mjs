/**
 * Streamable HTTP sessions: one MCP server and transport per connected client.
 */
import crypto from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/server.mjs';

/** @type {Map<string, { server: Object, transport: StreamableHTTPServerTransport }>} */
export const sessions = new Map();

/**
 * Return the live session for a session ID, or a new MCP server and transport for a client that has none.
 * A new session is not stored here: its ID exists only after the transport handles the first request,
 * so the caller registers it then.
 * @param {string|undefined} sessionId - Mcp-Session-Id header value
 * @param {string|undefined} responseMode - Huly-Response-Mode header value for a new session
 * @returns {{server: Object, transport: StreamableHTTPServerTransport, TOOLS?: Object[]}}
 */
export function getOrCreateSession(sessionId, responseMode) {
  if (sessionId && sessions.has(sessionId)) {
    return sessions.get(sessionId);
  }

  const { server, TOOLS } = createMcpServer({ responseMode });
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

/**
 * Close every session's transport and server and forget them all.
 */
export function closeAllSessions() {
  for (const session of sessions.values()) {
    session.transport.close().catch(() => {});
    session.server.close().catch(() => {});
  }
  sessions.clear();
}
