#!/usr/bin/env node
/**
 * Entry point for the Huly MCP server.
 *
 * Usage:
 *   node src/index.mjs                          → Start MCP stdio server
 *   node src/index.mjs --get-token              → Print JWT (uses HULY_EMAIL/HULY_PASSWORD env vars)
 *   node src/index.mjs --get-token -e EMAIL -p PASS -u URL
 *   node src/index.mjs --init-codex --url URL --workspace WS
 *   node src/index.mjs --init-claude --url URL --workspace WS
 *   node src/index.mjs --init-all --url URL --workspace WS
 */

const args = process.argv.slice(2);

/** CLI flags that write MCP client configuration, mapped to their initCodex.mjs implementation. */
const INIT_COMMANDS = {
  '--init-all': 'initAllConfigs',
  '--init-claude': 'initClaudeConfig',
  '--init-codex': 'initCodexConfig'
};
const initFlag = Object.keys(INIT_COMMANDS).find(flag => args.includes(flag));

if (initFlag) {
  const initCodex = await import('./initCodex.mjs');
  try {
    const result = initCodex[INIT_COMMANDS[initFlag]](args.filter(arg => arg !== initFlag));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else if (args.includes('--get-token')) {
  const { flagValue } = await import('./initCodex.mjs');
  const { HULY_URL } = await import('./config.mjs');
  const url = flagValue(args, ['-u']) || HULY_URL;
  const email = flagValue(args, ['-e']) || process.env.HULY_EMAIL;
  const password = flagValue(args, ['-p']) || process.env.HULY_PASSWORD;

  if (!email || !password) {
    console.error('Usage: node src/index.mjs --get-token -e EMAIL -p PASSWORD [-u HULY_URL]');
    console.error('Tip: Use HULY_EMAIL and HULY_PASSWORD env vars to avoid exposing credentials in process list.');
    process.exit(1);
  }

  const { getAccountClient, loadConfig } = await import('./client/sdk.mjs');
  const { ensureOutboundHeaders, registerOriginsFromServerConfig } = await import('./outboundHeaders.mjs');

  ensureOutboundHeaders(url);
  const config = await loadConfig(url);
  registerOriginsFromServerConfig(config, url);
  const client = getAccountClient(config.ACCOUNTS_URL);
  const loginInfo = await client.login(email, password);

  if (!loginInfo?.token) {
    console.error('Login failed — check email and password');
    process.exit(1);
  }

  console.log(loginInfo.token);
} else {
  await import('./mcp.mjs');
}
