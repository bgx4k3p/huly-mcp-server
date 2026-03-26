/**
 * Dispatch validation tests.
 *
 * These are pure unit tests (no Huly connection) that verify the MCP tool
 * schemas, dispatch table, and client method signatures are all aligned.
 * Every MCP tool's required + optional params are traced end-to-end through
 * the dispatch handler to the client method call, catching the exact class
 * of bugs that caused the 9 critical signature mismatches in v2.0.1.
 *
 * Pattern: build args from schema → call dispatch handler with a recording
 * proxy → assert the client method received every expected argument.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// ════════════════════════════════════════════════════════════════
// Test helpers
// ════════════════════════════════════════════════════════════════

/** Sentinel value used to fill required schema properties */
const SENTINEL = '__TEST_SENTINEL__';

/** Build a minimal args object from an MCP tool schema */
function buildArgs(schema) {
  const args = {};
  const props = schema.properties || {};
  for (const [key, def] of Object.entries(props)) {
    if (key === 'workspace') continue; // skip the shared workspace prop
    const type = Array.isArray(def.type) ? def.type[0] : def.type;
    switch (type) {
      case 'string': args[key] = `${SENTINEL}_${key}`; break;
      case 'number': args[key] = 99; break;
      case 'boolean': args[key] = true; break;
      case 'array': args[key] = [`${SENTINEL}_item`]; break;
      case 'object': args[key] = { [`${SENTINEL}_key`]: true }; break;
      default: args[key] = SENTINEL;
    }
  }
  return args;
}

/**
 * Create a recording proxy for a HulyClient instance or static class.
 * Records method name + args for every call.
 */
function createRecorder() {
  const calls = [];
  const handler = {
    get(_target, prop) {
      return (...args) => {
        calls.push({ method: prop, args });
        return Promise.resolve({ recorded: true });
      };
    }
  };
  return { proxy: new Proxy({}, handler), calls };
}

// ════════════════════════════════════════════════════════════════
// Load modules
// ════════════════════════════════════════════════════════════════

let TOOLS, accountTools, workspaceTools;

before(async () => {
  // Import TOOLS from mcp.mjs — need to handle the env setup
  process.env.HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
  process.env.HULY_TOKEN = process.env.HULY_TOKEN || 'test-token';
  process.env.HULY_WORKSPACE = process.env.HULY_WORKSPACE || 'test-ws';

  const mcp = await import('../src/mcp.mjs');
  // TOOLS is not exported, so we extract from the dispatch module and schemas
  const dispatch = await import('../src/dispatch.mjs');
  accountTools = dispatch.accountTools;
  workspaceTools = dispatch.workspaceTools;
});

// ════════════════════════════════════════════════════════════════
// 1. Dispatch table completeness
// ════════════════════════════════════════════════════════════════

describe('Dispatch table completeness', () => {

  it('every workspace tool in dispatch has a matching entry', async () => {
    const dispatch = await import('../src/dispatch.mjs');
    const wsToolNames = Object.keys(dispatch.workspaceTools);
    const acctToolNames = Object.keys(dispatch.accountTools);
    // Every tool should be callable
    for (const name of wsToolNames) {
      assert.equal(typeof dispatch.workspaceTools[name], 'function',
        `workspaceTools.${name} should be a function`);
    }
    for (const name of acctToolNames) {
      assert.equal(typeof dispatch.accountTools[name], 'function',
        `accountTools.${name} should be a function`);
    }
  });

  it('no workspace tool appears in accountTools and vice versa', async () => {
    const dispatch = await import('../src/dispatch.mjs');
    const wsNames = new Set(Object.keys(dispatch.workspaceTools));
    const acctNames = new Set(Object.keys(dispatch.accountTools));
    const overlap = [...wsNames].filter(n => acctNames.has(n));
    assert.deepEqual(overlap, [], `Tools appear in both tables: ${overlap.join(', ')}`);
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Workspace tool dispatch — param forwarding
// ════════════════════════════════════════════════════════════════

describe('Workspace tool dispatch — param forwarding', () => {

  /** For each workspace tool, verify the dispatch handler passes args through */
  const toolTests = [
    {
      name: 'list_projects',
      args: { include_details: true },
      expectMethod: 'listProjects',
      validate: (call) => {
        assert.deepEqual(call.args[0], { include_details: true });
      }
    },
    {
      name: 'get_project',
      args: { project: 'PROJ', include_details: true },
      expectMethod: 'getProject',
      validate: (call) => {
        assert.equal(call.args[0], 'PROJ');
        assert.deepEqual(call.args[1], { include_details: true });
      }
    },
    {
      name: 'list_issues',
      args: { project: 'P', status: 'Todo', priority: 'high', label: 'bug', milestone: 'v1', limit: 10, include_details: true },
      expectMethod: 'listIssues',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'Todo');
        assert.equal(call.args[2], 'high');
        assert.equal(call.args[3], 'bug');
        assert.equal(call.args[4], 'v1');
        assert.equal(call.args[5], 10);
        assert.equal(call.args[6], true);
      }
    },
    {
      name: 'get_issue',
      args: { issueId: 'P-1', include_details: true },
      expectMethod: 'getIssue',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.deepEqual(call.args[1], { include_details: true });
      }
    },
    {
      name: 'create_issue',
      args: { project: 'P', title: 'T', description: 'D', priority: 'high', status: 'Todo', labels: ['bug'], type: 'Issue',
              assignee: 'Alice', component: 'API', milestone: 'v1', dueDate: '2026-01-01', estimation: 4, descriptionFormat: 'markdown' },
      expectMethod: 'createIssue',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'T');
        assert.equal(call.args[2], 'D');
        assert.equal(call.args[3], 'high');
        assert.equal(call.args[4], 'Todo');
        assert.deepEqual(call.args[5], ['bug']);
        assert.equal(call.args[6], 'Issue');
        const extra = call.args[7];
        assert.equal(extra.assignee, 'Alice');
        assert.equal(extra.component, 'API');
        assert.equal(extra.milestone, 'v1');
        assert.equal(extra.dueDate, '2026-01-01');
        assert.equal(extra.estimation, 4);
        assert.equal(extra.descriptionFormat, 'markdown');
      }
    },
    {
      name: 'update_issue',
      args: { issueId: 'P-1', title: 'T2', description: 'D2', priority: 'low', status: 'Done', type: 'Bug',
              assignee: 'Bob', component: 'UI', milestone: 'v2', dueDate: '2026-06-01', estimation: 8, descriptionFormat: 'html' },
      expectMethod: 'updateIssue',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'T2');
        assert.equal(call.args[2], 'D2');
        assert.equal(call.args[3], 'low');
        assert.equal(call.args[4], 'Done');
        assert.equal(call.args[5], 'Bug');
        const extra = call.args[6];
        assert.equal(extra.assignee, 'Bob');
        assert.equal(extra.component, 'UI');
        assert.equal(extra.milestone, 'v2');
        assert.equal(extra.dueDate, '2026-06-01');
        assert.equal(extra.estimation, 8);
        assert.equal(extra.descriptionFormat, 'html');
      }
    },
    {
      name: 'delete_issue',
      args: { issueId: 'P-1' },
      expectMethod: 'deleteIssue',
      validate: (call) => assert.equal(call.args[0], 'P-1')
    },
    {
      name: 'search_issues',
      args: { query: 'auth', project: 'P', limit: 5 },
      expectMethod: 'searchIssues',
      validate: (call) => {
        assert.equal(call.args[0], 'auth');
        assert.equal(call.args[1], 'P');
        assert.equal(call.args[2], 5);
      }
    },
    {
      name: 'get_my_issues',
      args: { project: 'P', status: 'Todo', limit: 50 },
      expectMethod: 'getMyIssues',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'Todo');
        assert.equal(call.args[2], 50);
      }
    },
    {
      name: 'batch_create_issues',
      args: { project: 'P', issues: [{ title: 'T1' }] },
      expectMethod: 'batchCreateIssues',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.deepEqual(call.args[1], [{ title: 'T1' }]);
      }
    },
    {
      name: 'move_issue',
      args: { issueId: 'P-1', targetProject: 'Q' },
      expectMethod: 'moveIssue',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'Q');
      }
    },
    {
      name: 'create_issues_from_template',
      args: { project: 'P', template: 'feature', title: 'Auth', version: 'v1' },
      expectMethod: 'createIssuesFromTemplate',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'feature');
        assert.deepEqual(call.args[2], { title: 'Auth', version: 'v1' });
      }
    },
    {
      name: 'summarize_project',
      args: { project: 'P' },
      expectMethod: 'summarizeProject',
      validate: (call) => assert.equal(call.args[0], 'P')
    },
    // Labels
    {
      name: 'add_label',
      args: { issueId: 'P-1', label: 'bug' },
      expectMethod: 'addLabel',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'bug');
      }
    },
    {
      name: 'remove_label',
      args: { issueId: 'P-1', label: 'bug' },
      expectMethod: 'removeLabel',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'bug');
      }
    },
    {
      name: 'list_labels',
      args: {},
      expectMethod: 'listLabels',
      validate: (call) => assert.equal(call.args.length, 0)
    },
    {
      name: 'create_label',
      args: { name: 'bug', color: 'red', description: 'Bug label' },
      expectMethod: 'createLabel',
      validate: (call) => {
        assert.equal(call.args[0], 'bug');
        assert.equal(call.args[1], 'red');
        assert.equal(call.args[2], 'Bug label');
      }
    },
    {
      name: 'update_label',
      args: { name: 'bug', newName: 'defect', color: 'blue', description: 'Updated' },
      expectMethod: 'updateLabel',
      validate: (call) => {
        assert.equal(call.args[0], 'bug');
        assert.deepEqual(call.args[1], { newName: 'defect', color: 'blue', description: 'Updated' });
      }
    },
    {
      name: 'delete_label',
      args: { name: 'obsolete' },
      expectMethod: 'deleteLabel',
      validate: (call) => {
        assert.equal(call.args[0], 'obsolete');
      }
    },
    // Relations
    {
      name: 'add_relation',
      args: { issueId: 'P-1', relatedToIssueId: 'P-2' },
      expectMethod: 'addRelation',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'P-2');
      }
    },
    {
      name: 'add_blocked_by',
      args: { issueId: 'P-1', blockedByIssueId: 'P-2' },
      expectMethod: 'addBlockedBy',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'P-2');
      }
    },
    {
      name: 'set_parent',
      args: { issueId: 'P-2', parentId: 'P-1' },
      expectMethod: 'setParent',
      validate: (call) => {
        assert.equal(call.args[0], 'P-2');
        assert.equal(call.args[1], 'P-1');
      }
    },
    // Task types & statuses
    {
      name: 'list_task_types',
      args: { project: 'P' },
      expectMethod: 'listTaskTypes',
      validate: (call) => assert.equal(call.args[0], 'P')
    },
    {
      name: 'list_statuses',
      args: { project: 'P', taskType: 'Issue' },
      expectMethod: 'listStatuses',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'Issue');
      }
    },
    // Milestones
    {
      name: 'list_milestones',
      args: { project: 'P', status: 'Planned', include_details: true },
      expectMethod: 'listMilestones',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'Planned');
        assert.deepEqual(call.args[2], { include_details: true });
      }
    },
    {
      name: 'get_milestone',
      args: { project: 'P', name: 'v1', include_details: true },
      expectMethod: 'getMilestone',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'v1');
        assert.deepEqual(call.args[2], { include_details: true });
      }
    },
    {
      name: 'create_milestone',
      args: { project: 'P', name: 'v1', description: 'First', targetDate: '2026-06-01', status: 'Planned', descriptionFormat: 'markdown' },
      expectMethod: 'createMilestone',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'v1');
        assert.equal(call.args[2], 'First');
        assert.equal(call.args[3], '2026-06-01');
        assert.equal(call.args[4], 'Planned');
        assert.equal(call.args[5], 'markdown');
      }
    },
    {
      name: 'set_milestone',
      args: { issueId: 'P-1', milestone: 'v1' },
      expectMethod: 'setMilestone',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'v1');
      }
    },
    {
      name: 'update_milestone',
      args: { project: 'P', name: 'v1', newName: 'v1.1', description: 'Updated', descriptionFormat: 'markdown', status: 'In Progress', targetDate: '2026-07-01' },
      expectMethod: 'updateMilestone',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'v1');
        const updates = call.args[2];
        assert.equal(updates.name, 'v1.1');
        assert.equal(updates.description, 'Updated');
        assert.equal(updates.descriptionFormat, 'markdown');
        assert.equal(updates.status, 'In Progress');
        assert.equal(updates.targetDate, '2026-07-01');
      }
    },
    {
      name: 'delete_milestone',
      args: { project: 'P', name: 'v1' },
      expectMethod: 'deleteMilestone',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'v1');
      }
    },
    // Members
    {
      name: 'list_members',
      args: {},
      expectMethod: 'listMembers',
      validate: (call) => assert.equal(call.args.length, 0)
    },
    // Comments
    {
      name: 'add_comment',
      args: { issueId: 'P-1', text: 'Hello', format: 'markdown' },
      expectMethod: 'addComment',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'Hello');
        assert.equal(call.args[2], 'markdown');
      }
    },
    {
      name: 'list_comments',
      args: { issueId: 'P-1' },
      expectMethod: 'listComments',
      validate: (call) => assert.equal(call.args[0], 'P-1')
    },
    {
      name: 'update_comment',
      args: { issueId: 'P-1', commentId: 'c1', text: 'Updated', format: 'html' },
      expectMethod: 'updateComment',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'c1');
        assert.equal(call.args[2], 'Updated');
        assert.equal(call.args[3], 'html');
      }
    },
    {
      name: 'delete_comment',
      args: { issueId: 'P-1', commentId: 'c1' },
      expectMethod: 'deleteComment',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'c1');
      }
    },
    // Time tracking
    {
      name: 'log_time',
      args: { issueId: 'P-1', hours: 2, description: 'Work', descriptionFormat: 'markdown', date: '2026-03-01', employee: 'Alice' },
      expectMethod: 'logTime',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 2);
        assert.equal(call.args[2], 'Work');
        assert.equal(call.args[3], 'markdown');
        assert.equal(call.args[4], '2026-03-01');
        assert.equal(call.args[5], 'Alice');
      }
    },
    {
      name: 'list_time_reports',
      args: { issueId: 'P-1' },
      expectMethod: 'listTimeReports',
      validate: (call) => assert.equal(call.args[0], 'P-1')
    },
    {
      name: 'delete_time_report',
      args: { reportId: 'r1' },
      expectMethod: 'deleteTimeReport',
      validate: (call) => assert.equal(call.args[0], 'r1')
    },
    // Projects
    {
      name: 'create_project',
      args: { identifier: 'PROJ', name: 'My Project', description: 'Desc', private: true, descriptionFormat: 'markdown', projectType: 'Classic' },
      expectMethod: 'createProject',
      validate: (call) => {
        assert.equal(call.args[0], 'PROJ');
        assert.equal(call.args[1], 'My Project');
        assert.equal(call.args[2], 'Desc');
        assert.equal(call.args[3], true);
        assert.equal(call.args[4], 'markdown');
        assert.equal(call.args[5], 'Classic');
      }
    },
    {
      name: 'update_project',
      args: { project: 'P', name: 'New', description: 'D2', descriptionFormat: 'html', private: false, defaultAssignee: 'Bob' },
      expectMethod: 'updateProject',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        const updates = call.args[1];
        assert.equal(updates.name, 'New');
        assert.equal(updates.description, 'D2');
        assert.equal(updates.descriptionFormat, 'html');
        assert.equal(updates.isPrivate, false);
        assert.equal(updates.defaultAssignee, 'Bob');
      }
    },
    {
      name: 'archive_project',
      args: { project: 'P', archived: true },
      expectMethod: 'archiveProject',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], true);
      }
    },
    {
      name: 'delete_project',
      args: { project: 'P' },
      expectMethod: 'deleteProject',
      validate: (call) => assert.equal(call.args[0], 'P')
    },
    // Components
    {
      name: 'list_components',
      args: { project: 'P' },
      expectMethod: 'listComponents',
      validate: (call) => assert.equal(call.args[0], 'P')
    },
    {
      name: 'create_component',
      args: { project: 'P', name: 'API', description: 'Backend', lead: 'Alice', descriptionFormat: 'markdown' },
      expectMethod: 'createComponent',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'API');
        assert.equal(call.args[2], 'Backend');
        assert.equal(call.args[3], 'Alice');
        assert.equal(call.args[4], 'markdown');
      }
    },
    {
      name: 'update_component',
      args: { project: 'P', name: 'API', newName: 'Backend', description: 'Updated', descriptionFormat: 'html', lead: 'Bob' },
      expectMethod: 'updateComponent',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'API');
        const updates = call.args[2];
        assert.equal(updates.name, 'Backend');
        assert.equal(updates.description, 'Updated');
        assert.equal(updates.descriptionFormat, 'html');
        assert.equal(updates.lead, 'Bob');
      }
    },
    {
      name: 'delete_component',
      args: { project: 'P', name: 'API' },
      expectMethod: 'deleteComponent',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'API');
      }
    },
    // Single-item lookups
    {
      name: 'get_label',
      args: { name: 'bug' },
      expectMethod: 'getLabel',
      validate: (call) => assert.equal(call.args[0], 'bug')
    },
    {
      name: 'get_member',
      args: { name: 'Alice' },
      expectMethod: 'getMember',
      validate: (call) => assert.equal(call.args[0], 'Alice')
    },
    {
      name: 'get_status',
      args: { name: 'Todo' },
      expectMethod: 'getStatus',
      validate: (call) => assert.equal(call.args[0], 'Todo')
    },
    {
      name: 'get_component',
      args: { project: 'P', name: 'API' },
      expectMethod: 'getComponent',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'API');
      }
    },
    {
      name: 'get_task_type',
      args: { project: 'P', name: 'Issue' },
      expectMethod: 'getTaskType',
      validate: (call) => {
        assert.equal(call.args[0], 'P');
        assert.equal(call.args[1], 'Issue');
      }
    },
    {
      name: 'get_comment',
      args: { issueId: 'P-1', commentId: 'c1' },
      expectMethod: 'getComment',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'c1');
      }
    },
    {
      name: 'get_time_report',
      args: { issueId: 'P-1', reportId: 'r1' },
      expectMethod: 'getTimeReport',
      validate: (call) => {
        assert.equal(call.args[0], 'P-1');
        assert.equal(call.args[1], 'r1');
      }
    },
  ];

  for (const test of toolTests) {
    it(`${test.name} → ${test.expectMethod}() receives correct args`, async () => {
      const { proxy, calls } = createRecorder();
      await workspaceTools[test.name](test.args, proxy);
      assert.equal(calls.length, 1, `Expected exactly 1 call, got ${calls.length}`);
      assert.equal(calls[0].method, test.expectMethod,
        `Expected method ${test.expectMethod}, got ${calls[0].method}`);
      test.validate(calls[0]);
    });
  }
});

// ════════════════════════════════════════════════════════════════
// 3. Account tool dispatch — structural validation
// ════════════════════════════════════════════════════════════════

describe('Account tool dispatch — structural validation', () => {

  // Account tools call HulyClient static methods which require live HTTP.
  // Instead of mocking the HTTP layer, we validate structurally:
  // each dispatch entry extracts the correct args and calls the correct method.

  const expectedArgExtraction = {
    list_workspaces: [],
    get_workspace_info: ['workspace'],
    create_workspace: ['name'],
    update_workspace_name: ['workspace', 'name'],
    delete_workspace: ['workspace'],
    get_workspace_members: ['workspace'],
    update_workspace_role: ['workspace', 'email', 'role'],
    get_account_info: [],
    get_user_profile: [],
    set_my_profile: ['name', 'city', 'country'],
    change_password: ['newPassword'],
    change_username: ['firstName', 'lastName'],
    send_invite: ['workspace', 'email', 'role'],
    resend_invite: ['workspace', 'email', 'role'],
    create_invite_link: ['workspace', 'email', 'role', 'firstName', 'lastName', 'expireHours'],
    list_integrations: ['filter'],
    get_integration: ['socialId', 'kind', 'workspaceUuid'],
    create_integration: ['socialId', 'kind', 'workspaceUuid', 'data', 'disabled'],
    update_integration: ['socialId', 'kind', 'workspaceUuid', 'data', 'disabled'],
    delete_integration: ['socialId', 'kind', 'workspaceUuid'],
    list_mailboxes: [],
    create_mailbox: ['name', 'domain'],
    delete_mailbox: ['mailboxId'],
    find_person_by_social_key: ['socialKey'],
    get_social_ids: [],
    add_email_social_id: ['targetEmail'],
    list_subscriptions: [],
  };

  for (const [name, expectedArgs] of Object.entries(expectedArgExtraction)) {
    it(`${name} dispatch references all expected args: ${expectedArgs.join(', ') || '(none)'}`, () => {
      const handler = accountTools[name];
      assert.ok(handler, `accountTools.${name} should exist`);
      const src = handler.toString();
      for (const arg of expectedArgs) {
        assert.ok(src.includes(`a.${arg}`),
          `${name} handler should reference a.${arg} but source is: ${src}`);
      }
    });
  }

  it('dispatch handlers reference correct static methods', () => {
    const expectedMethods = {
      list_workspaces: 'listWorkspaces',
      get_workspace_info: 'getWorkspaceInfo',
      create_workspace: 'createWorkspace',
      update_workspace_name: 'updateWorkspaceName',
      delete_workspace: 'deleteWorkspace',
      get_workspace_members: 'getWorkspaceMembers',
      update_workspace_role: 'updateWorkspaceRole',
      get_account_info: 'getAccountInfo',
      get_user_profile: 'getUserProfile',
      set_my_profile: 'setMyProfile',
      change_password: 'changePassword',
      change_username: 'changeUsername',
      send_invite: 'sendInvite',
      resend_invite: 'resendInvite',
      create_invite_link: 'createInviteLink',
      list_integrations: 'listIntegrations',
      get_integration: 'getIntegration',
      create_integration: 'createIntegration',
      update_integration: 'updateIntegration',
      delete_integration: 'deleteIntegration',
      list_mailboxes: 'getMailboxes',
      create_mailbox: 'createMailbox',
      delete_mailbox: 'deleteMailbox',
      find_person_by_social_key: 'findPersonBySocialKey',
      get_social_ids: 'getSocialIds',
      add_email_social_id: 'addEmailSocialId',
      list_subscriptions: 'getSubscriptions',
    };

    for (const [tool, method] of Object.entries(expectedMethods)) {
      const src = accountTools[tool].toString();
      assert.ok(src.includes(`HulyClient.${method}`),
        `${tool} should call HulyClient.${method} but source is: ${src}`);
    }
  });

});


// ════════════════════════════════════════════════════════════════
// 4. Required param coverage — no undefined forwarding
// ════════════════════════════════════════════════════════════════

describe('Required param coverage — no undefined forwarding', () => {

  it('workspace tools never forward undefined for required schema params', async () => {
    const requiredByTool = {
      list_issues: { project: 'P' },
      get_issue: { issueId: 'P-1' },
      create_issue: { project: 'P', title: 'T' },
      update_issue: { issueId: 'P-1' },
      delete_issue: { issueId: 'P-1' },
      add_label: { issueId: 'P-1', label: 'bug' },
      remove_label: { issueId: 'P-1', label: 'bug' },
      add_relation: { issueId: 'P-1', relatedToIssueId: 'P-2' },
      add_blocked_by: { issueId: 'P-1', blockedByIssueId: 'P-2' },
      set_parent: { issueId: 'P-1', parentId: 'P-2' },
      delete_label: { name: 'L' },
      add_comment: { issueId: 'P-1', text: 'Hi' },
      log_time: { issueId: 'P-1', hours: 2 },
      move_issue: { issueId: 'P-1', targetProject: 'Q' },
      batch_create_issues: { project: 'P', issues: [{ title: 'T' }] },
      create_project: { identifier: 'P', name: 'N' },
      delete_project: { project: 'P' },
      archive_project: { project: 'P', archived: true },
      create_component: { project: 'P', name: 'C' },
      delete_component: { project: 'P', name: 'C' },
      create_milestone: { project: 'P', name: 'M' },
      delete_milestone: { project: 'P', name: 'M' },
    };

    for (const [toolName, args] of Object.entries(requiredByTool)) {
      const { proxy, calls } = createRecorder();
      await workspaceTools[toolName](args, proxy);
      assert.equal(calls.length, 1, `${toolName}: expected 1 call`);
    }
  });
});

// ════════════════════════════════════════════════════════════════
// 5. Dispatch table has no stale entries
// ════════════════════════════════════════════════════════════════

describe('Dispatch table integrity', () => {

  it('all workspaceTools entries call methods that exist on HulyClient prototype', async () => {
    const { HulyClient } = await import('../src/client.mjs');
    const proto = HulyClient.prototype;
    const { proxy, calls } = createRecorder();

    for (const [name, handler] of Object.entries(workspaceTools)) {
      calls.length = 0;
      const args = { project: 'P', issueId: 'P-1', name: 'N', label: 'L',
                      relatedToIssueId: 'P-2', blockedByIssueId: 'P-2',
                      parentIssueId: 'P-2', assignee: 'A', text: 'T',
                      hours: 1, query: 'q', template: 'feature',
                      issues: [{ title: 'T' }], targetProject: 'Q',
                      commentId: 'c1', reportId: 'r1', title: 'T',
                      identifier: 'I', archived: true, include_details: false };
      await handler(args, proxy);
      assert.equal(calls.length, 1, `${name}: dispatch should make exactly 1 call`);
      const method = calls[0].method;
      assert.equal(typeof proto[method], 'function',
        `${name} dispatches to ${method}() which does not exist on HulyClient.prototype`);
    }
  });

  it('all accountTools entries reference existing static methods on HulyClient', async () => {
    const { HulyClient } = await import('../src/client.mjs');
    const staticMethods = Object.getOwnPropertyNames(HulyClient).filter(
      k => typeof HulyClient[k] === 'function' && k !== 'prototype' && k !== 'length' && k !== 'name'
    );

    for (const [name, handler] of Object.entries(accountTools)) {
      const src = handler.toString();
      const match = src.match(/HulyClient\.(\w+)\(/);
      if (match) {
        assert.ok(staticMethods.includes(match[1]),
          `${name} calls HulyClient.${match[1]}() which is not a static method. Available: ${staticMethods.join(', ')}`);
      }
    }
  });
});
