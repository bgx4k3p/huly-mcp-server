#!/usr/bin/env node
/**
 * Entry point for the Huly MCP server.
 *
 * Usage:
 *   node src/index.mjs                          → Start MCP stdio server
 *   node src/index.mjs --get-token              → Print JWT (uses HULY_EMAIL/HULY_PASSWORD env vars)
 *   node src/index.mjs --get-token -e EMAIL -p PASS -u URL
 *   node src/index.mjs --init-codex             → Generate project .codex/config.toml
 *   node src/index.mjs --init-claude            → Generate project .mcp.json
 *   node src/index.mjs --init-all               → Generate Claude and Codex project config
 */

const args = process.argv.slice(2);

if (args.includes('--init-all')) {
  const { initAllConfigs } = await import('./initCodex.mjs');
  try {
    const result = initAllConfigs(args.filter(arg => arg !== '--init-all'));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else if (args.includes('--init-claude')) {
  const { initClaudeConfig } = await import('./initCodex.mjs');
  try {
    const result = initClaudeConfig(args.filter(arg => arg !== '--init-claude'));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else if (args.includes('--init-codex')) {
  const { initCodexConfig } = await import('./initCodex.mjs');
  try {
    const result = initCodexConfig(args.filter(arg => arg !== '--init-codex'));
    console.log(result.message);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
} else if (args.includes('--get-token')) {
  const flag = (name) => {
    const i = args.indexOf(name);
    return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
  };

  const url = flag('-u') || process.env.HULY_URL || 'http://localhost:8087';
  const email = flag('-e') || process.env.HULY_EMAIL;
  const password = flag('-p') || process.env.HULY_PASSWORD;

  if (!email || !password) {
    console.error('Usage: node src/index.mjs --get-token -e EMAIL -p PASSWORD [-u HULY_URL]');
    console.error('Tip: Use HULY_EMAIL and HULY_PASSWORD env vars to avoid exposing credentials in process list.');
    process.exit(1);
  }

  const { createRequire } = await import('module');
  const require = createRequire(import.meta.url);
  const { getClient } = require('@hcengineering/account-client');
  const { loadServerConfig } = require(
    require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/config.js')
  );

  const config = await loadServerConfig(url);
  const client = getClient(config.ACCOUNTS_URL);
  const loginInfo = await client.login(email, password);

  if (!loginInfo?.token) {
    console.error('Login failed — check email and password');
    process.exit(1);
  }

  console.log(loginInfo.token);
} else {
  await import('./mcp.mjs');
}
