#!/usr/bin/env node
/**
 * Run every offline test file, optionally with coverage.
 *
 * Discovering the files here rather than listing them in package.json means a
 * new unit test is picked up the moment it is written; the previous hand-kept
 * list silently omitted whichever file the author forgot to register.
 *
 * Usage:
 *   node scripts/run-unit-tests.mjs [--coverage] [-- <extra node --test args>]
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// integration.test.mjs needs a live Huly workspace; it runs from test:ws/test:rest.
const LIVE_ONLY = new Set(['integration.test.mjs']);

const testDir = 'test';
const files = readdirSync(testDir)
  .filter(name => name.endsWith('.test.mjs') && !LIVE_ONLY.has(name))
  .sort()
  .map(name => join(testDir, name));

if (files.length === 0) throw new Error('No offline test files found in test/');

const coverage = process.argv.includes('--coverage');
const passthrough = process.argv.slice(2).filter(arg => arg !== '--coverage');

const args = ['--test', ...(coverage ? ['--experimental-test-coverage'] : []), ...passthrough, ...files];
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
