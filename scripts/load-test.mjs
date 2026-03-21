#!/usr/bin/env node
/**
 * Load test — measures Huly SDK throughput at increasing request rates.
 *
 * Usage:
 *   node scripts/load-test.mjs [options]
 *
 * Options:
 *   --max-rps 50       Maximum requests per second to test (default: 50)
 *   --step 5           RPS increment between levels (default: 5)
 *   --duration 10      Seconds to hold each level (default: 10)
 *   --workspace slug   Workspace to test against (default: HULY_WORKSPACE)
 *   --project IDENT    Project to list issues from (uses listIssues instead of listProjects)
 *
 * Ramps from 1 req/s up to --max-rps, holding each level for --duration seconds.
 * Reports latency (p50/p95/p99), success rate, and errors at each level.
 * Stops automatically when error rate exceeds 20%.
 */

import { pool } from '../src/pool.mjs';

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
}

const MAX_RPS = Number(flag('max-rps', 50));
const STEP = Number(flag('step', 5));
const DURATION_S = Number(flag('duration', 10));
const WORKSPACE = flag('workspace', process.env.HULY_WORKSPACE);
const PROJECT = flag('project', null);

function percentile(sorted, p) {
  const i = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, i)];
}

async function runLevel(client, rps, durationMs, operation) {
  const intervalMs = 1000 / rps;
  const latencies = [];
  let successes = 0;
  let errors = 0;
  const errorMsgs = new Set();

  const start = Date.now();
  const promises = [];

  while (Date.now() - start < durationMs) {
    const reqStart = Date.now();
    const p = operation(client)
      .then(() => {
        latencies.push(Date.now() - reqStart);
        successes++;
      })
      .catch((e) => {
        latencies.push(Date.now() - reqStart);
        errors++;
        errorMsgs.add(e.message?.substring(0, 80) || 'unknown');
      });
    promises.push(p);

    const elapsed = Date.now() - reqStart;
    const wait = Math.max(0, intervalMs - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
  }

  await Promise.allSettled(promises);

  latencies.sort((a, b) => a - b);
  return {
    rps,
    total: successes + errors,
    successes,
    errors,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    maxMs: latencies[latencies.length - 1] || 0,
    errorMsgs: [...errorMsgs]
  };
}

async function main() {
  const opName = PROJECT ? `listIssues(${PROJECT})` : 'listProjects()';
  console.log(`Load test: ${opName} on workspace "${WORKSPACE}"`);
  console.log(`Ramp 1 → ${MAX_RPS} req/s, step ${STEP}, ${DURATION_S}s per level\n`);

  const client = await pool.getClient(WORKSPACE);
  console.log('Connected. Warming up...');

  // Pick the operation to benchmark
  const operation = PROJECT
    ? (c) => c.listIssues(PROJECT, null, null, null, null, 50).then(r => r.items)
    : (c) => c.listProjects({}).then(r => r.items);

  // Warm up
  await operation(client);
  await operation(client);

  console.log(`\n${'RPS'.padStart(5)} | ${'Total'.padStart(6)} | ${'OK'.padStart(5)} | ${'Err'.padStart(4)} | ${'p50'.padStart(7)} | ${'p95'.padStart(7)} | ${'p99'.padStart(7)} | ${'Max'.padStart(7)} | Errors`);
  console.log('-'.repeat(90));

  const levels = [1];
  for (let r = STEP; r <= MAX_RPS; r += STEP) levels.push(r);

  for (const rps of levels) {
    const result = await runLevel(client, rps, DURATION_S * 1000, operation);
    const errStr = result.errorMsgs.length > 0 ? result.errorMsgs.join('; ') : '';
    console.log(
      `${String(result.rps).padStart(5)} | ` +
      `${String(result.total).padStart(6)} | ` +
      `${String(result.successes).padStart(5)} | ` +
      `${String(result.errors).padStart(4)} | ` +
      `${String(result.p50 + 'ms').padStart(7)} | ` +
      `${String(result.p95 + 'ms').padStart(7)} | ` +
      `${String(result.p99 + 'ms').padStart(7)} | ` +
      `${String(result.maxMs + 'ms').padStart(7)} | ` +
      errStr
    );

    if (result.errors > result.total * 0.2) {
      console.log('\nStopping: error rate exceeded 20%');
      break;
    }
  }

  console.log('\nDone.');
  client.disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
