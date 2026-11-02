#!/usr/bin/env node
/**
 * Huly MCP Server - Streamable HTTP transport entry point.
 *
 * Serves the same MCP tools and resources as the stdio entry point (mcp.mjs) over Streamable HTTP, for one
 * shared server used by several clients of the same Huly account. Settings come from the environment and are
 * validated before the server starts (see src/http/config.mjs): it listens on HOST (127.0.0.1 by default),
 * refuses to listen beyond loopback without an MCP access token, and exits instead of moving to another port.
 */
import { pathToFileURL } from 'node:url';
import { loadHttpConfig } from './http/config.mjs';
import { createHttpApp } from './http/app.mjs';
import { createMcpServer } from './mcp/server.mjs';
import { PKG_VERSION } from './packageInfo.mjs';
import { pool } from './pool.mjs';

/**
 * Validate the configuration, then start listening.
 * @param {Object} [config] - HTTP configuration; read from the environment when omitted
 * @returns {Promise<{server: Object, close: () => Promise<void>, port: number}>}
 * @throws {Error} When a setting is invalid or the port cannot be bound
 */
export async function startHttpServer(config = loadHttpConfig()) {
  // Fail at startup, not on the first session, when HULY_TOOL_PROFILE or HULY_RESPONSE_MODE is invalid.
  createMcpServer();

  const app = createHttpApp(config);
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(config.port, config.host, () => {
      app.server.off('error', reject);
      resolve();
    });
  });
  const { port } = app.server.address();
  console.error(`Huly MCP Server v${PKG_VERSION} (Streamable HTTP) listening on http://${config.host}:${port}/mcp`);
  console.error(config.tokens.length > 0
    ? `Access tokens: ${config.tokens.map(token => token.name).join(', ')}`
    : 'No access token configured: loopback connections only');
  return { server: app.server, close: app.close, port };
}

/**
 * Close all sessions and pooled connections, then exit; forced exit after 10 seconds.
 * @param {Object} running - Result of `startHttpServer`
 * @param {string} signal - Signal name, for the log line
 */
async function shutdown(running, signal) {
  console.error(`${signal} received, shutting down...`);
  setTimeout(() => process.exit(1), 10000).unref();
  pool.clearAll();
  await running.close();
  process.exit(0);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const running = await startHttpServer();
    process.on('SIGTERM', () => shutdown(running, 'SIGTERM'));
    process.on('SIGINT', () => shutdown(running, 'SIGINT'));
  } catch (error) {
    console.error(`Huly MCP Server could not start: ${error.code === 'EADDRINUSE' ? 'port already in use' : error.message}`);
    process.exit(1);
  }
}
