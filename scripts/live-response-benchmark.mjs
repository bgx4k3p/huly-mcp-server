#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

import { HulyClient as CandidateClient } from '../src/client.mjs';
import { serializeToolResult } from '../src/responseMode.mjs';

const workspace = process.env.HULY_BENCHMARK_WORKSPACE;
const project = process.env.HULY_BENCHMARK_PROJECT ?? 'MCPV';
const iterations = Number.parseInt(process.env.HULY_BENCHMARK_ITERATIONS ?? '3', 10);
const installedRoot = process.env.HULY_INSTALLED_PACKAGE_PATH;
if (!workspace) throw new Error('HULY_BENCHMARK_WORKSPACE is required');
if (!installedRoot) throw new Error('HULY_INSTALLED_PACKAGE_PATH is required');
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error('HULY_BENCHMARK_ITERATIONS must be an integer from 1 to 20');
}

const installedPackage = JSON.parse(readFileSync(resolve(installedRoot, 'package.json'), 'utf8'));
const candidatePackage = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const { HulyClient: InstalledClient } = await import(pathToFileURL(
  resolve(installedRoot, 'src/client.mjs')
));
const connection = { url: process.env.HULY_URL, workspace };
if (process.env.HULY_TOKEN) connection.token = process.env.HULY_TOKEN;
else {
  connection.email = process.env.HULY_EMAIL;
  connection.password = process.env.HULY_PASSWORD;
}

function instrument(client) {
  const sdk = client._client;
  let calls = 0;
  const counted = new Proxy(sdk, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'findAll' || property === 'findOne') {
        return (...args) => {
          calls += 1;
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    }
  });
  client._getClient = async () => counted;
  return { reset: () => { calls = 0; }, value: () => calls };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function identity(result) {
  if (Array.isArray(result?.items)) return result.items.map(item => item.id);
  if (result?.id) return [result.id];
  if (Number.isFinite(result?.totalIssues)) return [String(result.totalIssues)];
  return [];
}

const baselineEquivalentExpansions = [
  'description', 'comments', 'timeReports', 'relations', 'blockedBy', 'children'
];
const cases = [
  {
    name: 'list_issues_50',
    installed: client => client.listIssues(project, undefined, undefined, undefined, undefined, 50),
    candidate: client => client.listIssues(project, undefined, undefined, undefined, undefined, 50)
  },
  {
    name: 'list_issues_expanded_20',
    installed: client => client.listIssues(project, undefined, undefined, undefined, undefined, 20, true),
    candidate: client => client.listIssues(
      project, undefined, undefined, undefined, undefined, 20, undefined,
      { include: baselineEquivalentExpansions }
    )
  },
  {
    name: 'get_issue_expanded',
    installed: client => client.getIssue(`${project}-1`, { include_details: true }),
    candidate: client => client.getIssue(`${project}-1`, { include: baselineEquivalentExpansions })
  },
  {
    name: 'summarize_project',
    installed: client => client.summarizeProject(project),
    candidate: client => client.summarizeProject(project)
  }
];

const installed = new InstalledClient(connection);
const candidate = new CandidateClient(connection);
try {
  await installed.connect();
  await candidate.connect();
  const counters = { installed: instrument(installed), candidate: instrument(candidate) };
  const clients = { installed, candidate };
  const measurements = [];

  for (const benchmark of cases) {
    const timings = { installed: [], candidate: [] };
    const callTotals = { installed: 0, candidate: 0 };
    let installedResult;
    let candidateResult;
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const order = iteration % 2 === 0 ? ['installed', 'candidate'] : ['candidate', 'installed'];
      for (const variant of order) {
        counters[variant].reset();
        const startedAt = performance.now();
        const result = await benchmark[variant](clients[variant]);
        timings[variant].push(performance.now() - startedAt);
        callTotals[variant] += counters[variant].value();
        if (variant === 'installed') installedResult = result;
        else candidateResult = result;
      }
    }

    const installedText = JSON.stringify(installedResult, null, 2);
    const candidateText = serializeToolResult(candidateResult, 'compact');
    const installedBytes = Buffer.byteLength(installedText);
    const candidateBytes = Buffer.byteLength(candidateText);
    const installedIdentity = identity(installedResult);
    const candidateIdentity = identity(candidateResult);
    measurements.push({
      name: benchmark.name,
      identityAndOrderEqual: JSON.stringify(installedIdentity) === JSON.stringify(candidateIdentity),
      itemCount: candidateIdentity.length,
      installed: {
        version: installedPackage.version,
        bytes: installedBytes,
        sdkCallsPerRequest: callTotals.installed / iterations,
        p50Ms: Number(percentile(timings.installed, 0.5).toFixed(3)),
        p95Ms: Number(percentile(timings.installed, 0.95).toFixed(3))
      },
      candidate: {
        version: candidatePackage.version,
        bytes: candidateBytes,
        sdkCallsPerRequest: callTotals.candidate / iterations,
        p50Ms: Number(percentile(timings.candidate, 0.5).toFixed(3)),
        p95Ms: Number(percentile(timings.candidate, 0.95).toFixed(3))
      },
      byteReductionPercent: Number((100 * (1 - candidateBytes / installedBytes)).toFixed(1)),
      sdkCallReductionPercent: Number((100 * (1 - callTotals.candidate / callTotals.installed)).toFixed(1))
    });
  }

  if (measurements.some(item => !item.identityAndOrderEqual)) {
    throw new Error('Candidate changed task identity or order in installed-package comparison');
  }
  console.log(JSON.stringify({
    schemaVersion: 2,
    workspace,
    project,
    iterations,
    readOnly: true,
    taskSuccess: true,
    measurements
  }, null, 2));
} finally {
  installed.disconnect();
  candidate.disconnect();
}
