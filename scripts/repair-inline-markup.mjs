#!/usr/bin/env node
/**
 * Repair milestone and component descriptions stored as MarkupContent objects.
 *
 * Huly types Milestone.description and Component.description as `Markup` — a
 * string holding a ProseMirror JSON document. Versions of this MCP server up to
 * 3.0.2 handed the SDK's MarkupContent wrapper straight to TxOperations, which
 * persisted {"content":..,"kind":..} verbatim. Those documents read back
 * correctly through this server (fromMarkup unwraps them) but render as an
 * empty description in the Huly UI.
 *
 * This script rewrites only affected documents, re-encoding the wrapper's own
 * content with its declared format. Documents already holding a string are left
 * untouched, so it is safe to re-run.
 *
 * The script is dry-run by default. Pass --apply to write changes.
 */
import { createRequire } from 'module';

import { HulyClient } from '../src/client.mjs';
import { normalizeMarkup, toMarkup } from '../src/helpers.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const chunter = require('@hcengineering/chunter').default;
const { jsonToPmNode, markupToJSON } = require('@hcengineering/text');

const args = new Set(process.argv.slice(2));
const apply = args.has('--apply');
const workspaceFilter = valueArg('--workspace');
const projectFilter = valueArg('--project')?.toUpperCase();
const onlyFilter = valueArg('--only')?.toLowerCase();
const limit = valueArg('--limit') ? Number(valueArg('--limit')) : Infinity;
const includeComments = args.has('--include-comments');
// Documents that fail the editor's strict schema check but that Huly's renderer
// still displays correctly (a text node carrying both bold and code, say) are
// left alone by default: rewriting them drops a mark and changes nothing on
// screen. Only documents that actually render blank are repaired.
const normalizeSchema = args.has('--normalize-schema');

// Comment messages carry the same defect but are opt-in: they are attached
// collection documents, so repairing them is a separate decision from repairing
// the milestone and component descriptions the tools write directly.
const TARGETS = [
  { name: 'milestone', classRef: tracker.class.Milestone, field: 'description', labelled: true },
  { name: 'component', classRef: tracker.class.Component, field: 'description', labelled: true },
  { name: 'comment', classRef: chunter.class.ChatMessage, field: 'message', labelled: false }
];

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
    'Usage: node scripts/repair-inline-markup.mjs [--apply] [--workspace=slug]',
    '                                             [--project=IDENT] [--only=label] [--limit=N]',
    '',
    '  --only=label         repair only documents whose label matches (case-insensitive)',
    '  --limit=N            stop after N documents — use --limit=1 to verify one in the UI first',
    '  --include-comments   also repair comment messages (censused but skipped by default)',
    '  --normalize-schema   also rewrite documents that fail the strict editor schema',
    '                       but still render correctly — lossy, off by default',
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
 * Classify why a stored value needs repair.
 *
 * "wrapper" — a MarkupContent-shaped object where a ProseMirror JSON string
 *             belongs; the UI renders nothing.
 * "schema"  — a valid JSON string that violates the editor schema, e.g. a text
 *             node carrying both bold and code marks; the UI also renders
 *             nothing, so it needs re-normalizing rather than re-encoding.
 */
function classify(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object' && typeof value.content === 'string') return 'wrapper';
  if (typeof value !== 'string') return null;
  try {
    jsonToPmNode(markupToJSON(value)).check();
    return null;
  } catch {
    return 'schema';
  }
}

/**
 * Scan one workspace and rewrite affected descriptions.
 */
async function repairWorkspace({ url, creds, workspace, budget }) {
  const huly = new HulyClient({ url, ...creds, workspace });
  await huly.connect();
  try {
    const sdk = await huly._getClient();
    const projects = (await sdk.findAll(tracker.class.Project, {}))
      .filter(project => !projectFilter || project.identifier === projectFilter);
    const spaces = new Map(projects.map(project => [project._id, project.identifier]));

    const summary = {
      workspace,
      projects: projects.length,
      scanned: 0,
      changed: 0,
      dryRun: !apply,
      changes: []
    };

    for (const target of TARGETS) {
      if (target.name === 'comment' && !includeComments) {
        // Still census them so a scan never hides known-broken documents.
        const found = (await sdk.findAll(target.classRef, {}))
          .filter(doc => spaces.has(doc.space) && classify(doc[target.field]) !== null);
        summary.commentsSkipped = found.length;
        continue;
      }

      const docs = await sdk.findAll(target.classRef, {});
      for (const doc of docs) {
        if (!spaces.has(doc.space)) continue;
        summary.scanned += 1;
        const value = doc[target.field];
        const reason = classify(value);
        if (reason === null) continue;
        if (reason === 'schema' && !normalizeSchema) continue;
        if (onlyFilter && (doc.label || '').toLowerCase() !== onlyFilter) continue;
        if (summary.changed >= budget.remaining) continue;

        const repaired = reason === 'wrapper'
          ? toMarkup(value.content, value.kind || 'markdown')
          : normalizeMarkup(value);
        const preview = reason === 'wrapper' ? value.content : (doc.label ?? String(doc._id));

        summary.changed += 1;
        summary.changes.push({
          type: target.name,
          reason,
          project: spaces.get(doc.space),
          label: target.labelled ? doc.label : doc._id,
          preview: preview.replace(/\s+/g, ' ').slice(0, 72)
        });

        if (apply) {
          await sdk.updateDoc(target.classRef, doc.space, doc._id, { [target.field]: repaired });
        }
      }
    }

    budget.remaining -= summary.changed;
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

  const budget = { remaining: limit };
  const summaries = [];
  const failures = [];

  for (const ws of workspaces) {
    const workspace = ws.slug || ws.workspace || ws.name;
    if (!workspace) continue;
    try {
      const summary = await repairWorkspace({ url, creds, workspace, budget });
      summaries.push(summary);
      console.error(
        `[${workspace}] scanned ${summary.scanned}, ` +
        `${apply ? 'repaired' : 'would repair'} ${summary.changed}`
      );
    } catch (error) {
      failures.push({ workspace, error: error.message });
      console.error(`[${workspace}] failed: ${error.message}`);
    }
  }

  const totals = summaries.reduce((acc, summary) => ({
    scanned: acc.scanned + summary.scanned,
    changed: acc.changed + summary.changed
  }), { scanned: 0, changed: 0 });

  console.log(JSON.stringify({
    apply,
    workspaceFilter,
    projectFilter,
    onlyFilter,
    includeComments,
    normalizeSchema,
    limit: Number.isFinite(limit) ? limit : null,
    totals,
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
