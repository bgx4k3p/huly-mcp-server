#!/usr/bin/env node
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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

const tarball = realpathSync(resolve(process.argv[2] ?? tarballName()));
// npm stores file dependencies relative to the install prefix. Canonicalize
// macOS /var -> /private/var so a later `npm ls` resolves the same path.
const installDir = realpathSync(mkdtempSync(join(tmpdir(), 'huly-mcp-package-smoke-')));
const globalInstallDir = realpathSync(mkdtempSync(join(tmpdir(), 'huly-mcp-global-smoke-')));

function assertStarts(entrypoint, installKind) {
  const result = spawnSync(process.execPath, [entrypoint], {
    input: '',
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });

  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(`Packed MCP server failed to start from ${installKind} install of ${basename(tarball)}\n${output}`);
  }

  if (!/running on stdio/.test(result.stderr)) {
    throw new Error(`Packed MCP server did not print the expected startup line for ${installKind} install.\n${result.stderr}`);
  }
  if (result.stdout !== '') {
    throw new Error(
      `Packed MCP server polluted stdout during ${installKind} stdio startup.\n${result.stdout}`
    );
  }
}

try {
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache, '--prefix', installDir, tarball]);

  const packageDir = join(installDir, 'node_modules', pkg.name);
  const entrypoint = join(packageDir, pkg.bin['huly-mcp-server']);
  run('npm', ['ls', '--all', '--prefix', installDir]);
  assertStarts(entrypoint, 'project-local');

  run('npm', ['install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', npmCache, '--prefix', globalInstallDir, tarball]);
  const globalPackageDir = join(globalInstallDir, 'lib', 'node_modules', pkg.name);
  run('npm', ['ls', '--global', '--all', '--prefix', globalInstallDir]);
  assertStarts(join(globalPackageDir, pkg.bin['huly-mcp-server']), 'global');

  console.error(`[package-smoke] ${pkg.name}@${pkg.version} project-local and global installs passed on ${process.version}`);
} finally {
  rmSync(installDir, { recursive: true, force: true });
  rmSync(globalInstallDir, { recursive: true, force: true });
}
