#!/usr/bin/env node
/**
 * Huly MCP Server - stdio transport entry point for Claude Code.
 *
 * Uses the shared MCP server factory from mcpShared.mjs.
 *
 * IMPORTANT: MCP stdio transport requires stdout to carry only JSON-RPC
 * messages. The Huly SDK writes diagnostic lines ("Generate new SessionId",
 * "init DB complete", "Connected to server", "findfull model ...") via
 * console.log, which corrupts framing and causes the client to drop the
 * connection. Route console.log to stderr so the SDK's noise stays out of
 * stdout. Actual JSON-RPC responses are written via process.stdout by the
 * StdioServerTransport and are unaffected.
 */
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, PKG_VERSION } from './mcpShared.mjs';

const { server, TOOLS } = createMcpServer();

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Huly MCP Server v${PKG_VERSION} running on stdio (${TOOLS.length} tools, resources enabled)`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
