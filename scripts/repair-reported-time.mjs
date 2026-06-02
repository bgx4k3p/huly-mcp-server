#!/usr/bin/env node
/**
 * Repair denormalized Huly issue reported-time totals.
 *
 * Huly stores individual time entries as TimeSpendReport child documents and
 * also stores an aggregate Issue.reportedTime field. Versions before 2.4.3 of
 * this MCP server could write string-concatenated aggregates when logging time
 * onto issues whose existing reportedTime field was a string. This script
 * treats TimeSpendReport values as the source of truth and rewrites only the
 * aggregate issue field.
 *
 * The script is dry-run by default. Pass --apply to write changes.
 */
import { createRequire } from 'module';

import { HulyClient } from '../src/client.mjs';
import { toHours } from '../src/helpers.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const workspaceFilter = valueArg('--workspace');
const projectFilter = valueArg('--project')?.toUpperCase();

function valueArg(name) {
  const prefix = `${name}=`;
  const found = process.argv.slice(2).find(arg => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

/**
 * Return CLI help text without including any environment values.
 */
function usage() {
  return [
    'Usage: node scripts/repair-reported-time.mjs [--apply] [--workspace=slug] [--project=IDENT]',
    '',
    'Environment:',
    '  HULY_URL',
    '  HULY_TOKEN or HULY_EMAIL + HULY_PASSWORD'
  ].join('\n');
}

/**
 * Load Huly credentials from the environment.
 *
 * Secrets are intentionally not accepted as CLI arguments so they do not appear
 * in shell history or process listings.
 */
function credentialsFromEnv() {
  if (process.env.HULY_TOKEN) return { token: process.env.HULY_TOKEN };
  if (process.env.HULY_EMAIL && process.env.HULY_PASSWORD) {
    return { email: process.env.HULY_EMAIL, password: process.env.HULY_PASSWORD };
  }
  throw new Error('Missing auth: set HULY_TOKEN or HULY_EMAIL + HULY_PASSWORD');
}

/**
 * Compare hour totals with a tiny tolerance for decimal serialization noise.
 */
function sameHours(a, b) {
  return Math.abs(toHours(a) - toHours(b)) < 0.000001;
}

/**
 * Normalize and round hour totals before writing them back to Huly.
 */
function roundedHours(value) {
  return Number(toHours(value).toFixed(6));
}

/**
 * Fetch all documents for a class using the client's cursor pagination helper.
 */
async function fetchAll(huly, sdk, classRef, query) {
  const all = [];
  let cursor;
  do {
    const page = await huly._paginatedFindAll(sdk, classRef, query, {
      limit: 500,
      cursor
    });
    all.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return all;
}

/**
 * Scan one workspace and repair mismatched Issue.reportedTime fields.
 *
 * A string current value is repaired even if it is numerically equivalent
 * ("05" -> 5), because the purpose is to restore the stored type as well as
 * the aggregate value.
 */
async function repairWorkspace({ url, creds, workspace }) {
  const huly = new HulyClient({ url, ...creds, workspace });
  await huly.connect();
  try {
    const sdk = await huly._getClient();
    const projects = (await sdk.findAll(tracker.class.Project, {}))
      .filter(project => !projectFilter || project.identifier === projectFilter);
    const allReports = await fetchAll(huly, sdk, tracker.class.TimeSpendReport, {});
    const reportsByIssue = new Map();
    for (const report of allReports) {
      if (!reportsByIssue.has(report.attachedTo)) reportsByIssue.set(report.attachedTo, []);
      reportsByIssue.get(report.attachedTo).push(report);
    }

    const summary = {
      workspace,
      projects: projects.length,
      issuesScanned: 0,
      issuesChanged: 0,
      dryRun: !apply,
      changes: []
    };

    for (const project of projects) {
      const issues = await fetchAll(huly, sdk, tracker.class.Issue, { space: project._id });
      for (const issue of issues) {
        summary.issuesScanned += 1;
        const reports = reportsByIssue.get(issue._id) || [];
        const expected = roundedHours(reports.reduce((sum, report) => sum + toHours(report.value), 0));
        const current = issue.reportedTime;
        if (sameHours(current, expected) && typeof current !== 'string') continue;

        const issueId = `${project.identifier}-${issue.number}`;
        summary.issuesChanged += 1;
        summary.changes.push({
          issueId,
          current,
          expected,
          reports: reports.length
        });

        if (apply) {
          await sdk.updateDoc(tracker.class.Issue, project._id, issue._id, {
            reportedTime: expected
          });
        }
      }
    }

    return summary;
  } finally {
    huly.disconnect();
  }
}

async function main() {
  if (args.has('--help') || args.has('-h')) {
    console.log(usage());
    return;
  }

  const url = process.env.HULY_URL;
  if (!url) throw new Error('Missing HULY_URL');
  const creds = credentialsFromEnv();
  const workspaces = workspaceFilter
    ? [{ slug: workspaceFilter }]
    : await HulyClient.listWorkspaces(url, creds);

  const summaries = [];
  const failures = [];

  for (const ws of workspaces) {
    const workspace = ws.slug || ws.workspace || ws.name;
    if (!workspace) continue;
    try {
      const summary = await repairWorkspace({ url, creds, workspace });
      summaries.push(summary);
      console.error(
        `[${workspace}] scanned ${summary.issuesScanned} issues, ` +
        `${apply ? 'updated' : 'would update'} ${summary.issuesChanged}`
      );
    } catch (error) {
      failures.push({ workspace, error: error.message });
      console.error(`[${workspace}] failed: ${error.message}`);
    }
  }

  const total = summaries.reduce((acc, summary) => ({
    projects: acc.projects + summary.projects,
    issuesScanned: acc.issuesScanned + summary.issuesScanned,
    issuesChanged: acc.issuesChanged + summary.issuesChanged
  }), { projects: 0, issuesScanned: 0, issuesChanged: 0 });

  console.log(JSON.stringify({
    apply,
    workspaceFilter,
    projectFilter,
    totals: total,
    workspaces: summaries,
    failures
  }, null, 2));

  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
