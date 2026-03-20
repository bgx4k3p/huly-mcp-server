#!/usr/bin/env node
/**
 * Custom pack script — creates a slim tarball by copying only the
 * Huly SDK packages needed at runtime, excluding UI/frontend bloat.
 *
 * Usage: node scripts/pack.mjs
 *
 * The Huly SDK pulls in ~32MB of transitive UI dependencies (theme, ui,
 * Svelte, etc.) that are never used in a Node.js MCP server. This script
 * produces a ~6MB tarball instead.
 */
import { cpSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const root = process.cwd();
const tmp = join(root, '.pack-tmp');

// Clean previous
if (existsSync(tmp)) rmSync(tmp, { recursive: true });
mkdirSync(tmp, { recursive: true });

// Copy project files (same as "files" in package.json)
for (const item of ['src', 'scripts/patch-sdk.mjs', 'LICENSE', 'README.md', 'package.json', 'package-lock.json']) {
  const src = join(root, item);
  const dst = join(tmp, item);
  if (existsSync(src)) {
    mkdirSync(join(dst, '..'), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
}

// Huly SDK packages needed at runtime
const hulyNeeded = [
  'account-client', 'analytics', 'api-client', 'chunter', 'client',
  'client-resources', 'collaborator-client', 'contact', 'core',
  'measurements', 'platform', 'rank', 'rpc', 'tags', 'task',
  'text', 'text-core', 'text-html', 'text-markdown', 'tracker'
];

// Copy only needed @hcengineering packages
for (const pkg of hulyNeeded) {
  const src = join(root, 'node_modules', '@hcengineering', pkg);
  const dst = join(tmp, 'node_modules', '@hcengineering', pkg);
  if (existsSync(src)) {
    cpSync(src, dst, { recursive: true });
  }
}

// Copy non-Huly dependencies that the SDK needs
// (everything in node_modules except @hcengineering and known bloat)
// Only prune packages confirmed not needed at runtime
const bloat = new Set(['svelte']);

const { readdirSync } = await import('fs');
for (const entry of readdirSync(join(root, 'node_modules'))) {
  if (entry === '@hcengineering') continue;
  if (entry === '.package-lock.json') continue;
  if (bloat.has(entry)) continue;

  const src = join(root, 'node_modules', entry);
  const dst = join(tmp, 'node_modules', entry);

  if (entry.startsWith('@')) {
    // Scoped package — check subdirs
    const skip = bloat.has(entry);
    if (skip) continue;
    cpSync(src, dst, { recursive: true });
  } else {
    cpSync(src, dst, { recursive: true });
  }
}

// Pack from temp dir
console.log('Packing...');
const result = execSync('npm pack', { cwd: tmp, encoding: 'utf8' });
const tgzName = result.trim();
const tgzSrc = join(tmp, tgzName);
const tgzDst = join(root, tgzName);
cpSync(tgzSrc, tgzDst);

// Clean up
rmSync(tmp, { recursive: true });

// Report size
const { statSync } = await import('fs');
const size = statSync(tgzDst).size;
const mb = (size / 1048576).toFixed(1);
console.log(`\n  ${tgzName} (${mb}MB)`);
