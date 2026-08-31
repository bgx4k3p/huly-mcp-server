#!/usr/bin/env node
/**
 * Rebuild the disposable live-validation fixtures.
 *
 * The fixtures were originally hand-built in an interactive session, which put
 * them in a real workspace. Keeping the seeder in the repository makes the
 * fixture set reproducible and lets the safety guard below refuse any target
 * that is not obviously disposable.
 *
 * Usage:
 *   HULY_SEED_WORKSPACE=<slug> node scripts/seed-validation-fixtures.mjs
 *   ... --force   skip the disposable-workspace guard (never use on real data)
 */
import { HulyClient } from '../src/client.mjs';

const workspace = process.env.HULY_SEED_WORKSPACE;
const projectId = process.env.HULY_SEED_PROJECT ?? 'MCPV';
const force = process.argv.includes('--force');

if (!workspace) throw new Error('HULY_SEED_WORKSPACE is required');

const ISSUE_COUNT = 125;
const MILESTONE = 'Validation Milestone';
const COMPONENT = 'Validation API';
const BULK_LABEL = 'BulkFixture';
const PERF_LABEL = 'Performance';
// 001 is urgent, matching the original fixture set; the cycle gives 25 each.
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];

const client = new HulyClient({
  url: process.env.HULY_URL,
  token: process.env.HULY_TOKEN,
  email: process.env.HULY_EMAIL,
  password: process.env.HULY_PASSWORD,
  workspace
});

/**
 * Refuse to seed a workspace that holds real work. A disposable validation
 * workspace contains nothing but the fixture project and Huly's own empty
 * default project.
 */
async function assertDisposable() {
  const { items: projects } = await client.listProjects();
  const foreign = projects.filter(p => p.identifier !== projectId && p.issueCount > 0);
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to seed "${workspace}": it holds real work — ` +
      foreign.map(p => `${p.identifier} (${p.issueCount} issues)`).join(', ') +
      '. Target a disposable workspace, or pass --force if you are certain.'
    );
  }
  return projects;
}

const projects = force ? (await client.listProjects()).items : await assertDisposable();

if (!projects.some(p => p.identifier === projectId)) {
  await client.createProject(
    projectId,
    'MCP Validation Fixtures',
    'Isolated synthetic fixtures for Huly MCP compatibility, performance, and regression testing.',
    false,
    'Classic project'
  );
  console.log(`created project ${projectId}`);
}

const { items: existing } = await client.listIssues(projectId, undefined, undefined, undefined, undefined, 1);
if (existing.length > 0) {
  throw new Error(`${projectId} already contains issues; delete the project first to reseed from scratch.`);
}

await client.createMilestone(projectId, MILESTONE, 'Bounded milestone expansion fixture', undefined, 'planned');
await client.createComponent(projectId, COMPONENT, 'Bounded component fixture');
console.log(`created milestone "${MILESTONE}" and component "${COMPONENT}"`);

for (let n = 1; n <= ISSUE_COUNT; n += 1) {
  const number = String(n).padStart(3, '0');
  const labels = n % 2 === 1 ? [BULK_LABEL, PERF_LABEL] : [BULK_LABEL];
  await client.createIssue(
    projectId,
    `Synthetic pagination fixture ${number}`,
    `Synthetic fixture body ${number}. Deterministic filler so description ` +
      'projection, preview truncation, and byte budgets have stable input. ' +
      'This text is intentionally long enough to exercise the 500-character ' +
      'list preview without being long enough to dominate a benchmark.',
    PRIORITIES[(n - 1) % PRIORITIES.length],
    undefined,
    labels,
    undefined,
    { component: COMPONENT, milestone: MILESTONE, estimation: 1 + (n % 4) }
  );
  if (n % 25 === 0) console.log(`  seeded ${n}/${ISSUE_COUNT}`);
}

// Nested-collection fixtures. Issue 1 is deliberately over-filled: the
// projection gate reads it with commentsLimit 5, activityLimit 4, and
// timeReportsLimit 3, and requires every collection to report truncation, so
// each one must hold more than its limit.
const RICH_COMMENTS = 8;
const RICH_TIME_REPORTS = 5;
const richIssue = `${projectId}-1`;
for (let n = 1; n <= RICH_COMMENTS; n += 1) {
  await client.addComment(richIssue, `Fixture comment ${n} on ${richIssue}`);
}
for (let n = 1; n <= RICH_TIME_REPORTS; n += 1) {
  await client.logTime(richIssue, 1.5, `Fixture time report ${n} on ${richIssue}`);
}
console.log(`seeded ${RICH_COMMENTS} comments and ${RICH_TIME_REPORTS} time reports on ${richIssue}`);

// A few ordinary issues carry small collections so the unbounded case is
// covered too.
for (let n = 2; n <= 6; n += 1) {
  const issueId = `${projectId}-${n}`;
  await client.addComment(issueId, `Fixture comment A on ${issueId}`);
  await client.addComment(issueId, `Fixture comment B on ${issueId}`);
  await client.logTime(issueId, 1.5, `Fixture time report on ${issueId}`);
}
console.log('seeded small collections on issues 2-6');

const { items: seeded } = await client.listIssues(projectId, undefined, undefined, undefined, undefined, 100);
console.log(`\ndone: ${projectId} in "${workspace}" — first page returned ${seeded.length} issues`);
process.exit(0);
