#!/usr/bin/env node
/**
 * Huly MCP Server - stdio transport entry point for Claude Code.
 *
 * Uses the shared MCP server factory from mcpShared.mjs.
 */

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
