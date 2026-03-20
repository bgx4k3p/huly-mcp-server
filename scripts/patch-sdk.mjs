#!/usr/bin/env node
/**
 * Patch Huly SDK bug: RestClientImpl.findAll crashes when lookupMap
 * is null (workspaces with custom task types).
 * See: https://github.com/hcengineering/huly.core/issues/17
 *
 * This runs as a postinstall script to fix the SDK after npm install.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';

let restPath;
try {
  const require = createRequire(import.meta.url);
  restPath = require.resolve('@hcengineering/api-client').replace(/index\.js$/, 'rest/rest.js');
} catch {
  // Bundled install — SDK is pre-patched, skip
  console.log('SDK patch: skipped (bundled install)');
  process.exit(0);
}

let src = readFileSync(restPath, 'utf8');
let patched = false;

// Fix 1: lookupMap null check (server returns null instead of undefined)
const nullCheck = 'if (result.lookupMap !== void 0) {';
const nullCheckFix = 'if (result.lookupMap != null) {';
if (src.includes(nullCheck)) {
  src = src.replace(nullCheck, nullCheckFix);
  patched = true;
}

// Fix 2: null-safe lookupMap value dereference
const deref = 'd.$lookup[k] = result.lookupMap[v];';
const derefFix = 'd.$lookup[k] = result.lookupMap[v] ?? null;';
if (src.includes(deref)) {
  src = src.replace(deref, derefFix);
  patched = true;
}

if (patched) {
  writeFileSync(restPath, src);
  console.log('SDK patch: fixed null lookupMap handling in RestClientImpl.findAll');
} else {
  console.log('SDK patch: already applied or SDK updated');
}
