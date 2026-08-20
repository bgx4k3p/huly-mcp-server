#!/usr/bin/env node
/**
 * Build the same dependency-free tarball npm publishes to the registry.
 * Runtime dependencies are resolved by npm during installation instead of
 * embedding a hand-flattened node_modules tree with conflicting transitive
 * versions.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const ownsCache = !process.env.HULY_MCP_NPM_CACHE;
const npmCache = process.env.HULY_MCP_NPM_CACHE ?? mkdtempSync(join(tmpdir(), 'huly-mcp-pack-cache-'));
const npmEnv = {
  ...process.env,
  npm_config_cache: npmCache,
  NPM_CONFIG_CACHE: npmCache
};

try {
  console.log('Packing...');
  const result = execFileSync('npm', ['pack', '--cache', npmCache], {
    cwd: root,
    encoding: 'utf8',
    env: npmEnv
  });
  const tgzName = result.trim();
  const size = statSync(join(root, tgzName)).size;
  console.log(`\n  ${tgzName} (${(size / 1048576).toFixed(1)}MB)`);
} finally {
  if (ownsCache) rmSync(npmCache, { recursive: true, force: true });
}
