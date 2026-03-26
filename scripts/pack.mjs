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
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

// Strip @hcengineering/* deps from bundled packages so npm doesn't try
// to fetch them from the registry (some published versions use workspace:
// protocol which npm can't resolve). All needed packages are already
// co-located in node_modules so Node.js resolves them via the file system.
const hulySet = new Set(hulyNeeded);
for (const pkg of hulyNeeded) {
  const pkgJsonPath = join(tmp, 'node_modules', '@hcengineering', pkg, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  if (!pkgJson.dependencies) continue;
  let changed = false;
  for (const dep of Object.keys(pkgJson.dependencies)) {
    if (dep.startsWith('@hcengineering/')) {
      const short = dep.replace('@hcengineering/', '');
      if (!hulySet.has(short)) {
        // Not bundled — remove to prevent npm from fetching it
        delete pkgJson.dependencies[dep];
        changed = true;
      }
    }
  }
  if (changed) {
    writeFileSync(pkgJsonPath, JSON.stringify(pkgJson, null, 2) + '\n');
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
