#!/usr/bin/env node
import { performance } from 'node:perf_hooks';

import { HulyClient } from '../src/client.mjs';
import { serializeToolResult } from '../src/responseMode.mjs';

const workspace = process.env.HULY_BENCHMARK_WORKSPACE;
const project = process.env.HULY_BENCHMARK_PROJECT ?? 'MCPV';
const iterations = Number.parseInt(process.env.HULY_BENCHMARK_ITERATIONS ?? '3', 10);
if (!workspace) throw new Error('HULY_BENCHMARK_WORKSPACE is required');
if (!Number.isInteger(iterations) || iterations < 1 || iterations > 20) {
  throw new Error('HULY_BENCHMARK_ITERATIONS must be an integer from 1 to 20');
}

const options = { url: process.env.HULY_URL, workspace };
if (process.env.HULY_TOKEN) options.token = process.env.HULY_TOKEN;
else {
  options.email = process.env.HULY_EMAIL;
  options.password = process.env.HULY_PASSWORD;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

const client = new HulyClient(options);
try {
  await client.connect();
  const sdk = client._client;
  let sdkCalls = 0;
  const countedSdk = new Proxy(sdk, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (property === 'findAll' || property === 'findOne') {
        return (...args) => {
          sdkCalls += 1;
          return Reflect.apply(value, target, args);
        };
      }
      return value.bind(target);
    }
  });
  client._getClient = async () => countedSdk;

  async function measure(name, responseMode, readOptions) {
    const samples = [];
    let bytes = 0;
    let calls = 0;
    let ids = [];
    for (let index = 0; index < iterations; index += 1) {
      sdkCalls = 0;
      const startedAt = performance.now();
      const page = await client.listIssues(
        project, undefined, undefined, 'BulkFixture', undefined, 50, undefined,
        readOptions
      );
      samples.push(performance.now() - startedAt);
      calls += sdkCalls;
      ids = page.items.map(item => item.id);
      bytes = Buffer.byteLength(serializeToolResult(page, responseMode, { toolName: 'list_issues' }));
    }
    return {
      name,
      calls: iterations,
      sdkCalls: calls,
      sdkCallsPerRequest: calls / iterations,
      bytes,
      estimatedTokens: Math.ceil(bytes / 4),
      p50Ms: Math.round(percentile(samples, 0.5) * 1000) / 1000,
      p95Ms: Math.round(percentile(samples, 0.95) * 1000) / 1000,
      ids,
      taskSuccess: ids.length === 50 && new Set(ids).size === 50
    };
  }

  const raw = await measure('raw_complete_fields', 'raw', { responseMode: 'raw' });
  const compact = await measure('compact_default_projection', 'compact', { responseMode: 'compact' });
  if (JSON.stringify(raw.ids) !== JSON.stringify(compact.ids)) {
    throw new Error('Projected list changed issue identity or order');
  }

  sdkCalls = 0;
  const detailsStartedAt = performance.now();
  const details = await client.getIssue(`${project}-1`, {
    responseMode: 'compact',
    fields: ['title'],
    include: ['comments', 'activity', 'timeReports'],
    commentsLimit: 5,
    activityLimit: 4,
    timeReportsLimit: 3
  });
  const detailLatencyMs = performance.now() - detailsStartedAt;
  const detailSdkCalls = sdkCalls;
  if (details.comments.length !== 5 || details.commentsCount < 5 || !details.commentsTruncated) {
    throw new Error('Comment bounds were not explicit');
  }
  if (details.timeReports.length !== 3 || details.timeReportsCount < 3 || !details.timeReportsTruncated) {
    throw new Error('Time-report bounds were not explicit');
  }
  if (details.activity.length !== 4 || details.activityCount < 4 || !details.activityTruncated) {
    throw new Error('Activity bounds were not explicit');
  }

  const defaultIssue = await client.getIssue(`${project}-1`, { responseMode: 'compact' });
  const explicitFullIssue = await client.getIssue(`${project}-1`, {
    responseMode: 'compact', include: ['description'], descriptionPreviewChars: 0
  });
  if (defaultIssue.description !== explicitFullIssue.description || defaultIssue.descriptionTruncated) {
    throw new Error('get_issue default description was truncated or changed');
  }

  const byteReductionPercent = Number((100 * (1 - (compact.bytes / raw.bytes))).toFixed(1));
  const callReductionPercent = Number((100 * (1 - (compact.sdkCalls / raw.sdkCalls))).toFixed(1));
  console.log(JSON.stringify({
    schemaVersion: 1,
    workspace,
    project,
    iterations,
    taskSuccess: raw.taskSuccess && compact.taskSuccess,
    byteReductionPercent,
    callReductionPercent,
    raw: { ...raw, ids: undefined },
    compact: { ...compact, ids: undefined },
    granularDetails: {
      sdkCalls: detailSdkCalls,
      latencyMs: Math.round(detailLatencyMs * 1000) / 1000,
      comments: { returned: details.comments.length, total: details.commentsCount, truncated: details.commentsTruncated },
      activity: { returned: details.activity.length, total: details.activityCount, truncated: details.activityTruncated },
      timeReports: { returned: details.timeReports.length, total: details.timeReportsCount, truncated: details.timeReportsTruncated }
    },
    getIssueFullDescriptionPreserved: true
  }, null, 2));
} finally {
  client.disconnect();
}
