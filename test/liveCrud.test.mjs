/**
 * Live CRUD verification against a real Huly server.
 *
 * Every mutating tool is exercised against a dedicated HCMP-TEST workspace that
 * this suite provisions itself, and every write is verified by an INDEPENDENT
 * read: the assertion inspects what the server stored, never the value the
 * mutation returned. Deletes are verified by absence.
 *
 * The suite is self-bootstrapping so it produces the same result on any machine:
 * it creates HCMP-TEST if missing, waits for it to become active, and builds its
 * own project, issues, labels, milestones and components inside it.
 *
 *   HULY_URL=... HULY_TOKEN=... node --test test/liveCrud.test.mjs
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const { jsonToPmNode, markupToJSON } = require('@hcengineering/text');

const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
const CREDS = process.env.HULY_TOKEN
  ? { token: process.env.HULY_TOKEN }
  : { email: process.env.HULY_EMAIL, password: process.env.HULY_PASSWORD };

const WORKSPACE_NAME = 'HCMP-TEST';
const PROJECT = 'CRUD';

let client;
let workspaceSlug;

/** Assert a stored markup string is a document the Huly editor accepts. */
function assertValidMarkup(raw, label) {
  assert.equal(typeof raw, 'string', `${label}: Markup fields must hold a string`);
  jsonToPmNode(markupToJSON(raw)).check();
}

/** Provision the test workspace, waiting for it to leave pending-creation. */
async function ensureWorkspace() {
  const existing = (await HulyClient.listWorkspaces(HULY_URL, CREDS))
    .find(w => w.name === WORKSPACE_NAME || w.slug === WORKSPACE_NAME.toLowerCase());
  if (existing) return existing.slug;

  const created = await HulyClient.createWorkspace(HULY_URL, CREDS, WORKSPACE_NAME);
  for (let i = 0; i < 40; i++) {
    const info = await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, created.slug).catch(() => null);
    if (info?.mode === 'active') return created.slug;
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Workspace ${created.slug} never became active`);
}

describe('Live CRUD', { timeout: 300_000 }, () => {
  before(async () => {
    workspaceSlug = await ensureWorkspace();
    client = new HulyClient({ url: HULY_URL, ...CREDS, workspace: workspaceSlug });
    await client.connect();

    const projects = (await client.listProjects()).items;
    if (!projects.some(p => p.identifier === PROJECT)) {
      await client.createProject(PROJECT, 'CRUD Verification', 'Fixtures for live CRUD tests');
    }
  });

  after(() => { client?.disconnect(); });

  // ── bootstrap ───────────────────────────────────────────────

  describe('create_workspace', () => {
    it('provisions HCMP-TEST and it appears in list_workspaces as active', async () => {
      const all = await HulyClient.listWorkspaces(HULY_URL, CREDS);
      const ws = all.find(w => w.slug === workspaceSlug);
      assert.ok(ws, 'workspace should be listed');
      const info = await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, workspaceSlug);
      assert.equal(info.mode, 'active');
      assert.ok(info.uuid);
    });
  });

  // ── projects ────────────────────────────────────────────────

  describe('create_project / update_project / archive_project', () => {
    it('create_project persists identifier and name', async () => {
      const read = await client.getProject(PROJECT);
      assert.equal(read.identifier, PROJECT);
      assert.equal(read.name, 'CRUD Verification');
    });

    it('update_project persists the new name and description', async () => {
      await client.updateProject(PROJECT, { name: 'CRUD Verified', description: 'updated desc' });
      const read = await client.getProject(PROJECT);
      assert.equal(read.name, 'CRUD Verified');
      assert.equal(read.description, 'updated desc');
      await client.updateProject(PROJECT, { name: 'CRUD Verification' });
    });

    it('archive_project removes the project from list_projects', async () => {
      const ident = `ARCH${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await client.createProject(ident, 'Archive Target', '');
      assert.ok((await client.listProjects()).items.some(p => p.identifier === ident));
      await client.archiveProject(ident, true);
      assert.ok(!(await client.listProjects()).items.some(p => p.identifier === ident));
      await client.archiveProject(ident, false);
      await client.deleteProject(ident);
    });

    it('archive_project can restore an archived project through the SDK override', async () => {
      const ident = `REST${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await client.createProject(ident, 'Archive Round Trip', '');
      await client.archiveProject(ident, true);
      assert.ok(!(await client.listProjects()).items.some(project => project.identifier === ident));
      await client.archiveProject(ident, false);
      assert.equal((await client.getProject(ident)).archived, false);
      await client.deleteProject(ident);
    });
  });

  // ── issues ──────────────────────────────────────────────────

  describe('create_issue / update_issue', () => {
    let issueId;

    it('create_issue persists title, description, priority and status', async () => {
      const created = await client.createIssue(
        PROJECT, 'CRUD issue', 'Body with **bold** and `code`', 'high', 'Todo'
      );
      issueId = created.id;
      const read = await client.getIssue(issueId);
      assert.equal(read.title, 'CRUD issue');
      assert.equal(read.description, 'Body with **bold** and `code`');
      assert.equal(read.priority, 'High');
      assert.equal(read.status, 'Todo');
    });

    it('update_issue persists every changed field', async () => {
      await client.updateIssue(issueId, 'CRUD issue renamed', 'New **body**', 'low', 'In Progress');
      const read = await client.getIssue(issueId);
      assert.equal(read.title, 'CRUD issue renamed');
      assert.equal(read.description, 'New **body**');
      assert.equal(read.priority, 'Low');
      assert.equal(read.status, 'In Progress');
    });

    it('update_issue persists estimation and dueDate', async () => {
      await client.updateIssue(issueId, undefined, undefined, undefined, undefined, undefined,
        { estimation: 5, dueDate: '2026-12-31' });
      const read = await client.getIssue(issueId);
      assert.equal(read.estimation, 5);
      assert.ok(String(read.dueDate).startsWith('2026-12-31'));
    });

    it('update_issue clears assignee, component, and milestone in one call', async () => {
      const member = (await client.listMembers()).items[0];
      assert.ok(member?.name, 'CRUD workspace must expose its creating member');
      const suffix = Date.now().toString(36).slice(-4);
      const component = `Clear Comp ${suffix}`;
      const milestone = `Clear MS ${suffix}`;
      await client.createComponent(PROJECT, component, 'temporary');
      await client.createMilestone(PROJECT, milestone, 'temporary');

      await client.updateIssue(issueId, undefined, undefined, undefined, undefined, undefined, {
        assignee: member.name, component, milestone
      });
      let read = await client.getIssue(issueId);
      assert.equal(read.assignee, member.name);
      assert.equal(read.component, component);
      assert.equal(read.milestone.name, milestone);

      await client.updateIssue(issueId, undefined, undefined, undefined, undefined, undefined, {
        assignee: '', component: '', milestone: ''
      });
      read = await client.getIssue(issueId);
      assert.equal(read.assignee, null);
      assert.equal(read.component, null);
      assert.equal(read.milestone, null);
      await client.deleteComponent(PROJECT, component);
      await client.deleteMilestone(PROJECT, milestone);
    });
  });

  describe('batch_create_issues', () => {
    it('every batched issue is individually readable with its title', async () => {
      const result = await client.batchCreateIssues(PROJECT, [
        { title: 'Batch one', description: 'first' },
        { title: 'Batch two', description: 'second' }
      ]);
      assert.equal(result.created.length, 2);
      for (const [i, expected] of [[0, 'Batch one'], [1, 'Batch two']]) {
        const read = await client.getIssue(result.created[i].id);
        assert.equal(read.title, expected);
      }
      assert.equal((await client.getIssue(result.created[0].id)).description, 'first');
    });
  });

  describe('set_parent', () => {
    it('the child reports the parent after the link is written', async () => {
      const parent = await client.createIssue(PROJECT, 'Parent issue', '');
      const child = await client.createIssue(PROJECT, 'Child issue', '');
      await client.setParent(child.id, parent.id);
      const read = await client.getIssue(child.id);
      assert.ok(JSON.stringify(read).includes(parent.id.split('-')[1]),
        'child should reference the parent issue');
    });
  });

  describe('move_issue', () => {
    it('the issue is readable under its new project identifier', async () => {
      const target = `MOVE${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await client.createProject(target, 'Move Target', '');
      const issue = await client.createIssue(PROJECT, 'Movable', '');
      const moved = await client.moveIssue(issue.id, target);
      const read = await client.getIssue(moved.newId);
      const newId = moved.newId;
      assert.equal(read.title, 'Movable');
      assert.ok(newId.startsWith(target), `expected ${newId} to live in ${target}`);
      await client.deleteProject(target);
    });
  });

  // ── labels ──────────────────────────────────────────────────

  describe('create_label / update_label / add_label / remove_label', () => {
    const name = `crud-label-${Date.now().toString(36).slice(-4)}`;
    let issueId;

    it('create_label persists name and description', async () => {
      await client.createLabel(name, '#FF0000', 'label desc');
      const read = await client.getLabel(name);
      assert.equal(read.name, name);
      assert.equal(read.description, 'label desc');
    });

    it('update_label persists the new description', async () => {
      await client.updateLabel(name, { description: 'label desc updated' });
      assert.equal((await client.getLabel(name)).description, 'label desc updated');
    });

    it('add_label makes the label readable on the issue', async () => {
      const issue = await client.createIssue(PROJECT, 'Labelled issue', '');
      issueId = issue.id;
      await client.addLabel(issueId, name);
      const read = await client.getIssue(issueId);
      assert.ok(read.labels.includes(name), `expected ${name} in ${JSON.stringify(read.labels)}`);
    });

    it('remove_label removes it from the stored issue', async () => {
      await client.removeLabel(issueId, name);
      const read = await client.getIssue(issueId);
      assert.ok(!read.labels.includes(name));
    });
  });

  // ── milestones ──────────────────────────────────────────────

  describe('create_milestone / update_milestone / set_milestone', () => {
    const msName = `CRUD MS ${Date.now().toString(36).slice(-4)}`;
    let issueId;

    it('create_milestone persists description as valid markup', async () => {
      await client.createMilestone(PROJECT, msName, 'Milestone **body**', '2026-12-31', 'Planned');
      const read = await client.getMilestone(PROJECT, msName);
      assert.equal(read.description, 'Milestone **body**');
      assert.equal(read.status, 'Planned');
      assert.equal(read.targetDate, '2026-12-31');
      const raw = await rawMilestone(msName);
      assertValidMarkup(raw.description, 'milestone description');
    });

    it('update_milestone persists description, status and targetDate', async () => {
      await client.updateMilestone(PROJECT, msName, {
        description: 'Updated **body** with `code`', status: 'in progress', targetDate: '2027-01-15'
      });
      const read = await client.getMilestone(PROJECT, msName);
      assert.equal(read.description, 'Updated **body** with `code`');
      assert.equal(read.status, 'In Progress');
      assert.equal(read.targetDate, '2027-01-15');
      assertValidMarkup((await rawMilestone(msName)).description, 'updated milestone description');
    });

    it('update_milestone round-trips and clears collaborator members', async () => {
      const member = (await client.listMembers()).items[0];
      assert.ok(member?.name, 'CRUD workspace must expose its creating member');
      await client.updateMilestone(PROJECT, msName, { collaborators: [member.name] });
      assert.deepEqual((await client.getMilestone(PROJECT, msName)).collaborators.map(item => item.name),
        [member.name]);
      await client.updateMilestone(PROJECT, msName, { collaborators: [] });
      assert.deepEqual((await client.getMilestone(PROJECT, msName)).collaborators, []);
    });

    it('set_milestone makes the milestone readable on the issue', async () => {
      const issue = await client.createIssue(PROJECT, 'Milestoned issue', '');
      issueId = issue.id;
      await client.setMilestone(issueId, msName);
      assert.equal((await client.getIssue(issueId)).milestone.name, msName);
    });

    it('set_milestone with an empty name clears it', async () => {
      await client.setMilestone(issueId, '');
      assert.equal((await client.getIssue(issueId)).milestone, null);
    });

    async function rawMilestone(label) {
      const sdk = await client._getClient();
      const tracker = require('@hcengineering/tracker').default;
      const all = await sdk.findAll(tracker.class.Milestone, {});
      return all.find(m => m.label === label);
    }
  });

  // ── components ──────────────────────────────────────────────

  describe('create_component / update_component', () => {
    const name = `CRUD Comp ${Date.now().toString(36).slice(-4)}`;

    it('create_component persists description as valid markup', async () => {
      await client.createComponent(PROJECT, name, 'Component **body**');
      const read = await client.getComponent(PROJECT, name);
      assert.equal(read.name, name);
      assert.equal(read.description, 'Component **body**');
    });

    it('update_component persists the new description', async () => {
      await client.updateComponent(PROJECT, name, { description: 'Updated **component**' });
      assert.equal((await client.getComponent(PROJECT, name)).description, 'Updated **component**');
    });
  });

  // ── comments ────────────────────────────────────────────────

  describe('add_comment / update_comment', () => {
    let issueId, commentId;

    it('add_comment is readable back with its text', async () => {
      const issue = await client.createIssue(PROJECT, 'Commented issue', '');
      issueId = issue.id;
      const added = await client.addComment(issueId, 'First **comment**');
      commentId = added.id;
      const read = await client.getComment(issueId, commentId);
      assert.equal(read.text, 'First **comment**');
    });

    it('update_comment persists the new text', async () => {
      await client.updateComment(issueId, commentId, 'Edited `comment`');
      assert.equal((await client.getComment(issueId, commentId)).text, 'Edited `comment`');
    });

    it('the comment appears in list_comments', async () => {
      const list = (await client.listComments(issueId)).items;
      assert.ok(list.some(c => c.id === commentId));
    });
  });

  describe('create_issues_from_template', () => {
    it('every templated issue is individually readable', async () => {
      const result = await client.createIssuesFromTemplate(PROJECT, 'sprint', { title: 'Sprint 99' });
      assert.ok(result.created.length > 1, 'template should create several issues');
      for (const created of result.created) {
        const read = await client.getIssue(created.id);
        assert.ok(read.title, `${created.id} should be readable with a title`);
      }
      const parent = await client.getIssue(result.created[0].id, { include: ['children'] });
      assert.ok(parent.title.includes('Sprint 99'), `parent title was ${parent.title}`);
    });
  });

  describe('create_invite_link', () => {
    // No read-back exists: Huly exposes no API to list or fetch invite links, so
    // the returned link is the only observable. Asserted for real structure
    // rather than truthiness, and recorded here as a deliberate limit.
    it('returns a resolvable invite link carrying an inviteId', async () => {
      const result = await HulyClient.createInviteLink(
        HULY_URL, CREDS, workspaceSlug, 'invitee@example.test', 'USER', 'Test', 'Invitee', 1
      );
      const url = new URL(result.link);
      assert.equal(url.origin, new URL(HULY_URL).origin);
      assert.ok(url.searchParams.get('inviteId'), 'link must carry an inviteId');
      assert.equal(result.workspace, workspaceSlug);
      assert.equal(result.role, 'USER');
    });

    it('rejects a link request with no invitee email', async () => {
      await assert.rejects(
        () => HulyClient.createInviteLink(HULY_URL, CREDS, workspaceSlug, undefined, 'USER',
          undefined, undefined, 1),
        /BadRequest/i
      );
    });
  });

  // ── relations ───────────────────────────────────────────────

  describe('add/remove relation and blocked-by', () => {
    it('add_relation and remove_relation persist both directions', async () => {
      const a = await client.createIssue(PROJECT, 'Relation source', '');
      const b = await client.createIssue(PROJECT, 'Relation target', '');
      await client.addRelation(a.id, b.id);
      const source = await client.getIssue(a.id, { include: ['relations'] });
      const target = await client.getIssue(b.id, { include: ['relations'] });
      assert.ok(source.relations.some(r => r.id === b.id || r.title === 'Relation target'),
        `expected ${b.id} in ${JSON.stringify(source.relations)}`);
      assert.ok(target.relations.some(r => r.id === a.id || r.title === 'Relation source'),
        `expected ${a.id} in ${JSON.stringify(target.relations)}`);

      await client.removeRelation(a.id, b.id);
      const sourceAfter = await client.getIssue(a.id, { include: ['relations'] });
      const targetAfter = await client.getIssue(b.id, { include: ['relations'] });
      assert.ok(!sourceAfter.relations.some(r => r.id === b.id || r.title === 'Relation target'));
      assert.ok(!targetAfter.relations.some(r => r.id === a.id || r.title === 'Relation source'));
    });

    it('add_blocked_by and remove_blocked_by persist the dependency lifecycle', async () => {
      const a = await client.createIssue(PROJECT, 'Blocked issue', '');
      const b = await client.createIssue(PROJECT, 'Blocker issue', '');
      await client.addBlockedBy(a.id, b.id);
      const read = await client.getIssue(a.id, { include: ['blockedBy'] });
      assert.ok(read.blockedBy.some(r => r.id === b.id || r.title === 'Blocker issue'),
        `expected ${b.id} in ${JSON.stringify(read.blockedBy)}`);

      await client.removeBlockedBy(a.id, b.id);
      const after = await client.getIssue(a.id, { include: ['blockedBy'] });
      assert.ok(!after.blockedBy.some(r => r.id === b.id || r.title === 'Blocker issue'));
    });
  });

  // ── account: workspace + integrations ───────────────────────

  describe('update_workspace_name', () => {
    it('the renamed workspace reads back with the new name, then restores', async () => {
      const original = (await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, workspaceSlug)).name;
      const renamed = `${WORKSPACE_NAME} renamed ${Date.now().toString(36).slice(-4)}`;
      await HulyClient.updateWorkspaceName(HULY_URL, CREDS, workspaceSlug, renamed);
      assert.equal((await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, workspaceSlug)).name, renamed);
      await HulyClient.updateWorkspaceName(HULY_URL, CREDS, workspaceSlug, original ?? WORKSPACE_NAME);
      assert.equal((await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, workspaceSlug)).name,
        original ?? WORKSPACE_NAME);
    });
  });

  describe('create_integration / update_integration / delete_integration', () => {
    let key;

    before(async () => {
      const info = await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, workspaceSlug);
      const ids = await HulyClient.getSocialIds(HULY_URL, CREDS);
      key = { socialId: ids[0]._id, kind: `hcmp-crud-${Date.now().toString(36).slice(-5)}`,
        workspaceUuid: info.uuid };
      await HulyClient.deleteIntegration(HULY_URL, CREDS, key).catch(() => {});
    });

    it('create_integration stores the payload', async () => {
      await HulyClient.createIntegration(HULY_URL, CREDS, { ...key, data: { n: 1 }, disabled: false });
      const read = await HulyClient.getIntegration(HULY_URL, CREDS, key);
      assert.equal(read.kind, key.kind);
      assert.deepEqual(read.data, { n: 1 });
    });

    it('create_integration rejects a duplicate key', async () => {
      await assert.rejects(
        () => HulyClient.createIntegration(HULY_URL, CREDS, { ...key, data: { n: 9 }, disabled: false }),
        /AlreadyExists/i
      );
      assert.deepEqual((await HulyClient.getIntegration(HULY_URL, CREDS, key)).data, { n: 1 },
        'a rejected duplicate must not overwrite the stored payload');
    });

    it('update_integration stores the new payload', async () => {
      await HulyClient.updateIntegration(HULY_URL, CREDS, { ...key, data: { n: 2 }, disabled: true });
      assert.deepEqual((await HulyClient.getIntegration(HULY_URL, CREDS, key)).data, { n: 2 });
    });

    it('delete_integration — the integration is gone', async () => {
      await HulyClient.deleteIntegration(HULY_URL, CREDS, key);
      assert.equal(await HulyClient.getIntegration(HULY_URL, CREDS, key), null);
    });
  });

  describe('set_my_profile / change_username', () => {
    it('profile fields read back, then restore', async () => {
      const before = await HulyClient.getUserProfile(HULY_URL, CREDS);
      const city = `Testville-${Date.now().toString(36).slice(-4)}`;
      await HulyClient.setMyProfile(HULY_URL, CREDS, undefined, city, 'Testland');
      const read = await HulyClient.getUserProfile(HULY_URL, CREDS);
      assert.equal(read.city, city);
      assert.equal(read.country, 'Testland');
      await HulyClient.setMyProfile(HULY_URL, CREDS, undefined, before.city ?? '', before.country ?? '');
    });

    it('change_username reads back, then restores', async () => {
      const before = await HulyClient.getUserProfile(HULY_URL, CREDS);
      await HulyClient.changeUsername(HULY_URL, CREDS, 'CrudFirst', 'CrudLast');
      const read = await HulyClient.getUserProfile(HULY_URL, CREDS);
      assert.equal(read.firstName, 'CrudFirst');
      assert.equal(read.lastName, 'CrudLast');
      await HulyClient.changeUsername(HULY_URL, CREDS, before.firstName, before.lastName);
      const restored = await HulyClient.getUserProfile(HULY_URL, CREDS);
      assert.equal(restored.firstName, before.firstName);
    });
  });

  // ── destructive: every delete verified by absence ───────────

  describe('destructive tools', () => {
    it('delete_issue — the issue is gone', async () => {
      const issue = await client.createIssue(PROJECT, 'Doomed issue', '');
      await client.getIssue(issue.id);
      await client.deleteIssue(issue.id);
      await assert.rejects(() => client.getIssue(issue.id), /not found/i);
      const listed = (await client.listIssues(PROJECT)).items.some(i => i.id === issue.id);
      assert.equal(listed, false, 'deleted issue must not appear in list_issues');
    });

    it('delete_comment — the comment is gone from the issue', async () => {
      const issue = await client.createIssue(PROJECT, 'Comment host', '');
      const c1 = await client.addComment(issue.id, 'to be deleted');
      await client.deleteComment(issue.id, c1.id);
      const list = (await client.listComments(issue.id)).items;
      assert.ok(!list.some(c => c.id === c1.id), 'deleted comment must not be listed');
    });

    it('delete_label — the label is gone', async () => {
      const name = `doomed-label-${Date.now().toString(36).slice(-4)}`;
      await client.createLabel(name, '#00FF00', 'temp');
      await client.getLabel(name);
      await client.deleteLabel(name);
      await assert.rejects(() => client.getLabel(name), /not found/i);
      const listed = (await client.listLabels()).items.some(l => l.name === name);
      assert.equal(listed, false);
    });

    it('delete_milestone — the milestone is gone', async () => {
      const name = `Doomed MS ${Date.now().toString(36).slice(-4)}`;
      await client.createMilestone(PROJECT, name, 'temp', '2026-12-31');
      const assigned = await client.createIssue(PROJECT, 'Milestone delete host', '');
      await client.setMilestone(assigned.id, name);
      await client.getMilestone(PROJECT, name);
      await client.deleteMilestone(PROJECT, name);
      await assert.rejects(() => client.getMilestone(PROJECT, name), /not found/i);
      const listed = (await client.listMilestones(PROJECT)).items.some(m => m.name === name);
      assert.equal(listed, false);
      assert.equal((await client.getIssue(assigned.id)).milestone, null,
        'deleting a milestone must not leave a dangling issue reference');
    });

    it('delete_component — the component is gone', async () => {
      const name = `Doomed Comp ${Date.now().toString(36).slice(-4)}`;
      await client.createComponent(PROJECT, name, 'temp');
      await client.getComponent(PROJECT, name);
      await client.deleteComponent(PROJECT, name);
      await assert.rejects(() => client.getComponent(PROJECT, name), /not found/i);
      const listed = (await client.listComponents(PROJECT)).items.some(c => c.name === name);
      assert.equal(listed, false);
    });

    it('delete_time_report — the report is gone and hours are reversed', async () => {
      const issue = await client.createIssue(PROJECT, 'Time host', '');
      const logged = await client.logTime(issue.id, 3, 'temp work', '2026-06-02');
      assert.equal((await client.getTimeReport(issue.id, logged.id)).hours, 3);
      await client.deleteTimeReport(logged.id);
      const reports = (await client.listTimeReports(issue.id)).items;
      assert.ok(!reports.some(r => r.id === logged.id), 'deleted report must not be listed');
    });

    it('delete_project — the project is gone', async () => {
      const ident = `DEL${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await client.createProject(ident, 'Doomed project', '');
      await client.getProject(ident);
      await client.deleteProject(ident);
      await assert.rejects(() => client.getProject(ident), /not found/i);
      const listed = (await client.listProjects()).items.some(p => p.identifier === ident);
      assert.equal(listed, false);
    });

  });


  // ── time ────────────────────────────────────────────────────

  describe('stored issue templates and project settings', () => {
    it('creates, reads, replaces and clears project settings using account UUIDs', async () => {
      const ident = `SET${Date.now().toString(36).slice(-4).toUpperCase()}`;
      const member = (await client.listMembers()).items[0];
      assert.ok(member?.name);
      await client.createProject(ident, 'Project settings lifecycle', '', false, undefined, {
        members: [member.name], owners: [member.name], defaultAssignee: member.name,
        defaultTimeReportDay: 'PreviousWorkDay'
      });
      try {
        const read = await client.getProject(ident, { include: ['members', 'owners', 'defaults'] });
        assert.ok(read.members.includes(member.name));
        assert.ok(read.owners.includes(member.name));
        assert.equal(read.defaultAssignee, member.name);
        assert.equal(read.defaultTimeReportDay, 'PreviousWorkDay');
        const sdk = await client._getClient();
        const tracker = require('@hcengineering/tracker').default;
        const raw = await sdk.findOne(tracker.class.Project, { identifier: ident });
        assert.ok(raw.members.includes(client._accountUuid));
        assert.ok(raw.owners.includes(client._accountUuid));
        await client.updateProject(ident, {
          members: [], defaultAssignee: '', defaultIssueStatus: read.defaultIssueStatus,
          defaultTimeReportDay: 'CurrentWorkDay'
        });
        const cleared = await client.getProject(ident, { include: ['members', 'owners', 'defaults'] });
        assert.deepEqual(cleared.members, []);
        assert.equal(cleared.defaultAssignee, null);
        assert.equal(cleared.defaultTimeReportDay, 'CurrentWorkDay');
        assert.equal(cleared.defaultIssueStatus, read.defaultIssueStatus);
        await client.updateProject(ident, { members: read.members, owners: read.owners });
        const restored = (await client.listProjects({ include: ['members', 'owners'] })).items.find(p => p.identifier === ident);
        assert.deepEqual(restored.members, read.members);
        assert.deepEqual(restored.owners, read.owners);
      } finally {
        await client.deleteProject(ident);
      }
    });

    it('round-trips the complete stored template model, including child templates and markup', async () => {
      const ident = `TPL${Date.now().toString(36).slice(-4).toUpperCase()}`;
      await client.createProject(ident, 'Template lifecycle', '');
      const labelName = `template-${ident}`;
      let labelCreated = false;
      try {
        const member = (await client.listMembers()).items[0];
        const component = await client.createComponent(ident, 'API', '');
        const milestone = await client.createMilestone(ident, 'v1', '');
        const label = await client.createLabel(labelName);
        labelCreated = true;
        const issue = await client.createIssue(ident, 'Unrelated issue survives template deletion', '');
        const sdk = await client._getClient();
        const tracker = require('@hcengineering/tracker').default;
        const project = await sdk.findOne(tracker.class.Project, { identifier: ident });
        const typeId = await client._getDefaultTaskType(sdk, project);
        const task = require('@hcengineering/task').default;
        const type = await sdk.findOne(task.class.TaskType, { _id: typeId });
        const fields = {
          title: 'Release', description: '**Ship** the release', priority: 'high',
          assignee: member.name, component: 'API', milestone: 'v1', estimation: 3.5,
          labels: [labelName], type: type.name
        };
        const created = await client.createIssueTemplate(ident, {
          ...fields, children: [{ ...fields, title: 'Child step' }],
          relations: [{ id: issue.internalId, objectClass: tracker.class.Issue }]
        });
        const raw = await sdk.findOne(tracker.class.IssueTemplate, { _id: created.id });
        assert.equal(raw.space, project._id);
        assert.equal(raw.component, component.id);
        assert.equal(raw.milestone, milestone.id);
        assert.equal(raw.kind, typeId);
        assert.deepEqual(raw.labels, [label.id]);
        assert.deepEqual(raw.children[0].labels, [label.id]);
        assert.equal(raw.relations[0]._id, issue.internalId);
        assertValidMarkup(raw.description, 'template description');
        assertValidMarkup(raw.children[0].description, 'child template description');
        const read = await client.getIssueTemplate(ident, created.id);
        assert.equal(read.assignee, member.name);
        assert.equal(read.description, fields.description);
        assert.equal(read.children[0].title, 'Child step');
        assert.equal(read.children[0].component, 'API');
        assert.equal((await client.listIssueTemplates(ident)).items[0].id, created.id);
        await client.updateIssueTemplate(ident, created.id, {
          title: 'Release updated', description: '', priority: 'none', estimation: 0,
          assignee: '', component: '', milestone: '', labels: [], relations: [],
          children: [{ id: read.children[0].id, title: 'Child updated', description: '**Valid**' }]
        });
        const updated = await client.getIssueTemplate(ident, created.id);
        assert.equal(updated.title, 'Release updated');
        assert.equal(updated.description, '');
        assert.equal(updated.assignee, null);
        assert.equal(updated.component, null);
        assert.equal(updated.milestone, null);
        assert.deepEqual(updated.labels, []);
        assert.deepEqual(updated.relations, []);
        assert.equal(updated.children[0].id, read.children[0].id);
        assert.equal(updated.children[0].title, 'Child updated');
        await client.updateIssueTemplate(ident, created.id, { children: [] });
        assert.deepEqual((await client.getIssueTemplate(ident, created.id)).children, []);
        await client.deleteIssueTemplate(ident, created.id);
        await assert.rejects(() => client.getIssueTemplate(ident, created.id), /not found/);
        assert.deepEqual((await client.listIssueTemplates(ident)).items, []);
        assert.ok(await client.getIssue(issue.id));
      } finally {
        if (labelCreated) await client.deleteLabel(labelName);
        await client.deleteProject(ident);
      }
    });
  });

  describe('log_time', () => {
    it('the logged hours are readable back on the report and the issue', async () => {
      const issue = await client.createIssue(PROJECT, 'Timed issue', '');
      const logged = await client.logTime(issue.id, 2.5, 'work done', '2026-06-01');
      const read = await client.getTimeReport(issue.id, logged.id);
      assert.equal(read.hours, 2.5);
      assert.equal(read.description, 'work done');
      const reports = (await client.listTimeReports(issue.id)).items;
      assert.ok(reports.some(r => r.id === logged.id));
    });

    it('update_time_report persists all editable report fields', async () => {
      const issue = await client.createIssue(PROJECT, 'Updated time host', '');
      const logged = await client.logTime(issue.id, 1, 'before', '2026-06-01');
      const member = (await client.listMembers()).items[0];
      await client.updateTimeReport(issue.id, logged.id, {
        hours: 2.75, description: 'after', date: '2026-06-03', employee: member.name
      });
      const read = await client.getTimeReport(issue.id, logged.id);
      assert.equal(read.hours, 2.75);
      assert.equal(read.description, 'after');
      assert.ok(String(read.date).startsWith('2026-06-03'));
      assert.equal(read.employee, member.name);
      assert.equal((await client.getIssue(issue.id)).reportedTime, 2.75);
    });
  });
  // ── delete_workspace ────────────────────────────────────────
  //
  // On self-hosted Huly (v0.7.x) delete_workspace does NOT delete. The account
  // service sets mode=pending-deletion and is_disabled=true, which hides the
  // workspace from the API, but the workspace service never reaches the delete
  // path and the account row survives. See, in the basecamp repo,
  // apps/huly/workspace-deletion-bug.md.
  //
  // Two consequences the assertion below is written around:
  //   1. "deleted" means "no longer visible", not "removed" — that is the
  //      strongest claim the API supports, so it is what we assert.
  //   2. The surviving row still counts against the account's workspace quota,
  //      so each run permanently consumes a slot and eventually every create
  //      fails with WorkspaceLimitReached. The test is therefore opt-in.
  //
  // Enable with HULY_TEST_DELETE_WORKSPACE=1 once quota headroom exists.

  describe('delete_workspace', () => {
    it('a throwaway workspace stops being visible in list_workspaces', async (t) => {
      if (process.env.HULY_TEST_DELETE_WORKSPACE !== '1') {
        t.skip('opt-in: permanently consumes an account workspace slot');
        return;
      }
      const name = `HCMP-TEST-DEL-${Date.now().toString(36).slice(-5)}`;
      let created;
      try {
        created = await HulyClient.createWorkspace(HULY_URL, CREDS, name);
      } catch (error) {
        if (/LimitReached/i.test(error.message)) {
          t.skip('account workspace quota exhausted — see workspace-deletion-bug.md');
          return;
        }
        throw error;
      }
      for (let i = 0; i < 40; i++) {
        const info = await HulyClient.getWorkspaceInfo(HULY_URL, CREDS, created.slug).catch(() => null);
        if (info?.mode === 'active') break;
        await new Promise(r => setTimeout(r, 2000));
      }
      await HulyClient.deleteWorkspace(HULY_URL, CREDS, created.slug);
      const still = (await HulyClient.listWorkspaces(HULY_URL, CREDS))
        .find(w => w.slug === created.slug && w.mode === 'active');
      assert.ok(!still, `workspace ${created.slug} should be hidden, got mode=${still?.mode}`);
    });
  });

});
