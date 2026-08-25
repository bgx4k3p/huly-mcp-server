#!/usr/bin/env node
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

async function traverse(client, limit) {
  const ids = [];
  let cursor;
  let pages = 0;
  do {
    const page = await client.listIssues(
      project, undefined, undefined, 'BulkFixture', undefined, limit, cursor
    );
    ids.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
    pages += 1;
  } while (cursor);
  return { ids, pages };
}

const client = new HulyClient(options);
try {
  await client.connect();
  const traversals = [];
  for (const limit of [7, 37, 100]) {
    const traversal = await traverse(client, limit);
    traversals.push({
      limit,
      pages: traversal.pages,
      items: traversal.ids.length,
      uniqueItems: new Set(traversal.ids).size,
      ids: traversal.ids
    });
  }

  const expected = traversals[0].ids;
  if (traversals.some(item => JSON.stringify(item.ids) !== JSON.stringify(expected))) {
    throw new Error('Limit metamorphic traversal mismatch');
  }

  const first = await client.listIssues(
    project, undefined, undefined, 'BulkFixture', undefined, 7
  );
  let mismatchedRejected = false;
  try {
    await client.listIssues(
      project, undefined, undefined, 'Performance', undefined, 7, first.nextCursor
    );
  } catch (error) {
    mismatchedRejected = /does not match this query/.test(error.message);
  }
  let tamperedRejected = false;
  try {
    const tampered = `${first.nextCursor.slice(0, -1)}x`;
    await client.listIssues(
      project, undefined, undefined, 'BulkFixture', undefined, 7, tampered
    );
  } catch (error) {
    tamperedRejected = /signature is invalid/.test(error.message);
  }
  if (!mismatchedRejected || !tamperedRejected) {
    throw new Error('Cursor misuse was not rejected');
  }

  const compact = JSON.parse(serializeToolResult(first, 'compact', { toolName: 'list_issues' }));
  if (compact.count !== 7 || compact.hasMore !== true || compact.truncated !== true) {
    throw new Error('Compact continuation metadata mismatch');
  }

  console.log(JSON.stringify({
    workspace,
    project,
    items: expected.length,
    uniqueItems: new Set(expected).size,
    traversals: traversals.map(item => ({
      limit: item.limit,
      pages: item.pages,
      items: item.items,
      uniqueItems: item.uniqueItems
    })),
    mismatchedRejected,
    tamperedRejected,
    compactMetadata: {
      count: compact.count,
      hasMore: compact.hasMore,
      truncated: compact.truncated
    },
    taskSuccess: true
  }, null, 2));
} finally {
  client.disconnect();
}
