#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  countToolResultTokens,
  countToolResultTokensWithClaudeCli,
  DEFAULT_TOKEN_MODEL
} from '../src/tokenCount.mjs';
import { serializeToolResult } from '../src/responseMode.mjs';

const corpusPath = resolve('test/fixtures/response-corpus.json');
const budgetPath = resolve('test/fixtures/response-budgets.json');
const corpus = JSON.parse(readFileSync(corpusPath, 'utf8'));
const update = process.argv.includes('--update-tokens');
const useClaudeCli = process.argv.includes('--claude-cli');
const modelArg = process.argv.find(arg => arg.startsWith('--model='));
const model = modelArg ? modelArg.slice('--model='.length) : DEFAULT_TOKEN_MODEL;

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function extraCensus(value, census = { objects: 0, keys: {}, bytes: 0 }) {
  if (Array.isArray(value)) {
    for (const item of value) extraCensus(item, census);
    return census;
  }
  if (!value || typeof value !== 'object') return census;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'extra' && child && typeof child === 'object') {
      census.objects += 1;
      census.bytes += Buffer.byteLength(JSON.stringify(child), 'utf8');
      for (const extraKey of Object.keys(child)) {
        census.keys[extraKey] = (census.keys[extraKey] ?? 0) + 1;
      }
    }
    extraCensus(child, census);
  }
  return census;
}

const measurements = [];
for (const fixture of corpus) {
  const text = JSON.stringify(fixture.result, null, 2);
  const compactText = serializeToolResult(fixture.result, 'compact');
  const measurement = {
    name: fixture.name,
    tool: fixture.tool,
    sha256: sha256(text),
    bytes: Buffer.byteLength(text, 'utf8'),
    extra: extraCensus(fixture.result),
    compactSha256: sha256(compactText),
    compactBytes: Buffer.byteLength(compactText, 'utf8')
  };
  if (update) {
    const counted = useClaudeCli
      ? countToolResultTokensWithClaudeCli(text, { model })
      : await countToolResultTokens(text, { model });
    Object.assign(measurement, counted);
    const compactCounted = useClaudeCli
      ? countToolResultTokensWithClaudeCli(compactText, { model })
      : await countToolResultTokens(compactText, { model });
    measurement.compactTokens = compactCounted.tokens;
  }
  measurements.push(measurement);
}

if (update) {
  console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), measurements }, null, 2));
  process.exit(0);
}

const budgets = JSON.parse(readFileSync(budgetPath, 'utf8'));
const failures = [];
for (const measurement of measurements) {
  const budget = budgets.measurements.find(item => item.name === measurement.name);
  if (!budget) {
    failures.push(`${measurement.name}: missing budget`);
    continue;
  }
  if (budget.sha256 !== measurement.sha256) {
    failures.push(`${measurement.name}: fixture hash changed; recount tokens with --update-tokens`);
  }
  if (measurement.bytes > budget.maxBytes) {
    failures.push(`${measurement.name}: ${measurement.bytes} bytes exceeds ${budget.maxBytes}`);
  }
  if (budget.compactSha256 !== measurement.compactSha256) {
    failures.push(`${measurement.name}: compact fixture hash changed; recount tokens with --update-tokens`);
  }
  if (measurement.compactBytes > budget.maxCompactBytes) {
    failures.push(`${measurement.name}: ${measurement.compactBytes} compact bytes exceeds ${budget.maxCompactBytes}`);
  }
  if (Number.isInteger(budget.compactTokens) && budget.compactTokens > budget.maxCompactTokens) {
    failures.push(`${measurement.name}: ${budget.compactTokens} compact tokens exceeds ${budget.maxCompactTokens}`);
  }
  if (budget.tokens > budget.maxTokens) {
    failures.push(`${measurement.name}: ${budget.tokens} recorded tokens exceeds ${budget.maxTokens}`);
  }
}

const summary = {
  fixtures: measurements.length,
  bytes: measurements.reduce((sum, item) => sum + item.bytes, 0),
  recordedTokens: budgets.measurements.reduce((sum, item) => sum + item.tokens, 0),
  compactBytes: measurements.reduce((sum, item) => sum + item.compactBytes, 0),
  recordedCompactTokens: budgets.measurements.every(item => Number.isInteger(item.compactTokens))
    ? budgets.measurements.reduce((sum, item) => sum + item.compactTokens, 0)
    : null,
  byteReductionPercent: Number((100 * (1 - (
    measurements.reduce((sum, item) => sum + item.compactBytes, 0) /
    measurements.reduce((sum, item) => sum + item.bytes, 0)
  ))).toFixed(1)),
  tokenReductionPercent: budgets.measurements.every(item => Number.isInteger(item.compactTokens))
    ? Number((100 * (1 - (
      budgets.measurements.reduce((sum, item) => sum + item.compactTokens, 0) /
      budgets.measurements.reduce((sum, item) => sum + item.tokens, 0)
    ))).toFixed(1))
    : null,
  extraBytes: measurements.reduce((sum, item) => sum + item.extra.bytes, 0),
  extraKeys: measurements.reduce((all, item) => {
    for (const [key, count] of Object.entries(item.extra.keys)) {
      all[key] = (all[key] ?? 0) + count;
    }
    return all;
  }, {})
};

if (failures.length > 0) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(JSON.stringify(summary, null, 2));
