#!/usr/bin/env node
/**
 * Huly MCP Server - stdio transport entry point for local MCP clients.
 *
 * Builds the server with the shared factory from mcp/server.mjs and connects it to a
 * StdioServerTransport. Loaded by index.mjs when no other mode is requested.
 * stdioConsole.mjs is imported first so nothing but JSON-RPC ever reaches stdout.
 */
import './stdioConsole.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './mcp/server.mjs';
import { PKG_VERSION } from './packageInfo.mjs';

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
