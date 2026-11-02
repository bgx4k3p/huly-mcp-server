#!/usr/bin/env node
/**
 * Huly MCP Server - stdio transport entry point for local MCP clients.
 *
 * Builds the server with the shared factory from mcpShared.mjs and connects it to a
 * StdioServerTransport. Loaded by index.mjs when no other mode is requested.
 *
 * IMPORTANT: MCP stdio transport requires stdout to carry only JSON-RPC
 * messages. The Huly SDK writes diagnostic lines ("Generate new SessionId",
 * "init DB complete", "Connected to server", "findfull model ...") via
 * console.log, which corrupts framing and causes the client to drop the
 * connection. This module routes console.log and console.info to stderr.
 * ESM evaluates the static imports below (the MCP SDK, mcpShared.mjs and the
 * Huly SDK modules it pulls in) before this module's body runs, so the redirect
 * does not cover output written while those modules load; it covers everything
 * logged afterwards, including the SDK's connection-time diagnostics.
 * JSON-RPC responses are written via process.stdout by the
 * StdioServerTransport and are unaffected.
 */
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, PKG_VERSION } from './mcpShared.mjs';

const { server, TOOLS } = createMcpServer();

/**
 * Connect the shared server to a stdio transport and log a startup line to stderr.
 * @returns {Promise<void>}
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Huly MCP Server v${PKG_VERSION} running on stdio (${TOOLS.length} tools, resources enabled)`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
