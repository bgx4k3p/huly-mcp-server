#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');
const npmCache = process.env.HULY_MCP_NPM_CACHE ?? join(tmpdir(), 'huly-mcp-npm-cache');
const npmEnv = {
  ...process.env,
  npm_config_cache: npmCache,
  NPM_CONFIG_CACHE: npmCache
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    env: options.env ?? npmEnv,
    ...options
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`${command} ${args.join(' ')} failed with ${result.status}\n${output}`);
  }
  return result;
}

function tarballName() {
  const scopeless = pkg.name.replace(/^@/, '').replace('/', '-');
  return `${scopeless}-${pkg.version}.tgz`;
}

const tarball = resolve(process.argv[2] ?? tarballName());
const installDir = mkdtempSync(join(tmpdir(), 'huly-mcp-package-smoke-'));

try {
  run('npm', ['install', '--cache', npmCache, '--prefix', installDir, tarball]);

  const packageDir = join(installDir, 'node_modules', pkg.name);
  const entrypoint = join(packageDir, pkg.bin['huly-mcp-server']);
  const result = spawnSync(process.execPath, [entrypoint], {
    input: '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Packed MCP server failed to start from ${basename(tarball)}\n${output}`);
  }

  if (!result.stderr.includes(`Huly MCP Server v${pkg.version} running on stdio`)) {
    throw new Error(`Packed MCP server did not print the expected startup line.\n${result.stderr}`);
  }

  console.error(`[package-smoke] ${pkg.name}@${pkg.version} passed on ${process.version}`);
} finally {
  rmSync(installDir, { recursive: true, force: true });
}
