#!/usr/bin/env node
/**
 * Workspace Migration Script
 *
 * Migrates all issues from one workspace to another, preserving:
 * - Exact issue numbering (PROJ-1 through PROJ-N)
 * - Title, description, status, priority, type, assignee
 * - Component, milestone, estimation, dueDate, labels
 * - Comments (text + author attribution in body)
 * - Parent-child hierarchy
 * - Relations and blocked-by links
 * - Time reports
 *
 * Usage:
 *   node scripts/migrate-workspace.mjs \
 *     --from source-workspace --to target-workspace \
 *     --project PROJ [--dry-run] [--type-map "Issue:Task"]
 *
 * Env vars: HULY_URL, HULY_EMAIL, HULY_PASSWORD (or HULY_TOKEN)
 */

import { pool } from '../src/pool.mjs';

// ── CLI args ──────────────────────────────────────────────────
const args = process.argv.slice(2);
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return undefined;
  return args[i + 1] || true;
}

const FROM_WS = flag('from');
const TO_WS = flag('to');
const PROJECT = flag('project');
const DRY_RUN = args.includes('--dry-run');
const BATCH_SIZE = 500;

// Parse --type-map "Issue:Task,Epic:Epic" into { Issue: 'Task', Epic: 'Epic' }
const TYPE_MAP = {};
const typeMapStr = flag('type-map');
if (typeMapStr) {
  for (const pair of typeMapStr.split(',')) {
    const [from, to] = pair.split(':').map(s => s.trim());
    if (from && to) TYPE_MAP[from] = to;
  }
}

if (!FROM_WS || !TO_WS || !PROJECT) {
  console.error('Usage: node scripts/migrate-workspace.mjs --from <ws> --to <ws> --project <IDENT> [--dry-run] [--type-map "Issue:Task"]');
  process.exit(1);
}

const log = (msg) => console.log(`  ${msg}`);
const ok = (msg) => console.log(`  \x1b[32mOK\x1b[0m  ${msg}`);
const warn = (msg) => console.log(`  \x1b[33m!!\x1b[0m  ${msg}`);
const err = (msg) => console.error(`  \x1b[31mERR\x1b[0m ${msg}`);

// ── Main ──────────────────────────────────────────────────────
async function main() {
  console.log(`\nMigrate ${PROJECT} from "${FROM_WS}" → "${TO_WS}"${DRY_RUN ? ' (DRY RUN)' : ''}\n`);
  if (Object.keys(TYPE_MAP).length > 0) {
    log(`Type mapping: ${Object.entries(TYPE_MAP).map(([f, t]) => `${f} → ${t}`).join(', ')}`);
  }

  // Connect to both workspaces
  log('Connecting to source workspace...');
  const src = await pool.getClient(FROM_WS);
  ok(`Connected to ${FROM_WS}`);

  log('Connecting to target workspace...');
  const dst = await pool.getClient(TO_WS);
  ok(`Connected to ${TO_WS}`);

  // ── Step 1: Read all issues from source ─────────────────────
  log('Reading source issues...');
  const sourceIssues = await src.listIssues(PROJECT, null, null, null, null, 1000, true);
  ok(`Found ${sourceIssues.length} issues`);

  // Sort by issue number to preserve ordering
  sourceIssues.sort((a, b) => {
    const numA = parseInt(a.id.split('-')[1]);
    const numB = parseInt(b.id.split('-')[1]);
    return numA - numB;
  });

  // Verify contiguous numbering
  const numbers = sourceIssues.map(i => parseInt(i.id.split('-')[1]));
  const minNum = numbers[0];
  const maxNum = numbers[numbers.length - 1];
  const expected = maxNum - minNum + 1;
  if (numbers.length !== expected) {
    const gaps = [];
    for (let n = minNum; n <= maxNum; n++) {
      if (!numbers.includes(n)) gaps.push(n);
    }
    warn(`Numbering has ${gaps.length} gap(s): ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`);
    warn('Gap issues will be created as placeholders and deleted after');
  }
  ok(`Issues numbered ${PROJECT}-${minNum} through ${PROJECT}-${maxNum}`);

  // ── Step 2: Collect metadata ────────────────────────────────
  // Build lookup maps for post-processing
  const parentChildPairs = []; // { childId, parentId } using old identifiers
  const relations = [];        // { sourceId, targetId }
  const blockedBy = [];        // { sourceId, blockedById }
  const commentsMap = {};      // oldId -> [{ text, createdBy, createdOn }]
  const timeReportsMap = {};   // oldId -> [{ hours, description }]

  for (const issue of sourceIssues) {
    const id = issue.id;

    // Parent-child: issue.parent is the parent's identifier (e.g. "PROJ-5")
    if (issue.parent) {
      parentChildPairs.push({ childId: id, parentId: issue.parent });
    }

    // Relations and blocked-by from include_details
    if (issue.relations) {
      for (const rel of issue.relations) {
        // Avoid duplicates (bidirectional)
        const key = [id, rel.id].sort().join(':');
        if (!relations.find(r => [r.sourceId, r.targetId].sort().join(':') === key)) {
          relations.push({ sourceId: id, targetId: rel.id });
        }
      }
    }
    if (issue.blockedBy) {
      for (const bl of issue.blockedBy) {
        blockedBy.push({ sourceId: id, blockedById: bl.id });
      }
    }

    // Comments
    if (issue.comments && issue.comments.length > 0) {
      commentsMap[id] = issue.comments.map(c => ({
        text: c.text,
        createdBy: c.createdBy || 'unknown',
        createdOn: c.createdOn
      }));
    }

    // Time reports
    if (issue.timeReports && issue.timeReports.length > 0) {
      timeReportsMap[id] = issue.timeReports.map(t => ({
        hours: t.hours,
        description: t.description || ''
      }));
    }
  }

  log(`Parent-child pairs: ${parentChildPairs.length}`);
  log(`Relations: ${relations.length}`);
  log(`Blocked-by: ${blockedBy.length}`);
  log(`Issues with comments: ${Object.keys(commentsMap).length} (${Object.values(commentsMap).reduce((s, c) => s + c.length, 0)} total)`);
  log(`Issues with time reports: ${Object.keys(timeReportsMap).length} (${Object.values(timeReportsMap).reduce((s, t) => s + t.length, 0)} total)`);

  if (DRY_RUN) {
    console.log('\n  --- DRY RUN complete, no changes made ---\n');
    process.exit(0);
  }

  // ── Step 3: Batch create issues in target ───────────────────
  log('\nCreating issues in target workspace...');

  // Build batch items (sorted by number, include gap placeholders)
  const batchItems = [];
  let nextExpected = minNum;
  for (const issue of sourceIssues) {
    const num = parseInt(issue.id.split('-')[1]);
    // Fill gaps with placeholders
    while (nextExpected < num) {
      batchItems.push({
        title: `[PLACEHOLDER-${nextExpected}]`,
        status: issue.status, // use any valid status
        priority: 'none',
        _isPlaceholder: true,
        _number: nextExpected
      });
      nextExpected++;
    }
    batchItems.push({
      title: issue.title,
      description: issue.description || '',
      status: issue.status,
      priority: issue.priority || 'none',
      type: TYPE_MAP[issue.type] || issue.type,
      assignee: issue.assignee || undefined,
      component: issue.component || undefined,
      milestone: issue.milestone || undefined,
      estimation: issue.estimation || 0,
      dueDate: issue.dueDate || undefined,
      labels: issue.labels || [],
      _isPlaceholder: false,
      _number: num
    });
    nextExpected = num + 1;
  }

  // Split into batches of BATCH_SIZE
  const batches = [];
  for (let i = 0; i < batchItems.length; i += BATCH_SIZE) {
    batches.push(batchItems.slice(i, i + BATCH_SIZE));
  }

  const createdIds = []; // Track created issue IDs for post-processing
  const placeholderIds = []; // Track placeholder IDs for deletion

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    log(`Batch ${i + 1}/${batches.length}: ${batch.length} issues...`);

    // Strip internal fields before sending
    const cleanBatch = batch.map(item => {
      const clean = { ...item };
      delete clean._isPlaceholder;
      delete clean._number;
      return clean;
    });

    const result = await dst.batchCreateIssues(PROJECT, cleanBatch);

    if (result.errors && result.errors.length > 0) {
      for (const e of result.errors) {
        err(`Failed: ${e.error} (${JSON.stringify(e.input?.title || e.input)})`);
      }
    }

    // Map created IDs back
    let createdIdx = 0;
    for (const item of batch) {
      if (result.created && createdIdx < result.created.length) {
        const created = result.created[createdIdx];
        if (item._isPlaceholder) {
          placeholderIds.push(created.id);
        }
        createdIds.push({
          oldId: `${PROJECT}-${item._number}`,
          newId: created.id,
          isPlaceholder: item._isPlaceholder
        });
        createdIdx++;
      }
    }

    ok(`Batch ${i + 1}: ${result.total} created`);
  }

  // Verify numbering matches
  const realCreated = createdIds.filter(c => !c.isPlaceholder);
  const mismatches = realCreated.filter(c => c.oldId !== c.newId);
  if (mismatches.length > 0) {
    err(`Numbering mismatch on ${mismatches.length} issues!`);
    for (const m of mismatches.slice(0, 5)) {
      err(`  ${m.oldId} → ${m.newId}`);
    }
  } else {
    ok(`All ${realCreated.length} issue numbers match`);
  }

  // ── Step 4: Set parent-child relationships ──────────────────
  if (parentChildPairs.length > 0) {
    log(`\nSetting ${parentChildPairs.length} parent-child relationships...`);
    let parentOk = 0;
    for (const { childId, parentId } of parentChildPairs) {
      try {
        await dst.setParent(childId, parentId);
        parentOk++;
      } catch (e) {
        err(`setParent(${childId}, ${parentId}): ${e.message}`);
      }
    }
    ok(`${parentOk}/${parentChildPairs.length} parent-child set`);
  }

  // ── Step 5: Add relations ───────────────────────────────────
  if (relations.length > 0) {
    log(`\nAdding ${relations.length} relations...`);
    let relOk = 0;
    for (const { sourceId, targetId } of relations) {
      try {
        await dst.addRelation(sourceId, targetId);
        relOk++;
      } catch (e) {
        err(`addRelation(${sourceId}, ${targetId}): ${e.message}`);
      }
    }
    ok(`${relOk}/${relations.length} relations added`);
  }

  // ── Step 6: Add blocked-by ──────────────────────────────────
  if (blockedBy.length > 0) {
    log(`\nAdding ${blockedBy.length} blocked-by links...`);
    let blOk = 0;
    for (const { sourceId, blockedById } of blockedBy) {
      try {
        await dst.addBlockedBy(sourceId, blockedById);
        blOk++;
      } catch (e) {
        err(`addBlockedBy(${sourceId}, ${blockedById}): ${e.message}`);
      }
    }
    ok(`${blOk}/${blockedBy.length} blocked-by set`);
  }

  // ── Step 7: Add comments ────────────────────────────────────
  const totalComments = Object.values(commentsMap).reduce((s, c) => s + c.length, 0);
  if (totalComments > 0) {
    log(`\nAdding ${totalComments} comments...`);
    let commentOk = 0;
    for (const [issueId, comments] of Object.entries(commentsMap)) {
      // Sort by createdOn to preserve order
      comments.sort((a, b) => (a.createdOn || 0) - (b.createdOn || 0));
      for (const c of comments) {
        try {
          // Attribute the comment in the body since we can't set createdBy
          const attributed = `**${c.createdBy}** (migrated):\n\n${c.text}`;
          await dst.addComment(issueId, attributed, 'markdown');
          commentOk++;
        } catch (e) {
          err(`addComment(${issueId}): ${e.message}`);
        }
      }
    }
    ok(`${commentOk}/${totalComments} comments added`);
  }

  // ── Step 8: Log time reports ────────────────────────────────
  const totalTimeReports = Object.values(timeReportsMap).reduce((s, t) => s + t.length, 0);
  if (totalTimeReports > 0) {
    log(`\nLogging ${totalTimeReports} time reports...`);
    let timeOk = 0;
    for (const [issueId, reports] of Object.entries(timeReportsMap)) {
      for (const t of reports) {
        try {
          await dst.logTime(issueId, t.hours, t.description || 'migrated');
          timeOk++;
        } catch (e) {
          err(`logTime(${issueId}, ${t.hours}h): ${e.message}`);
        }
      }
    }
    ok(`${timeOk}/${totalTimeReports} time reports logged`);
  }

  // ── Step 9: Delete placeholders ─────────────────────────────
  if (placeholderIds.length > 0) {
    log(`\nDeleting ${placeholderIds.length} placeholder issues...`);
    let delOk = 0;
    for (const id of placeholderIds) {
      try {
        await dst.deleteIssue(id);
        delOk++;
      } catch (e) {
        err(`deleteIssue(${id}): ${e.message}`);
      }
    }
    ok(`${delOk}/${placeholderIds.length} placeholders deleted`);
  }

  // ── Summary ─────────────────────────────────────────────────
  console.log(`
  ════════════════════════════════════════════
  Migration complete: ${PROJECT}
  ────────────────────────────────────────────
  Issues:       ${realCreated.length}
  Parents:      ${parentChildPairs.length}
  Relations:    ${relations.length}
  Blocked-by:   ${blockedBy.length}
  Comments:     ${totalComments}
  Time reports: ${totalTimeReports}
  Placeholders: ${placeholderIds.length} (deleted)
  Mismatches:   ${mismatches.length}
  ════════════════════════════════════════════
`);

  process.exit(0);
}

main().catch(e => {
  err(e.message || e);
  process.exit(1);
});
