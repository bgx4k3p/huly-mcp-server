#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

import { HulyClient } from '../src/client.mjs';
import { serializeToolResult } from '../src/responseMode.mjs';

const workspace = process.env.HULY_BENCHMARK_WORKSPACE;
const project = process.env.HULY_BENCHMARK_PROJECT ?? 'MCPV';
if (!workspace) throw new Error('HULY_BENCHMARK_WORKSPACE is required');

const options = { url: process.env.HULY_URL, workspace };
if (process.env.HULY_TOKEN) options.token = process.env.HULY_TOKEN;
else {
  options.email = process.env.HULY_EMAIL;
  options.password = process.env.HULY_PASSWORD;
}

const client = new HulyClient(options);
const broadIssueExpansions = [
  'description', 'comments', 'timeReports', 'relations', 'blockedBy', 'children'
];

async function runScenario(name, action) {
  const resultTexts = [];
  let calls = 0;
  let retries = 0;
  const startedAt = performance.now();

  async function call(toolName, responseMode, invoke) {
    calls += 1;
    try {
      const result = await invoke();
      resultTexts.push(serializeToolResult(result, responseMode, { toolName }));
      return result;
    } catch (error) {
      retries += 1;
      throw error;
    }
  }

  const taskSuccess = await action(call);
  const outputBytes = resultTexts.reduce((sum, value) => sum + Buffer.byteLength(value), 0);
  return {
    name,
    calls,
    retries,
    outputBytes,
    outputEstimatedTokens: Math.ceil(outputBytes / 4),
    latencyMs: Math.round((performance.now() - startedAt) * 1000) / 1000,
    taskSuccess: Boolean(taskSuccess)
  };
}

try {
  await client.connect();
  const issueId = `${project}-1`;
  const scenarios = [];

  scenarios.push(await runScenario('parent_only_raw_broad', async call => {
    const search = await call('search_issues', 'raw', () => client.searchIssues('Synthetic', project, 20));
    const list = await call('list_issues', 'raw', () => client.listIssues(
      project, undefined, undefined, 'BulkFixture', undefined, 20, undefined,
      { responseMode: 'raw', include: broadIssueExpansions }
    ));
    const detail = await call('get_issue', 'raw', () => client.getIssue(issueId, {
      responseMode: 'raw', include: broadIssueExpansions
    }));
    return search.items.length > 0 && list.items.length > 0 && detail.id === issueId;
  }));

  scenarios.push(await runScenario('parent_only_compact_targeted', async call => {
    const search = await call('search_issues', 'compact', () => client.searchIssues('Synthetic', project, 5));
    const list = await call('list_issues', 'compact', () => client.listIssues(
      project, undefined, undefined, 'BulkFixture', undefined, 10, undefined,
      { responseMode: 'compact', fields: ['title', 'status'] }
    ));
    const detail = await call('get_issue', 'compact', () => client.getIssue(issueId, {
      responseMode: 'compact', fields: ['title', 'status'], include: ['description']
    }));
    return search.items.length > 0 && list.items.length > 0 && detail.id === issueId &&
      typeof detail.description === 'string';
  }));

  scenarios.push(await runScenario('two_subagents_duplicate_huly_reads', async call => {
    const results = await Promise.all([1, 2].map(async () => {
      const search = await call('search_issues', 'compact', () => client.searchIssues('Synthetic', project, 5));
      const detail = await call('get_issue', 'compact', () => client.getIssue(issueId, {
        responseMode: 'compact', fields: ['title', 'status'], include: ['description']
      }));
      return search.items.length > 0 && detail.id === issueId;
    }));
    return results.every(Boolean);
  }));

  scenarios.push(await runScenario('coordinated_identifier_handoff', async call => {
    const search = await call('search_issues', 'compact', () => client.searchIssues('Synthetic', project, 5));
    const selectedId = search.items.find(item => item.id === issueId)?.id ?? search.items[0]?.id;
    const detail = await call('get_issue', 'compact', () => client.getIssue(selectedId, {
      responseMode: 'compact', fields: ['title', 'status'], include: ['description']
    }));
    return Boolean(selectedId) && detail.id === selectedId && typeof detail.description === 'string';
  }));

  const byName = new Map(scenarios.map(item => [item.name, item]));
  const broad = byName.get('parent_only_raw_broad');
  const targeted = byName.get('parent_only_compact_targeted');
  const duplicated = byName.get('two_subagents_duplicate_huly_reads');
  const coordinated = byName.get('coordinated_identifier_handoff');
  console.log(JSON.stringify({
    schemaVersion: 1,
    workspace,
    project,
    tokenMetric: 'outputEstimatedTokens (UTF-8 bytes / 4; not provider-counted)',
    taskSuccess: scenarios.every(item => item.taskSuccess),
    comparisons: {
      targetedVsBroad: {
        tokenReductionPercent: Number((100 * (1 - targeted.outputEstimatedTokens / broad.outputEstimatedTokens)).toFixed(1)),
        callReductionPercent: Number((100 * (1 - targeted.calls / broad.calls)).toFixed(1)),
        latencyReductionPercent: Number((100 * (1 - targeted.latencyMs / broad.latencyMs)).toFixed(1))
      },
      coordinatedVsDuplicateSubagents: {
        tokenReductionPercent: Number((100 * (1 - coordinated.outputEstimatedTokens / duplicated.outputEstimatedTokens)).toFixed(1)),
        callReductionPercent: Number((100 * (1 - coordinated.calls / duplicated.calls)).toFixed(1)),
        latencyReductionPercent: Number((100 * (1 - coordinated.latencyMs / duplicated.latencyMs)).toFixed(1))
      }
    },
    scenarios
  }, null, 2));
} finally {
  client.disconnect();
}
