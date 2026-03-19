import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
const PROJECT = 'MCPT';          // Dedicated test project, created/deleted per run
const EXISTING_PROJECT = process.env.HULY_TEST_PROJECT || 'START';  // Pre-existing project for read-only tests
const TEST_PREFIX = '[TEST]';
const HULY_CREDS = process.env.HULY_TOKEN
  ? { token: process.env.HULY_TOKEN }
  : { email: process.env.HULY_EMAIL, password: process.env.HULY_PASSWORD };

// Set HULY_URL for the pool/client modules
process.env.HULY_URL = HULY_URL;
process.env.HULY_WORKSPACE = process.env.HULY_WORKSPACE || 'default';
const WORKSPACE = process.env.HULY_WORKSPACE;

// ════════════════════════════════════════════════════════════════
// 1. UNIT TESTS (no Huly connection needed)
// ════════════════════════════════════════════════════════════════

describe('Unit Tests', () => {

  // ── Priority mapping constants ──────────────────────────────

  describe('Priority mapping', () => {
    let PRIORITY_MAP, PRIORITY_NAMES;

    before(async () => {
      const mod = await import('../src/client.mjs');
      PRIORITY_MAP = mod.PRIORITY_MAP;
      PRIORITY_NAMES = mod.PRIORITY_NAMES;
    });

    it('maps "urgent" to 1', () => {
      assert.equal(PRIORITY_MAP['urgent'], 1);
    });

    it('maps "high" to 2', () => {
      assert.equal(PRIORITY_MAP['high'], 2);
    });

    it('maps "medium" to 3', () => {
      assert.equal(PRIORITY_MAP['medium'], 3);
    });

    it('maps "low" to 4', () => {
      assert.equal(PRIORITY_MAP['low'], 4);
    });

    it('maps "none" to 0', () => {
      assert.equal(PRIORITY_MAP['none'], 0);
    });

    it('has correct PRIORITY_NAMES array', () => {
      assert.deepEqual(PRIORITY_NAMES, ['No Priority', 'Urgent', 'High', 'Medium', 'Low']);
    });

    it('PRIORITY_NAMES index matches PRIORITY_MAP values', () => {
      assert.equal(PRIORITY_NAMES[PRIORITY_MAP['urgent']], 'Urgent');
      assert.equal(PRIORITY_NAMES[PRIORITY_MAP['high']], 'High');
      assert.equal(PRIORITY_NAMES[PRIORITY_MAP['medium']], 'Medium');
      assert.equal(PRIORITY_NAMES[PRIORITY_MAP['low']], 'Low');
      assert.equal(PRIORITY_NAMES[PRIORITY_MAP['none']], 'No Priority');
    });
  });

  // ── Milestone status mapping constants ──────────────────────

  describe('Milestone status mapping', () => {
    let MILESTONE_STATUS_MAP, MILESTONE_STATUS_NAMES;

    before(async () => {
      const mod = await import('../src/client.mjs');
      MILESTONE_STATUS_MAP = mod.MILESTONE_STATUS_MAP;
      MILESTONE_STATUS_NAMES = mod.MILESTONE_STATUS_NAMES;
    });

    it('maps "planned" to 0', () => {
      assert.equal(MILESTONE_STATUS_MAP['planned'], 0);
    });

    it('maps "in progress" to 1', () => {
      assert.equal(MILESTONE_STATUS_MAP['in progress'], 1);
    });

    it('maps "inprogress" to 1 (alias)', () => {
      assert.equal(MILESTONE_STATUS_MAP['inprogress'], 1);
    });

    it('maps "completed" to 2', () => {
      assert.equal(MILESTONE_STATUS_MAP['completed'], 2);
    });

    it('maps "canceled" to 3', () => {
      assert.equal(MILESTONE_STATUS_MAP['canceled'], 3);
    });

    it('maps "cancelled" to 3 (British spelling)', () => {
      assert.equal(MILESTONE_STATUS_MAP['cancelled'], 3);
    });

    it('has correct MILESTONE_STATUS_NAMES array', () => {
      assert.deepEqual(MILESTONE_STATUS_NAMES, ['Planned', 'In Progress', 'Completed', 'Canceled']);
    });
  });

  // ── Issue ID regex parsing ──────────────────────────────────

  describe('Issue ID regex parsing', () => {
    const ISSUE_ID_RE = /^([A-Z0-9]+)-(\d+)$/i;

    it('parses a standard issue ID', () => {
      const m = 'PROJ-42'.match(ISSUE_ID_RE);
      assert.ok(m);
      assert.equal(m[1], 'PROJ');
      assert.equal(m[2], '42');
    });

    it('parses a lowercase issue ID', () => {
      const m = 'ops-100'.match(ISSUE_ID_RE);
      assert.ok(m);
      assert.equal(m[1], 'ops');
      assert.equal(m[2], '100');
    });

    it('parses numeric-only project identifiers', () => {
      const m = 'P2-5'.match(ISSUE_ID_RE);
      assert.ok(m);
      assert.equal(m[1], 'P2');
      assert.equal(m[2], '5');
    });

    it('rejects missing number', () => {
      const m = 'PROJ-'.match(ISSUE_ID_RE);
      assert.equal(m, null);
    });

    it('rejects missing project', () => {
      const m = '-42'.match(ISSUE_ID_RE);
      assert.equal(m, null);
    });

    it('rejects no hyphen', () => {
      const m = 'PROJ42'.match(ISSUE_ID_RE);
      assert.equal(m, null);
    });

    it('rejects double hyphen', () => {
      const m = 'PROJ--42'.match(ISSUE_ID_RE);
      assert.equal(m, null);
    });

    it('rejects spaces', () => {
      const m = 'PROJ - 42'.match(ISSUE_ID_RE);
      assert.equal(m, null);
    });
  });

  // ── matchRoute function ─────────────────────────────────────

  describe('matchRoute', () => {
    // Copy of the matchRoute function from server.mjs
    function matchRoute(pattern, pathname) {
      const patParts = pattern.split('/');
      const urlParts = pathname.split('/');
      if (patParts.length !== urlParts.length) return null;
      const params = {};
      for (let i = 0; i < patParts.length; i++) {
        if (patParts[i].startsWith(':')) {
          params[patParts[i].slice(1)] = decodeURIComponent(urlParts[i]);
        } else if (patParts[i] !== urlParts[i]) {
          return null;
        }
      }
      return params;
    }

    it('matches a simple route with one param', () => {
      const result = matchRoute('/api/projects/:identifier', '/api/projects/OPS');
      assert.deepEqual(result, { identifier: 'OPS' });
    });

    it('matches a route with two params', () => {
      const result = matchRoute('/api/projects/:project/issues/:number', '/api/projects/OPS/issues/42');
      assert.deepEqual(result, { project: 'OPS', number: '42' });
    });

    it('returns null for path length mismatch', () => {
      const result = matchRoute('/api/projects/:identifier', '/api/projects/OPS/extra');
      assert.equal(result, null);
    });

    it('returns null for static segment mismatch', () => {
      const result = matchRoute('/api/projects/:identifier', '/api/users/OPS');
      assert.equal(result, null);
    });

    it('decodes URI components in params', () => {
      const result = matchRoute('/api/labels/:name', '/api/labels/my%20label');
      assert.deepEqual(result, { name: 'my label' });
    });

    it('returns empty object for no-param routes', () => {
      const result = matchRoute('/api/projects', '/api/projects');
      assert.deepEqual(result, {});
    });

    it('returns null for completely different paths', () => {
      const result = matchRoute('/health', '/api/projects');
      assert.equal(result, null);
    });
  });

  // ── Rate limiting logic ─────────────────────────────────────

  describe('Rate limiting logic', () => {
    it('allows requests within the limit', () => {
      const RATE_LIMIT = 5;
      const RATE_WINDOW_MS = 60000;
      const store = new Map();

      function checkRateLimit(ip) {
        const now = Date.now();
        let entry = store.get(ip);
        if (!entry || now > entry.resetAt) {
          entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
          store.set(ip, entry);
        }
        entry.count++;
        return {
          allowed: entry.count <= RATE_LIMIT,
          remaining: Math.max(0, RATE_LIMIT - entry.count),
          resetAt: entry.resetAt
        };
      }

      // First 5 requests should be allowed
      for (let i = 0; i < RATE_LIMIT; i++) {
        const result = checkRateLimit('127.0.0.1');
        assert.equal(result.allowed, true, `Request ${i + 1} should be allowed`);
        assert.equal(result.remaining, RATE_LIMIT - (i + 1));
      }

      // 6th request should be blocked
      const blocked = checkRateLimit('127.0.0.1');
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.remaining, 0);
    });

    it('tracks different IPs separately', () => {
      const store = new Map();
      const RATE_LIMIT = 2;
      const RATE_WINDOW_MS = 60000;

      function checkRateLimit(ip) {
        const now = Date.now();
        let entry = store.get(ip);
        if (!entry || now > entry.resetAt) {
          entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
          store.set(ip, entry);
        }
        entry.count++;
        return {
          allowed: entry.count <= RATE_LIMIT,
          remaining: Math.max(0, RATE_LIMIT - entry.count),
          resetAt: entry.resetAt
        };
      }

      checkRateLimit('10.0.0.1');
      checkRateLimit('10.0.0.1');
      const blockedA = checkRateLimit('10.0.0.1');
      assert.equal(blockedA.allowed, false);

      // Different IP should still be allowed
      const allowedB = checkRateLimit('10.0.0.2');
      assert.equal(allowedB.allowed, true);
    });

    it('resets after the time window', () => {
      const store = new Map();
      const RATE_LIMIT = 1;

      function checkRateLimit(ip) {
        const now = Date.now();
        let entry = store.get(ip);
        if (!entry || now > entry.resetAt) {
          entry = { count: 0, resetAt: now + 1 }; // 1ms window for testing
          store.set(ip, entry);
        }
        entry.count++;
        return {
          allowed: entry.count <= RATE_LIMIT,
          remaining: Math.max(0, RATE_LIMIT - entry.count),
          resetAt: entry.resetAt
        };
      }

      const first = checkRateLimit('1.2.3.4');
      assert.equal(first.allowed, true);

      const second = checkRateLimit('1.2.3.4');
      assert.equal(second.allowed, false);

      // Simulate time passing by manipulating the entry
      store.get('1.2.3.4').resetAt = Date.now() - 1;

      const third = checkRateLimit('1.2.3.4');
      assert.equal(third.allowed, true);
    });
  });

  // ── Auth middleware logic ────────────────────────────────────

  describe('Auth middleware logic', () => {
    function checkAuth(apiToken, authHeader) {
      if (!apiToken) return { authorized: true };
      const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice(7)
        : null;
      return { authorized: token === apiToken };
    }

    it('allows all requests when no API_TOKEN is set', () => {
      assert.equal(checkAuth(null, '').authorized, true);
      assert.equal(checkAuth(null, undefined).authorized, true);
    });

    it('allows valid Bearer token', () => {
      assert.equal(checkAuth('secret123', 'Bearer secret123').authorized, true);
    });

    it('rejects missing Authorization header', () => {
      assert.equal(checkAuth('secret123', '').authorized, false);
      assert.equal(checkAuth('secret123', undefined).authorized, false);
    });

    it('rejects wrong token', () => {
      assert.equal(checkAuth('secret123', 'Bearer wrong').authorized, false);
    });

    it('rejects non-Bearer auth scheme', () => {
      assert.equal(checkAuth('secret123', 'Basic secret123').authorized, false);
    });

    it('is case-sensitive for Bearer prefix', () => {
      assert.equal(checkAuth('secret123', 'bearer secret123').authorized, false);
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 2. INTEGRATION TESTS (hit live Huly)
// ════════════════════════════════════════════════════════════════

describe('Integration Tests', { timeout: 120_000 }, () => {
  let client;
  const testIssueIds = [];   // Collect issue IDs for cleanup
  let lifecycleIssueId;      // The main lifecycle test issue

  before(async () => {
    const { HulyClient } = await import('../src/client.mjs');
    client = new HulyClient({
      url: HULY_URL,
      email: process.env.HULY_EMAIL,
      password: process.env.HULY_PASSWORD,
      token: process.env.HULY_TOKEN,
      workspace: process.env.HULY_WORKSPACE
    });
    await client.connect();

    // Create dedicated test project
    try {
      await client.createProject(PROJECT, 'MCP Test Project', 'Automated test project', false, undefined, 'Classic project');
    } catch (e) {
      // Already exists from a prior run — that's fine
      if (!e.message.includes('already exists')) throw e;
    }
  });

  after(async () => {
    // Delete test project (removes all test data)
    try {
      await client.deleteProject(PROJECT);
    } catch {
      // Best-effort cleanup
    }
    if (client) client.disconnect();
  });

  // ── Connect to workspace ────────────────────────────────────

  describe('Connection', () => {
    it('connects to the workspace', () => {
      // If before() succeeded, we are connected
      assert.ok(client, 'Client should be instantiated');
    });
  });

  // ── list_projects ───────────────────────────────────────────

  describe('list_projects', () => {
    it('returns projects including test project', async () => {
      const projects = await client.listProjects();
      assert.ok(Array.isArray(projects), 'Should return an array');
      assert.ok(projects.length > 0, 'Should have at least one project');

      const ops = projects.find(p => p.identifier === PROJECT);
      assert.ok(ops, `Project ${PROJECT} should exist`);
      assert.ok(typeof ops.name === 'string');
      assert.ok(typeof ops.issueCount === 'number');
      assert.ok(ops.issueCount >= 0, `Expected issueCount >= 0, got ${ops.issueCount}`);
    });
  });

  // ── get_project ─────────────────────────────────────────────

  describe('get_project', () => {
    it('returns OPS project details', async () => {
      const proj = await client.getProject(PROJECT);
      assert.equal(proj.identifier, PROJECT);
      assert.ok(typeof proj.name === 'string');
      assert.ok(typeof proj.issueCount === 'number');
      assert.ok(proj.issueCount >= 0, `Expected issueCount >= 0, got ${proj.issueCount}`);
    });

    it('throws for nonexistent project', async () => {
      await assert.rejects(
        () => client.getProject('NONEXISTENT999'),
        /not found/i
      );
    });
  });

  // ── list_issues ─────────────────────────────────────────────

  describe('list_issues', () => {
    it('returns issues for OPS', async () => {
      const issues = await client.listIssues(PROJECT, undefined, undefined, undefined, undefined, 5);
      assert.ok(Array.isArray(issues));
      // OPS may have very few issues
      if (issues.length > 0) {
        const first = issues[0];
        assert.ok(first.id.startsWith(`${PROJECT}-`));
        assert.ok(typeof first.title === 'string');
        assert.ok(typeof first.status === 'string');
        assert.ok(typeof first.priority === 'string');
      }
    });

    it('respects limit parameter', async () => {
      const issues = await client.listIssues(PROJECT, undefined, undefined, undefined, undefined, 5);
      assert.ok(issues.length <= 5);
    });
  });

  // ── list_statuses ───────────────────────────────────────────

  describe('list_statuses', () => {
    it('returns available statuses', async () => {
      const statuses = await client.listStatuses();
      assert.ok(Array.isArray(statuses));
      assert.ok(statuses.length > 0);
      const names = statuses.map(s => s.name);
      // At minimum, these standard statuses should exist
      assert.ok(names.some(n => /todo/i.test(n)), 'Should have a Todo-like status');
    });
  });

  // ── list_members ────────────────────────────────────────────

  describe('list_members', () => {
    it('returns workspace members', async () => {
      const members = await client.listMembers();
      assert.ok(Array.isArray(members));
      assert.ok(members.length > 0, 'Should have at least one member');
      const first = members[0];
      assert.ok(typeof first.name === 'string');
    });
  });

  // ── list_labels ─────────────────────────────────────────────

  describe('list_labels', () => {
    it('returns labels array', async () => {
      const labels = await client.listLabels();
      assert.ok(Array.isArray(labels));
      // May be empty if no labels exist yet, but should at least be an array
    });
  });

  // ── list_milestones ─────────────────────────────────────────

  describe('list_milestones', () => {
    it('returns milestones for OPS', async () => {
      const milestones = await client.listMilestones(PROJECT);
      assert.ok(Array.isArray(milestones));
      // Milestones may or may not exist, just verify it returns an array
    });
  });

  // ── list_task_types ─────────────────────────────────────────

  describe('list_task_types', () => {
    it('returns task types for OPS', async () => {
      const types = await client.listTaskTypes(PROJECT);
      assert.ok(Array.isArray(types));
      assert.ok(types.length > 0, 'Should have at least one task type');
      const names = types.map(t => t.name);
      // Should at least have a basic Issue type
      assert.ok(names.length > 0, 'Should have named task types');
    });
  });

  // ── search_issues ───────────────────────────────────────────

  describe('search_issues', () => {
    it('finds issues matching a search term', async () => {
      const results = await client.searchIssues('issue', PROJECT, 5);
      assert.ok(Array.isArray(results));
      // Search may return results if any titles contain "issue"
    });
  });

  // ── get_my_issues ───────────────────────────────────────────

  describe('get_my_issues', () => {
    it('returns issues assigned to the current user', async () => {
      const issues = await client.getMyIssues(undefined, undefined, 10);
      assert.ok(Array.isArray(issues));
      // May be empty if nothing is assigned to the user
    });
  });

  // ── summarize_project ───────────────────────────────────────

  describe('summarize_project', () => {
    it('returns summary for OPS', async () => {
      const summary = await client.summarizeProject(PROJECT);
      assert.ok(summary, 'Should return a summary object');
      assert.ok(typeof summary.totalIssues === 'number' || typeof summary.total === 'number',
        'Should have a total issue count');
    });
  });

  // ── Full lifecycle test ─────────────────────────────────────

  describe('Issue lifecycle (create, get, update, comment, time, history)', () => {
    it('creates a test issue', async () => {
      const result = await client.createIssue(
        PROJECT,
        `${TEST_PREFIX} Lifecycle test issue`,
        'This is an automated test issue for integration testing.',
        'medium',
        'Todo'
      );
      assert.ok(result, 'Should return a result');
      assert.ok(typeof result.id === 'string', 'Should have an issue id');
      assert.ok(result.id.startsWith(`${PROJECT}-`), `ID should start with ${PROJECT}-`);
      lifecycleIssueId = result.id;
      testIssueIds.push(lifecycleIssueId);
    });

    it('gets the created issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const issue = await client.getIssue(lifecycleIssueId);
      assert.ok(issue);
      assert.equal(issue.id, lifecycleIssueId);
      assert.ok(issue.title.includes(TEST_PREFIX));
      assert.equal(issue.priority, 'Medium');
    });

    it('updates the issue title and priority', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.updateIssue(
        lifecycleIssueId,
        `${TEST_PREFIX} Lifecycle test issue (updated)`,
        undefined,
        'high',
        undefined
      );
      assert.ok(result, 'Should return an update result');

      // Verify the update
      const issue = await client.getIssue(lifecycleIssueId);
      assert.ok(issue.title.includes('(updated)'));
      assert.equal(issue.priority, 'High');
    });

    it('adds a comment', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.addComment(
        lifecycleIssueId,
        'Automated test comment from integration tests.'
      );
      assert.ok(result, 'Should return a comment result');
    });

    it('lists comments on the issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const comments = await client.listComments(lifecycleIssueId);
      assert.ok(Array.isArray(comments));
      assert.ok(comments.length >= 1, 'Should have at least one comment');
      const found = comments.some(c =>
        (c.text || c.body || '').includes('Automated test comment')
      );
      assert.ok(found, 'Should find the test comment');
    });

    it('sets a due date', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.setDueDate(lifecycleIssueId, '2026-12-31');
      assert.ok(result, 'Should return a result');
      const issue = await client.getIssue(lifecycleIssueId);
      const due = new Date(issue.dueDate);
      assert.equal(due.getUTCFullYear(), 2026);
      assert.equal(due.getUTCMonth(), 11);
      assert.equal(due.getUTCDate(), 31);
    });

    it('sets an estimation', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.setEstimation(lifecycleIssueId, 4);
      assert.ok(result, 'Should return a result');
      const issue = await client.getIssue(lifecycleIssueId);
      assert.equal(issue.estimation, 4);
    });

    it('logs time', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.logTime(lifecycleIssueId, 1.5, 'Test time log');
      assert.ok(result, 'Should return a result');
      const reports = await client.listTimeReports(lifecycleIssueId);
      assert.ok(Array.isArray(reports));
      assert.ok(reports.some(r => r.hours === 1.5), 'Should find the 1.5h time entry');
    });

    it('gets issue history', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const history = await client.getIssueHistory(lifecycleIssueId);
      assert.ok(history, 'Should return history');
      // History can be an array or object depending on implementation
      if (Array.isArray(history)) {
        assert.ok(history.length >= 0);
      } else {
        assert.ok(typeof history === 'object');
      }
    });
  });

  // ── Label operations on test issue ──────────────────────────

  describe('Label operations (add + remove)', () => {
    it('adds a label to the lifecycle issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.addLabel(lifecycleIssueId, 'test-integration');
      assert.ok(result, 'Should return a result');
    });

    it('verifies the label is on the issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const issue = await client.getIssue(lifecycleIssueId);
      const labels = issue.labels || [];
      assert.ok(
        labels.some(l => (typeof l === 'string' ? l : l.name) === 'test-integration'),
        'Issue should have the test-integration label'
      );
    });

    it('removes the label from the issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.removeLabel(lifecycleIssueId, 'test-integration');
      assert.ok(result, 'Should return a result');
      const issue = await client.getIssue(lifecycleIssueId);
      const labels = issue.labels || [];
      assert.ok(
        !labels.some(l => (typeof l === 'string' ? l : l.name) === 'test-integration'),
        'Issue should no longer have the test-integration label'
      );
    });
  });

  // ── batch_create_issues ─────────────────────────────────────

  describe('batch_create_issues', () => {
    it('creates 3 test issues in a batch', async () => {
      const issues = [
        { title: `${TEST_PREFIX} Batch issue 1`, priority: 'low' },
        { title: `${TEST_PREFIX} Batch issue 2`, priority: 'medium' },
        { title: `${TEST_PREFIX} Batch issue 3`, priority: 'high' }
      ];
      const result = await client.batchCreateIssues(PROJECT, issues);
      assert.ok(result, 'Should return a result');

      // Collect created IDs for cleanup
      const created = result.created || result.issues || result;
      if (Array.isArray(created)) {
        for (const item of created) {
          const id = item.id || item.issueId || item;
          if (typeof id === 'string' && id.includes('-')) {
            testIssueIds.push(id);
          }
        }
      }
      assert.ok(result.created && result.created.length >= 3, 'Should have created 3 issues');
    });
  });

  // ── create_issues_from_template ─────────────────────────────

  describe('create_issues_from_template', () => {
    it('creates issues from the "sprint" template', async () => {
      const result = await client.createIssuesFromTemplate(
        PROJECT,
        'sprint',
        { title: `${TEST_PREFIX} Template Sprint` }
      );
      assert.ok(result, 'Should return a result');

      // Collect created IDs for cleanup
      const created = result.created || result.issues || [];
      if (Array.isArray(created)) {
        for (const item of created) {
          const id = item.id || item.issueId || item;
          if (typeof id === 'string' && id.includes('-')) {
            testIssueIds.push(id);
          }
        }
      }
      // The parent bug ID
      if (result.parentId) testIssueIds.push(result.parentId);
      if (result.parent?.id) testIssueIds.push(result.parent.id);
    });
  });

  // ── set_parent ──────────────────────────────────────────────

  describe('set_parent', () => {
    let parentIssueId;
    let childIssueId;

    before(async () => {
      // Create parent
      const parent = await client.createIssue(
        PROJECT,
        `${TEST_PREFIX} Parent issue`,
        'Parent for set_parent test'
      );
      parentIssueId = parent.id;
      testIssueIds.push(parentIssueId);

      // Create child
      const child = await client.createIssue(
        PROJECT,
        `${TEST_PREFIX} Child issue`,
        'Child for set_parent test'
      );
      childIssueId = child.id;
      testIssueIds.push(childIssueId);
    });

    it('sets a parent-child relationship', async () => {
      assert.ok(parentIssueId && childIssueId, 'Both issues must exist');
      const result = await client.setParent(childIssueId, parentIssueId);
      assert.ok(result, 'Should return a result');
    });

    it('verifies the child has a parent', async () => {
      assert.ok(childIssueId, 'Child issue must exist');
      const issue = await client.getIssue(childIssueId);
      assert.equal(issue.parent, parentIssueId, 'Child should reference the parent');
    });
  });

  // ── assign_issue ──────────────────────────────────────────

  describe('assign_issue', () => {
    it('assigns the lifecycle issue to a member', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const members = await client.listMembers();
      assert.ok(members.length > 0, 'Need at least one member');
      const result = await client.assignIssue(lifecycleIssueId, members[0].name);
      assert.ok(result);
      assert.ok(result.message.includes('Assigned'));
    });

    it('unassigns the issue', async () => {
      assert.ok(lifecycleIssueId, 'Lifecycle issue must exist');
      const result = await client.assignIssue(lifecycleIssueId, '');
      assert.ok(result);
      assert.ok(result.message.includes('Unassigned'));
    });
  });

  // ── add_relation ──────────────────────────────────────────

  describe('add_relation', () => {
    let relatedIssueId;

    before(async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} Related issue`);
      relatedIssueId = issue.id;
      testIssueIds.push(relatedIssueId);
    });

    it('adds a relation between two issues', async () => {
      assert.ok(lifecycleIssueId && relatedIssueId);
      const result = await client.addRelation(lifecycleIssueId, relatedIssueId);
      assert.ok(result);
      assert.ok(result.message.includes('related'));
    });
  });

  // ── add_blocked_by ────────────────────────────────────────

  describe('add_blocked_by', () => {
    let blockerIssueId;

    before(async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} Blocker issue`);
      blockerIssueId = issue.id;
      testIssueIds.push(blockerIssueId);
    });

    it('adds a blocked-by dependency', async () => {
      assert.ok(lifecycleIssueId && blockerIssueId);
      const result = await client.addBlockedBy(lifecycleIssueId, blockerIssueId);
      assert.ok(result);
      assert.ok(result.message.includes('blocked by'));
    });
  });

  // ── create_label ──────────────────────────────────────────

  describe('create_label', () => {
    it('creates a new label', async () => {
      const result = await client.createLabel(`${TEST_PREFIX}-label-${Date.now()}`);
      assert.ok(result);
      assert.ok(result.id, 'createLabel should return id');
    });
  });

  // ── milestone lifecycle ───────────────────────────────────

  describe('Milestone lifecycle (create, get, set, clear)', () => {
    const msName = `${TEST_PREFIX} Milestone ${Date.now()}`;

    it('creates a milestone', async () => {
      const result = await client.createMilestone(PROJECT, msName, 'Test milestone', '2026-12-31', 'Planned');
      assert.ok(result);
      assert.ok(result.id, 'createMilestone should return id');
    });

    it('gets the milestone', async () => {
      const result = await client.getMilestone(PROJECT, msName);
      assert.ok(result);
      assert.equal(result.name, msName);
    });

    it('sets the milestone on the lifecycle issue', async () => {
      assert.ok(lifecycleIssueId);
      const result = await client.setMilestone(lifecycleIssueId, msName);
      assert.ok(result);
    });

    it('clears the milestone from the issue', async () => {
      assert.ok(lifecycleIssueId);
      const result = await client.setMilestone(lifecycleIssueId, '');
      assert.ok(result);
      assert.ok(result.message.includes('Cleared'));
    });
  });

  // ── move_issue ────────────────────────────────────────────

  describe('move_issue', () => {
    it('moves an issue to the same project (no-op)', async () => {
      assert.ok(lifecycleIssueId);
      const result = await client.moveIssue(lifecycleIssueId, PROJECT);
      assert.ok(result);
      assert.ok(result.message.includes('already'));
    });
  });

  // ── Project management ──────────────────────────────────

  describe('create_project + delete_project', () => {
    const tempProj = 'TPRJ';

    it('creates a new project', async () => {
      const result = await client.createProject(tempProj, 'Temp Project', 'For testing', false, undefined, 'Classic project');
      assert.ok(result.id);
      assert.equal(result.identifier, tempProj);
    });

    it('rejects duplicate identifier', async () => {
      await assert.rejects(() => client.createProject(tempProj, 'Dup'), /already exists/);
    });

    it('archives the project', async () => {
      const result = await client.archiveProject(tempProj);
      assert.ok(result.archived);
    });

    // Note: unarchive not tested because the Huly SDK excludes archived projects from queries.
    // Once archived, the project cannot be found via findOne/findAll.

    it('deletes the project (create fresh for delete)', async () => {
      // Create a new one to delete since TPRJ is now archived and invisible
      const tempProj2 = 'TPR2';
      await client.createProject(tempProj2, 'Temp 2', 'For delete test', false, undefined, 'Classic project');
      const result = await client.deleteProject(tempProj2);
      assert.ok(result.message.includes('deleted'));
    });
  });

  // ── delete_issue ────────────────────────────────────────

  describe('delete_issue', () => {
    it('creates and deletes an issue', async () => {
      const created = await client.createIssue(PROJECT, `${TEST_PREFIX} delete me`);
      const result = await client.deleteIssue(created.id);
      assert.ok(result.message.includes('deleted'));

      // Verify it's gone
      await assert.rejects(() => client.getIssue(created.id), /not found/i);
    });
  });

  // ── Component lifecycle ──────────────────────────────────

  describe('Component lifecycle (create, update, delete)', () => {
    const compName = `${TEST_PREFIX}-comp-${Date.now()}`;

    it('creates a component', async () => {
      const result = await client.createComponent(PROJECT, compName, 'Test component');
      assert.ok(result.id, 'createComponent should return id');
    });

    it('reads back the created component', async () => {
      const components = await client.listComponents(PROJECT);
      assert.ok(Array.isArray(components));
      const found = components.find(c => c.name === compName);
      assert.ok(found, 'Should find the created component');
      assert.equal(found.description, 'Test component');
    });

    it('updates the component', async () => {
      const result = await client.updateComponent(PROJECT, compName, { description: 'Updated desc' });
      assert.ok(result, 'Should return a result');
    });

    it('reads back the updated component', async () => {
      const components = await client.listComponents(PROJECT);
      const found = components.find(c => c.name === compName);
      assert.ok(found, 'Should find the component');
      assert.equal(found.description, 'Updated desc');
    });

    it('deletes the component', async () => {
      const result = await client.deleteComponent(PROJECT, compName);
      assert.ok(result.message.includes('deleted'));
    });
  });

  // ── Milestone update + delete ───────────────────────────

  describe('Milestone update + delete', () => {
    it('creates a milestone for testing', async () => {
      const result = await client.createMilestone(PROJECT, 'TestMS', 'For testing', '2026-12-31');
      assert.ok(result.id || result.message);
    });

    it('updates milestone fields', async () => {
      const result = await client.updateMilestone(PROJECT, 'TestMS', {
        description: 'Updated description',
        status: 'in progress'
      });
      assert.ok(result.updated.includes('description'));
      assert.ok(result.updated.includes('status'));
    });

    it('deletes the milestone', async () => {
      const result = await client.deleteMilestone(PROJECT, 'TestMS');
      assert.ok(result.message.includes('deleted'));
    });
  });

  // ── Time report listing + deletion ──────────────────────

  describe('Time report list + delete', () => {
    let testIssueId;
    let reportId;

    it('creates an issue with time logged', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} time report test`);
      testIssueId = issue.id;
      const logged = await client.logTime(testIssueId, 2.5, 'Testing time');
      reportId = logged.id;
      assert.ok(reportId);
    });

    it('lists time reports', async () => {
      const reports = await client.listTimeReports(testIssueId);
      assert.ok(Array.isArray(reports));
      assert.ok(reports.length >= 1);
      assert.ok(reports.some(r => r.id === reportId));
    });

    it('deletes a time report', async () => {
      const result = await client.deleteTimeReport(reportId);
      assert.ok(result.message.includes('deleted'));
      assert.equal(result.hours, 2.5);
    });
  });

  // ── Comment update + delete ─────────────────────────────

  describe('Comment update + delete', () => {
    let testIssueId;
    let commentId;

    it('creates an issue with a comment', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} comment ops test`);
      testIssueId = issue.id;
      const comment = await client.addComment(testIssueId, 'Original text');
      commentId = comment.id;
      assert.ok(commentId);
    });

    it('updates a comment', async () => {
      const result = await client.updateComment(testIssueId, commentId, 'Updated text');
      assert.ok(result.message.includes('updated'));
    });

    it('verifies comment was updated', async () => {
      const comments = await client.listComments(testIssueId);
      const updated = comments.find(c => c.id === commentId);
      assert.ok(updated);
      assert.equal(updated.text, 'Updated text');
    });

    it('deletes a comment', async () => {
      const result = await client.deleteComment(testIssueId, commentId);
      assert.ok(result.message.includes('deleted'));
    });
  });

  // ── Single-item lookups (get_*) ───────────────────────────

  describe('get_label', () => {
    it('creates and retrieves a label by name', async () => {
      await client.createLabel('TestLookup', 7);
      const label = await client.getLabel('TestLookup');
      assert.equal(label.name, 'TestLookup');
      assert.equal(label.color, 7);
    });

    it('throws for nonexistent label', async () => {
      await assert.rejects(() => client.getLabel('NoSuchLabel999'), /not found/i);
    });
  });

  describe('get_member', () => {
    it('finds a member by name', async () => {
      const members = await client.listMembers();
      assert.ok(members.length > 0, 'Should have at least one member');
      const member = await client.getMember(members[0].name);
      assert.equal(member.name, members[0].name);
    });

    it('throws for nonexistent member', async () => {
      await assert.rejects(() => client.getMember('NoSuchPerson999'), /not found/i);
    });
  });

  describe('get_status', () => {
    it('finds a status by name', async () => {
      const status = await client.getStatus('Backlog');
      assert.equal(status.name, 'Backlog');
      assert.ok(status.category, 'Should have a category');
    });

    it('throws for nonexistent status', async () => {
      await assert.rejects(() => client.getStatus('NoSuchStatus999'), /not found/i);
    });
  });

  describe('get_component', () => {
    const compName = `${TEST_PREFIX}-get-comp-${Date.now()}`;

    it('creates and retrieves a component by name', async () => {
      await client.createComponent(PROJECT, compName, 'Lookup test');
      const comp = await client.getComponent(PROJECT, compName);
      assert.equal(comp.name, compName);
      assert.equal(comp.description, 'Lookup test');
    });

    it('throws for nonexistent component', async () => {
      await assert.rejects(() => client.getComponent(PROJECT, 'NoComp999'), /not found/i);
    });

    after(async () => {
      try { await client.deleteComponent(PROJECT, compName); } catch {}
    });
  });

  describe('get_task_type', () => {
    it('finds a task type by name', async () => {
      const types = await client.listTaskTypes(PROJECT);
      assert.ok(types.length > 0, 'Should have at least one task type');
      const tt = await client.getTaskType(PROJECT, types[0].name);
      assert.equal(tt.name, types[0].name);
      assert.ok(tt.statuses, 'Should have statuses');
    });

    it('throws for nonexistent task type', async () => {
      await assert.rejects(() => client.getTaskType(PROJECT, 'NoType999'), /not found/i);
    });
  });

  describe('get_comment', () => {
    let issueId, cmtId;

    it('creates issue and comment, then retrieves comment by ID', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} get_comment test`);
      issueId = issue.id;
      testIssueIds.push(issueId);
      const cmt = await client.addComment(issueId, 'Lookup test comment');
      cmtId = cmt.id;
      const result = await client.getComment(issueId, cmtId);
      assert.equal(result.id, cmtId);
      assert.ok(result.text.includes('Lookup test comment'));
    });

    it('throws for nonexistent comment', async () => {
      await assert.rejects(() => client.getComment(issueId, 'badid000000000000'), /not found/i);
    });
  });

  describe('get_time_report', () => {
    let issueId, reportId;

    it('creates issue, logs time, then retrieves report by ID', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} get_time_report test`);
      issueId = issue.id;
      testIssueIds.push(issueId);
      const logged = await client.logTime(issueId, 1.5, 'Test work');
      reportId = logged.id;
      const result = await client.getTimeReport(issueId, reportId);
      assert.equal(result.id, reportId);
      assert.equal(result.hours, 1.5);
    });

    it('throws for nonexistent report', async () => {
      await assert.rejects(() => client.getTimeReport(issueId, 'badid000000000000'), /not found/i);
    });
  });

  // ── include_details flag ──────────────────────────────────

  describe('get_issue with include_details', () => {
    let issueId;

    before(async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} details test`, 'Details test description');
      issueId = issue.id;
      testIssueIds.push(issueId);
      await client.addComment(issueId, 'Detail comment');
      await client.logTime(issueId, 2, 'Detail work');
    });

    it('returns basic fields without include_details', async () => {
      const issue = await client.getIssue(issueId);
      assert.ok(issue.title);
      assert.ok(issue.description);
      assert.equal(issue.comments, undefined);
      assert.equal(issue.timeReports, undefined);
    });

    it('returns comments and timeReports with include_details', async () => {
      const issue = await client.getIssue(issueId, { include_details: true });
      assert.ok(issue.title);
      assert.ok(Array.isArray(issue.comments), 'Should have comments array');
      assert.ok(issue.comments.length >= 1, 'Should have at least 1 comment');
      assert.ok(issue.comments[0].text.includes('Detail comment'));
      assert.ok(Array.isArray(issue.timeReports), 'Should have timeReports array');
      assert.ok(issue.timeReports.length >= 1, 'Should have at least 1 time report');
      assert.equal(issue.timeReports[0].hours, 2);
    });
  });

  describe('list_issues with include_details', () => {
    it('returns descriptions when include_details is true', async () => {
      const issues = await client.listIssues(PROJECT, null, null, null, null, 5, true);
      assert.ok(issues.length > 0, 'Should have issues');
      const withDesc = issues.find(i => i.description && i.description.length > 0);
      assert.ok(withDesc, 'At least one issue should have a resolved description');
    });

    it('omits descriptions by default', async () => {
      const issues = await client.listIssues(PROJECT, null, null, null, null, 5);
      assert.ok(issues.length > 0);
      // Default list should not have description at top level
      // (it may be in extra but not resolved)
    });
  });

  describe('get_project with include_details', () => {
    it('returns milestones and components with include_details', async () => {
      const proj = await client.getProject(PROJECT, { include_details: true });
      assert.ok(proj.identifier);
      assert.ok(Array.isArray(proj.milestones), 'Should have milestones array');
      assert.ok(Array.isArray(proj.components), 'Should have components array');
      assert.ok(Array.isArray(proj.labels), 'Should have labels array');
      assert.ok(Array.isArray(proj.members), 'Should have members array');
    });

    it('omits details by default', async () => {
      const proj = await client.getProject(PROJECT);
      assert.equal(proj.milestones, undefined);
      assert.equal(proj.components, undefined);
    });
  });

  describe('list_projects with include_details', () => {
    it('returns enriched projects with include_details', async () => {
      const projects = await client.listProjects({ include_details: true });
      assert.ok(projects.length > 0);
      const proj = projects.find(p => p.identifier === PROJECT);
      assert.ok(proj, 'Should find test project');
      assert.ok(Array.isArray(proj.milestones), 'Should have milestones');
    });
  });

  describe('get_milestone with include_details', () => {
    const msName = `${TEST_PREFIX}-ms-details-${Date.now()}`;

    before(async () => {
      await client.createMilestone(PROJECT, msName);
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} ms-detail issue`);
      testIssueIds.push(issue.id);
      await client.setMilestone(issue.id, msName);
    });

    it('returns issues list with include_details', async () => {
      const ms = await client.getMilestone(PROJECT, msName, { include_details: true });
      assert.ok(ms.name === msName);
      assert.ok(Array.isArray(ms.issues), 'Should have issues array');
      assert.ok(ms.issues.length >= 1, 'Should have at least 1 issue');
      assert.ok(ms.issues[0].title, 'Issue should have title');
      assert.ok(ms.issues[0].status, 'Issue should have status');
    });

    it('omits issues by default', async () => {
      const ms = await client.getMilestone(PROJECT, msName);
      assert.equal(ms.issues, undefined);
    });

    after(async () => {
      try { await client.deleteMilestone(PROJECT, msName); } catch {}
    });
  });

  // ── update_label ──────────────────────────────────────────

  describe('update_label', () => {
    const labelName = `${TEST_PREFIX}-upd-label-${Date.now()}`;

    it('creates, updates color, and reads back', async () => {
      await client.createLabel(labelName, 3);
      const updated = await client.updateLabel(labelName, { color: 11 });
      assert.ok(updated.message.includes('updated') || updated.updated);
      const label = await client.getLabel(labelName);
      assert.equal(label.color, 11);
    });

    it('renames a label', async () => {
      const newName = labelName + '-renamed';
      await client.updateLabel(labelName, { newName });
      const label = await client.getLabel(newName);
      assert.equal(label.name, newName);
      await assert.rejects(() => client.getLabel(labelName), /not found/i);
    });
  });

  // ── Label color round-trip ─────────────────────────────────

  describe('Label color round-trip', () => {
    it('creates a label with palette index and reads back', async () => {
      await client.createLabel('ColorIdx5', 5);
      const label = await client.getLabel('ColorIdx5');
      assert.equal(label.color, 5);
    });

    it('creates a label with RGB hex and reads back', async () => {
      await client.createLabel('ColorRGB', 0xBB83FC);
      const label = await client.getLabel('ColorRGB');
      assert.equal(label.color, 0xBB83FC);
    });

    it('creates a label with named color and reads back', async () => {
      await client.createLabel('ColorNamed', 'blue');
      const label = await client.getLabel('ColorNamed');
      assert.equal(label.color, 9);
    });

    it('creates a label with no color and gets default', async () => {
      await client.createLabel('ColorDefault');
      const label = await client.getLabel('ColorDefault');
      assert.equal(label.color, 9);
    });
  });

  // ── Description format round-trip (markdown/html/plain) ───

  describe('Description format round-trip', () => {
    it('creates issue with markdown description and reads back', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} md desc`, 'This is **bold** and _italic_');
      testIssueIds.push(issue.id);
      const read = await client.getIssue(issue.id);
      assert.ok(read.description.includes('bold'), 'Should contain bold text');
    });

    it('creates issue with HTML description and reads back', async () => {
      const issue = await client.createIssue(
        PROJECT, `${TEST_PREFIX} html desc`,
        '<h2>HTML Test</h2><p>This is <strong>bold</strong> via HTML.</p>',
        null, null, null, null, { descriptionFormat: 'html' }
      );
      testIssueIds.push(issue.id);
      const read = await client.getIssue(issue.id);
      assert.ok(read.description.includes('bold') || read.description.includes('HTML Test'), 'Should contain HTML content');
    });

    it('creates issue with plain text description and reads back', async () => {
      const issue = await client.createIssue(
        PROJECT, `${TEST_PREFIX} plain desc`,
        'Just plain text, no formatting.',
        null, null, null, null, { descriptionFormat: 'plain' }
      );
      testIssueIds.push(issue.id);
      const read = await client.getIssue(issue.id);
      assert.ok(read.description.includes('plain text'), 'Should contain plain text');
    });

    it('updates description with markdown and reads back', async () => {
      const issue = await client.createIssue(PROJECT, `${TEST_PREFIX} update desc`);
      testIssueIds.push(issue.id);
      // updateIssue uses positional params: (id, title, description, priority, status, type, extra)
      await client.updateIssue(issue.id, undefined, 'Updated with **markdown**');
      const read = await client.getIssue(issue.id);
      assert.ok(read.description.includes('markdown'), 'Should contain updated markdown');
    });
  });

  // ── update_project ────────────────────────────────────────

  describe('update_project', () => {
    const projId = `TP${Date.now().toString(36).slice(-3).toUpperCase()}`;

    before(async () => {
      await client.createProject(projId, 'Update Test Project', 'Original desc', false, undefined, 'Classic project');
    });

    it('updates name and description', async () => {
      const result = await client.updateProject(projId, {
        name: 'Updated Project Name',
        description: 'Updated desc'
      });
      assert.ok(result.updated || result.message);
      const proj = await client.getProject(projId);
      assert.equal(proj.name, 'Updated Project Name');
    });

    after(async () => {
      try { await client.deleteProject(projId); } catch {}
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 2a-2. V2.0.2 AUDIT TESTS — error paths, concurrency, workflows
// ════════════════════════════════════════════════════════════════

describe('v2.0.2 Audit Tests', { timeout: 120_000 }, () => {
  let HulyClient, client;
  const AUDIT_PROJECT = `AUD${Date.now().toString(36).slice(-4).toUpperCase()}`;

  before(async () => {
    const mod = await import('../src/client.mjs');
    HulyClient = mod.HulyClient;
    client = new HulyClient({ url: HULY_URL, workspace: WORKSPACE, ...HULY_CREDS });
    await client.connect();
    await client.createProject(AUDIT_PROJECT, 'Audit Test Project', 'Automated audit tests', false, undefined, 'Classic project');
  });

  after(async () => {
    try { await client.deleteProject(AUDIT_PROJECT); } catch {}
    if (client) client.disconnect();
  });

  // ── Error path tests ──────────────────────────────────────

  describe('Error paths', () => {
    it('createIssue throws on invalid status name', async () => {
      await assert.rejects(
        () => client.createIssue(AUDIT_PROJECT, 'Test', '', 'medium', 'NonexistentStatus999'),
        (err) => {
          assert.ok(err.message.includes('not found'), `Expected "not found" in: ${err.message}`);
          assert.ok(err.message.includes('Available'), `Expected available statuses in: ${err.message}`);
          return true;
        }
      );
    });

    it('createIssue throws on invalid assignee name', async () => {
      await assert.rejects(
        () => client.createIssue(AUDIT_PROJECT, 'Test', '', 'medium', undefined, undefined, undefined, { assignee: 'NonexistentPerson999' }),
        (err) => {
          assert.ok(err.message.includes('not found'), `Expected "not found" in: ${err.message}`);
          return true;
        }
      );
    });

    it('createIssue throws on invalid project', async () => {
      await assert.rejects(
        () => client.createIssue('NONEXISTENT999', 'Test'),
        (err) => {
          assert.ok(err.message.includes('not found'), `Expected "not found" in: ${err.message}`);
          return true;
        }
      );
    });

    it('assignIssue does not substring-match employee names', async () => {
      // Create an issue first
      const issue = await client.createIssue(AUDIT_PROJECT, 'Assign test');
      // Get actual members to construct a partial name
      const members = await client.listMembers();
      if (members.length > 0) {
        const fullName = members[0].name;
        const partial = fullName.slice(0, 2); // First 2 chars — should NOT match
        if (partial !== fullName) {
          await assert.rejects(
            () => client.assignIssue(issue.id, partial),
            (err) => {
              assert.ok(err.message.includes('not found'), `Expected "not found" in: ${err.message}`);
              return true;
            }
          );
        }
      }
      await client.deleteIssue(issue.id);
    });
  });

  // ── getIssue completedAt ──────────────────────────────────

  describe('getIssue completedAt', () => {
    it('returns completedAt when issue is in done status', async () => {
      const issue = await client.createIssue(AUDIT_PROJECT, 'CompletedAt test');
      // Get available statuses and find a done one
      const statuses = await client.listStatuses(AUDIT_PROJECT);
      const doneStatus = statuses.find(s => s.category?.includes('Won'));
      if (doneStatus) {
        await client.updateIssue(issue.id, { status: doneStatus.name });
        const updated = await client.getIssue(issue.id);
        assert.ok(updated.completedAt, 'Expected completedAt to be set for done issue');
      }
      await client.deleteIssue(issue.id);
    });

    it('returns null completedAt for non-done issues', async () => {
      const issue = await client.createIssue(AUDIT_PROJECT, 'Not done test');
      const details = await client.getIssue(issue.id);
      assert.equal(details.completedAt, null, 'Expected completedAt to be null for non-done issue');
      await client.deleteIssue(issue.id);
    });
  });

  // ── include_details round-trip ────────────────────────────

  describe('include_details round-trip', () => {
    it('returns description, comments, timeReports via getIssue', async () => {
      const desc = 'This is a **test** description with markdown';
      const issue = await client.createIssue(AUDIT_PROJECT, 'Details test', desc);

      await client.addComment(issue.id, 'Test comment body');
      await client.logTime(issue.id, 1.5, 'Test time entry');

      const details = await client.getIssue(issue.id, { include_details: true });

      assert.ok(details.description, 'Expected non-empty description');
      assert.ok(details.description.includes('test'), `Description should contain "test": ${details.description}`);
      assert.ok(Array.isArray(details.comments), 'Expected comments array');
      assert.ok(details.comments.length >= 1, 'Expected at least 1 comment');
      assert.ok(details.comments[0].text.includes('Test comment'), 'Comment text should match');
      assert.ok(Array.isArray(details.timeReports), 'Expected timeReports array');
      assert.ok(details.timeReports.length >= 1, 'Expected at least 1 time report');

      await client.deleteIssue(issue.id);
    });
  });

  // ── Concurrent issue creation ─────────────────────────────

  describe('Concurrent issue creation', () => {
    it('creates issues with unique sequential numbers', async () => {
      const count = 5;
      const promises = Array(count).fill(null).map((_, i) =>
        client.createIssue(AUDIT_PROJECT, `Concurrent ${i}`)
      );
      const results = await Promise.all(promises);

      // All should succeed
      assert.equal(results.length, count, `Expected ${count} results`);

      // All should have unique IDs
      const ids = results.map(r => r.id);
      const uniqueIds = new Set(ids);
      assert.equal(uniqueIds.size, count, `Expected ${count} unique IDs, got: ${[...ids].join(', ')}`);

      // Clean up
      for (const r of results) {
        await client.deleteIssue(r.id);
      }
    });
  });

  // ── batchCreateIssues error reporting ─────────────────────

  describe('batchCreateIssues error reporting', () => {
    it('reports errors for issues with missing titles', async () => {
      const result = await client.batchCreateIssues(AUDIT_PROJECT, [
        { title: 'Valid issue' },
        { title: '' },  // invalid
        { description: 'no title' }  // missing title
      ]);
      assert.ok(result.created.length >= 1, 'Expected at least 1 created');
      assert.ok(result.errors.length >= 1, 'Expected at least 1 error');

      // Clean up created issues
      for (const c of result.created) {
        try { await client.deleteIssue(c.id); } catch {}
      }
    });
  });

  // ── Template graceful degradation ─────────────────────────

  describe('Template graceful degradation', () => {
    it('creates template issues even without custom task types', async () => {
      const result = await client.createIssuesFromTemplate(AUDIT_PROJECT, 'sprint', { title: 'Test Sprint' });
      assert.ok(result.created, 'Expected created array');
      assert.ok(result.created.length >= 3, `Expected at least 3 sprint issues, got ${result.created.length}`);

      // Clean up
      for (const c of result.created) {
        try { await client.deleteIssue(c.id); } catch {}
      }
    });
  });

  // ── Orphan reference resilience ──────────────────────────
  // Verifies list/get don't throw when referenced entities are deleted.
  // Huly's removeDoc does NOT cascade-clean references, so orphaned
  // attachedTo/component/milestone IDs are expected in production data.

  describe('Orphan parent: delete parent, list_issues still works', () => {
    let parentId, childId;

    before(async () => {
      const parent = await client.createIssue(AUDIT_PROJECT, 'Orphan parent', '');
      parentId = parent.id;
      const child = await client.createIssue(AUDIT_PROJECT, 'Orphan child', '');
      childId = child.id;
      await client.setParent(childId, parentId);
      // Verify parent is set
      const check = await client.getIssue(childId);
      assert.equal(check.parent, parentId, 'Parent should be set before delete');
      // Delete the parent — Huly does NOT cascade-clean attachedTo on children
      await client.deleteIssue(parentId);
    });

    after(async () => {
      try { await client.deleteIssue(childId); } catch {}
    });

    it('list_issues does not throw on orphaned parent', async () => {
      const issues = await client.listIssues(AUDIT_PROJECT);
      // Child may or may not survive parent deletion depending on Huly behavior
      // The key assertion: listIssues itself must not throw
      assert.ok(Array.isArray(issues), 'list_issues should return array');
    });

    it('get_issue does not throw on orphaned parent', async () => {
      try {
        const issue = await client.getIssue(childId);
        // If child survived, parent should be null
        assert.equal(issue.parent, null, 'Orphaned parent should be null');
      } catch (err) {
        // Child may have been cascade-deleted with parent
        assert.ok(err.message.includes('not found'), `Unexpected error: ${err.message}`);
      }
    });

    it('search_issues does not throw on orphaned parent', async () => {
      const issues = await client.searchIssues('Orphan child');
      assert.ok(Array.isArray(issues), 'Search should return array');
    });
  });

  describe('Orphan component: delete component, list_issues still works', () => {
    let issueId, componentName;

    before(async () => {
      componentName = `OrphanComp${Date.now().toString(36).slice(-4)}`;
      await client.createComponent(AUDIT_PROJECT, componentName);
      const issue = await client.createIssue(AUDIT_PROJECT, 'Issue with orphan component', '', 'medium', undefined, undefined, undefined, { component: componentName });
      issueId = issue.id;
      // Verify component is set
      const check = await client.getIssue(issueId);
      assert.ok(check.component, 'Component should be set before delete');
      // Delete the component
      await client.deleteComponent(AUDIT_PROJECT, componentName);
    });

    after(async () => {
      try { await client.deleteIssue(issueId); } catch {}
    });

    it('list_issues does not throw on orphaned component', async () => {
      const issues = await client.listIssues(AUDIT_PROJECT);
      const issue = issues.find(i => i.id === issueId);
      assert.ok(issue, 'Issue should be in list');
      assert.equal(issue.component, null, 'Orphaned component should be null');
    });

    it('get_issue does not throw on orphaned component', async () => {
      const issue = await client.getIssue(issueId);
      assert.equal(issue.component, null, 'Orphaned component should be null');
    });
  });

  describe('Orphan milestone: delete milestone, list_issues still works', () => {
    let issueId, milestoneName;

    before(async () => {
      milestoneName = `OrphanMS${Date.now().toString(36).slice(-4)}`;
      const ms = await client.createMilestone(AUDIT_PROJECT, milestoneName);
      const issue = await client.createIssue(AUDIT_PROJECT, 'Issue with orphan milestone', '');
      issueId = issue.id;
      await client.setMilestone(issueId, milestoneName);
      // Verify milestone is set
      const before = await client.getIssue(issueId);
      assert.ok(before.milestone, 'Milestone should be set before delete');
      // Delete the milestone
      await client.deleteMilestone(AUDIT_PROJECT, milestoneName);
    });

    after(async () => {
      try { await client.deleteIssue(issueId); } catch {}
    });

    it('list_issues does not throw on orphaned milestone', async () => {
      const issues = await client.listIssues(AUDIT_PROJECT);
      const issue = issues.find(i => i.id === issueId);
      assert.ok(issue, 'Issue should be in list');
      assert.equal(issue.milestone, null, 'Orphaned milestone should be null');
    });

    it('get_issue does not throw on orphaned milestone', async () => {
      const issue = await client.getIssue(issueId);
      assert.equal(issue.milestone, null, 'Orphaned milestone should be null');
    });
  });

  describe('Orphan relation: delete related issue, get_issue still works', () => {
    let issueId, relatedId;

    before(async () => {
      const issue = await client.createIssue(AUDIT_PROJECT, 'Issue with orphan relation', '');
      issueId = issue.id;
      const related = await client.createIssue(AUDIT_PROJECT, 'Related issue to delete', '');
      relatedId = related.id;
      await client.addRelation(issueId, relatedId);
      // Brief delay for relation to propagate
      await new Promise(r => setTimeout(r, 1000));
      // Delete the related issue
      await client.deleteIssue(relatedId);
    });

    after(async () => {
      try { await client.deleteIssue(issueId); } catch {}
    });

    it('get_issue with include_details does not throw on orphaned relation', async () => {
      const issue = await client.getIssue(issueId, true);
      // The key assertion: get_issue must not throw even if related issue was deleted
      assert.ok(issue, 'get_issue should return the issue');
      if (issue.relations) {
        assert.ok(Array.isArray(issue.relations), 'Relations should be an array');
      }
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 2b. ACCOUNT-LEVEL TESTS (workspace & account management)
// ════════════════════════════════════════════════════════════════

describe('Account-Level Tests', { timeout: 120_000 }, () => {
  let HulyClient;

  before(async () => {
    const mod = await import('../src/client.mjs');
    HulyClient = mod.HulyClient;
  });

  describe('list_workspaces', () => {
    it('returns all accessible workspaces', async () => {
      const workspaces = await HulyClient.listWorkspaces(HULY_URL, HULY_CREDS);
      assert.ok(Array.isArray(workspaces));
      assert.ok(workspaces.length >= 1, `Expected at least 1 workspace, got ${workspaces.length}`);

      const slugs = workspaces.map(w => w.slug);
      assert.ok(slugs.includes(WORKSPACE), `Should include ${WORKSPACE} workspace`);

      for (const ws of workspaces) {
        assert.ok(typeof ws.slug === 'string');
        assert.ok(typeof ws.name === 'string');
        assert.ok(typeof ws.mode === 'string');
      }
    });
  });

  describe('get_workspace_info', () => {
    it('returns info for test workspace', async () => {
      const info = await HulyClient.getWorkspaceInfo(HULY_URL, HULY_CREDS, WORKSPACE);
      assert.equal(info.slug, WORKSPACE);
      assert.equal(info.mode, 'active');
      assert.ok(info.uuid, 'Should have a UUID');
      assert.ok(info.version, 'Should have a version');
    });

    it('throws for nonexistent workspace', async () => {
      await assert.rejects(
        () => HulyClient.getWorkspaceInfo(HULY_URL, HULY_CREDS, 'nonexistent999'),
        /not found|Failed/i
      );
    });
  });

  describe('get_workspace_members', () => {
    it('returns members for test workspace', async () => {
      const members = await HulyClient.getWorkspaceMembers(HULY_URL, HULY_CREDS, WORKSPACE);
      assert.ok(Array.isArray(members));
      assert.ok(members.length >= 1, 'Should have at least one member');
      const owner = members.find(m => m.role === 'OWNER');
      assert.ok(owner, 'Should have an OWNER');
    });
  });

  describe('get_account_info', () => {
    it('returns account info', async () => {
      const info = await HulyClient.getAccountInfo(HULY_URL, HULY_CREDS);
      assert.ok(info, 'Should return account info');
      assert.ok(typeof info === 'object');
    });
  });

  describe('get_user_profile', () => {
    it('returns user profile', async () => {
      const profile = await HulyClient.getUserProfile(HULY_URL, HULY_CREDS);
      assert.ok(profile, 'Should return a profile');
      assert.ok(profile.uuid || profile.firstName, 'Should have identifying info');
    });
  });

  describe('get_social_ids', () => {
    it('returns social IDs for the current user', async () => {
      const ids = await HulyClient.getSocialIds(HULY_URL, HULY_CREDS);
      assert.ok(Array.isArray(ids));
      assert.ok(ids.length >= 1, 'Should have at least one social ID');
      const email = ids.find(id => id.type === 'email');
      assert.ok(email, 'Should have an email social ID');
    });
  });

  describe('list_mailboxes', () => {
    it('returns mailboxes array', async () => {
      const mailboxes = await HulyClient.getMailboxes(HULY_URL, HULY_CREDS);
      assert.ok(Array.isArray(mailboxes));
    });
  });

  describe('list_integrations', () => {
    it('returns integrations array', async () => {
      const integrations = await HulyClient.listIntegrations(HULY_URL, HULY_CREDS);
      assert.ok(Array.isArray(integrations));
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 3. MOCK TESTS (destructive/external methods)
// ════════════════════════════════════════════════════════════════

describe('Mock Tests (destructive methods)', { timeout: 30_000 }, () => {
  let HulyClient;
  let originalGetAuthClient;
  let originalGetWsAuthClient;

  before(async () => {
    const mod = await import('../src/client.mjs');
    HulyClient = mod.HulyClient;
    originalGetAuthClient = HulyClient._getAuthClient;
    originalGetWsAuthClient = HulyClient._getWorkspaceAuthClient;
  });

  afterEach(() => {
    // Restore originals after each test
    HulyClient._getAuthClient = originalGetAuthClient;
    HulyClient._getWorkspaceAuthClient = originalGetWsAuthClient;
  });

  /**
   * Create a mock auth client that records calls.
   */
  function createMockAuthClient(methodOverrides = {}) {
    const calls = [];
    const mockClient = new Proxy({}, {
      get(target, prop) {
        if (prop in methodOverrides) {
          return (...args) => {
            calls.push({ method: prop, args });
            return methodOverrides[prop](...args);
          };
        }
        return (...args) => {
          calls.push({ method: prop, args });
          return Promise.resolve({});
        };
      }
    });
    return { mockClient, calls };
  }

  function mockAuthClient(methodOverrides = {}) {
    const { mockClient, calls } = createMockAuthClient(methodOverrides);
    HulyClient._getAuthClient = async () => ({
      authClient: mockClient,
      token: 'mock-token',
      accountId: 'mock-account-id',
      accountsUrl: 'https://mock.example.com'
    });
    return { mockClient, calls };
  }

  function mockWsAuthClient(methodOverrides = {}) {
    const { mockClient, calls } = createMockAuthClient(methodOverrides);
    HulyClient._getWorkspaceAuthClient = async () => ({
      wsClient: mockClient,
      wsInfo: { token: 'mock-ws-token', workspace: 'mock-ws-uuid' }
    });
    return { mockClient, calls };
  }

  // ── deleteWorkspace ──────────────────────────────────────

  describe('deleteWorkspace', () => {
    it('calls deleteWorkspace on workspace-scoped client', async () => {
      const { calls } = mockWsAuthClient({
        deleteWorkspace: async () => ({})
      });

      const result = await HulyClient.deleteWorkspace('https://mock', { email: 'e', password: 'p' }, 'test-ws');
      assert.ok(result.message.includes('test-ws'));

      const deleteCall = calls.find(c => c.method === 'deleteWorkspace');
      assert.ok(deleteCall, 'Should have called deleteWorkspace');
    });
  });

  // ── createWorkspace ──────────────────────────────────────

  describe('createWorkspace', () => {
    it('calls createWorkspace with the name', async () => {
      const { calls } = mockAuthClient({
        createWorkspace: async (name) => ({ url: 'new-ws', workspace: 'new-ws', uuid: 'new-uuid' })
      });

      const result = await HulyClient.createWorkspace('https://mock', { email: 'e', password: 'p' }, 'New Workspace');
      assert.ok(result.message.includes('New Workspace'));

      const createCall = calls.find(c => c.method === 'createWorkspace');
      assert.ok(createCall);
      assert.equal(createCall.args[0], 'New Workspace');
    });
  });

  // ── updateWorkspaceName ──────────────────────────────────

  describe('updateWorkspaceName', () => {
    it('resolves UUID and calls updateWorkspaceName', async () => {
      const { calls } = mockAuthClient({
        getUserWorkspaces: async () => [
          { url: 'my-ws', name: 'Old Name', uuid: 'ws-uuid-456' }
        ],
        updateWorkspaceName: async () => ({})
      });

      const result = await HulyClient.updateWorkspaceName('https://mock', { email: 'e', password: 'p' }, 'my-ws', 'New Name');
      assert.ok(result.message.includes('New Name'));

      const updateCall = calls.find(c => c.method === 'updateWorkspaceName');
      assert.ok(updateCall);
      assert.equal(updateCall.args[0], 'ws-uuid-456');
      assert.equal(updateCall.args[1], 'New Name');
    });
  });

  // ── updateWorkspaceRole ──────────────────────────────────

  describe('updateWorkspaceRole', () => {
    it('calls updateWorkspaceRole with email and role', async () => {
      const { calls } = mockWsAuthClient({
        updateWorkspaceRole: async () => ({})
      });

      const result = await HulyClient.updateWorkspaceRole('https://mock', { email: 'e', password: 'p' }, 'ws', 'user@test.com', 'MAINTAINER');
      assert.ok(result.message.includes('MAINTAINER'));

      const updateCall = calls.find(c => c.method === 'updateWorkspaceRole');
      assert.ok(updateCall);
      assert.equal(updateCall.args[0], 'user@test.com');
      assert.equal(updateCall.args[1], 'MAINTAINER');
    });
  });

  // ── changePassword ───────────────────────────────────────

  describe('changePassword', () => {
    it('calls changePassword with old and new password', async () => {
      const { calls } = mockAuthClient({
        changePassword: async () => ({})
      });

      const result = await HulyClient.changePassword('https://mock', { email: 'e', password: 'oldpass' }, 'newpass');
      assert.ok(result.message.includes('changed'));

      const changeCall = calls.find(c => c.method === 'changePassword');
      assert.ok(changeCall);
      assert.equal(changeCall.args[0], 'oldpass');
      assert.equal(changeCall.args[1], 'newpass');
    });
  });

  // ── changeUsername ───────────────────────────────────────

  describe('changeUsername', () => {
    it('calls changeUsername with new name', async () => {
      const { calls } = mockAuthClient({
        changeUsername: async () => ({})
      });

      const result = await HulyClient.changeUsername('https://mock', { email: 'e', password: 'p' }, 'NewUser');
      assert.ok(result.message.includes('NewUser'));

      const changeCall = calls.find(c => c.method === 'changeUsername');
      assert.ok(changeCall);
      assert.equal(changeCall.args[0], 'NewUser');
    });
  });

  // ── setMyProfile ─────────────────────────────────────────

  describe('setMyProfile', () => {
    it('calls setMyProfile with only provided fields', async () => {
      const { calls } = mockAuthClient({
        setMyProfile: async () => ({})
      });

      const result = await HulyClient.setMyProfile('https://mock', { email: 'e', password: 'p' }, 'Test Name', 'NYC', undefined);
      assert.ok(result.updated.includes('name'));
      assert.ok(result.updated.includes('city'));
      assert.ok(!result.updated.includes('country'));

      const setCall = calls.find(c => c.method === 'setMyProfile');
      assert.ok(setCall);
      assert.deepEqual(setCall.args[0], { name: 'Test Name', city: 'NYC' });
    });
  });

  // ── sendInvite ───────────────────────────────────────────

  describe('sendInvite', () => {
    it('resolves workspace UUID and sends invite', async () => {
      const { calls } = mockAuthClient({
        getUserWorkspaces: async () => [
          { url: 'team-ws', name: 'Team', uuid: 'team-uuid' }
        ],
        sendInvite: async () => ({})
      });

      const result = await HulyClient.sendInvite('https://mock', { email: 'e', password: 'p' }, 'team-ws', 'new@test.com', 'MEMBER');
      assert.ok(result.message.includes('new@test.com'));

      const inviteCall = calls.find(c => c.method === 'sendInvite');
      assert.ok(inviteCall);
      assert.equal(inviteCall.args[0], 'team-uuid');
      assert.equal(inviteCall.args[1], 'new@test.com');
      assert.equal(inviteCall.args[2], 'MEMBER');
    });
  });

  // ── resendInvite ─────────────────────────────────────────

  describe('resendInvite', () => {
    it('resolves workspace UUID and resends invite', async () => {
      const { calls } = mockAuthClient({
        getUserWorkspaces: async () => [
          { url: 'team-ws', name: 'Team', uuid: 'team-uuid' }
        ],
        resendInvite: async () => ({})
      });

      const result = await HulyClient.resendInvite('https://mock', { email: 'e', password: 'p' }, 'team-ws', 'user@test.com');
      assert.ok(result.message.includes('user@test.com'));

      const resendCall = calls.find(c => c.method === 'resendInvite');
      assert.ok(resendCall);
      assert.equal(resendCall.args[0], 'team-uuid');
      assert.equal(resendCall.args[1], 'user@test.com');
    });
  });

  // ── createInviteLink ─────────────────────────────────────

  describe('createInviteLink', () => {
    it('resolves workspace UUID and creates link', async () => {
      const { calls } = mockAuthClient({
        getUserWorkspaces: async () => [
          { url: 'team-ws', name: 'Team', uuid: 'team-uuid' }
        ],
        createInviteLink: async () => 'https://example.com/invite/abc123'
      });

      const result = await HulyClient.createInviteLink('https://mock', { email: 'e', password: 'p' }, 'team-ws', 'GUEST', 24);
      assert.equal(result.link, 'https://example.com/invite/abc123');
      assert.equal(result.role, 'GUEST');

      const linkCall = calls.find(c => c.method === 'createInviteLink');
      assert.ok(linkCall);
      assert.equal(linkCall.args[0], 'team-uuid');
      assert.equal(linkCall.args[1], 'GUEST');
      assert.equal(linkCall.args[2], 24);
    });
  });

  // ── Integration CRUD (create + get + update + delete) ────

  describe('createIntegration / getIntegration / updateIntegration / deleteIntegration', () => {
    it('creates an integration', async () => {
      const { calls } = mockAuthClient({
        createIntegration: async (data) => ({ id: 'int-1', ...data })
      });

      const result = await HulyClient.createIntegration('https://mock', { email: 'e', password: 'p' }, { name: 'test' });
      assert.ok(result);
      const call = calls.find(c => c.method === 'createIntegration');
      assert.deepEqual(call.args[0], { name: 'test' });
    });

    it('gets an integration', async () => {
      const { calls } = mockAuthClient({
        getIntegration: async (id) => ({ id, name: 'test' })
      });

      const result = await HulyClient.getIntegration('https://mock', { email: 'e', password: 'p' }, 'int-1');
      assert.equal(result.id, 'int-1');
    });

    it('updates an integration', async () => {
      const { calls } = mockAuthClient({
        updateIntegration: async (id, data) => ({ id, ...data })
      });

      const result = await HulyClient.updateIntegration('https://mock', { email: 'e', password: 'p' }, 'int-1', { name: 'updated' });
      assert.ok(result);
      const call = calls.find(c => c.method === 'updateIntegration');
      assert.equal(call.args[0], 'int-1');
      assert.deepEqual(call.args[1], { name: 'updated' });
    });

    it('deletes an integration', async () => {
      const { calls } = mockAuthClient({
        deleteIntegration: async () => ({})
      });

      const result = await HulyClient.deleteIntegration('https://mock', { email: 'e', password: 'p' }, 'int-1');
      assert.ok(result.message.includes('int-1'));
      const call = calls.find(c => c.method === 'deleteIntegration');
      assert.equal(call.args[0], 'int-1');
    });
  });

  // ── Mailbox CRUD ─────────────────────────────────────────

  describe('createMailbox / deleteMailbox', () => {
    it('creates a mailbox', async () => {
      const { calls } = mockAuthClient({
        createMailbox: async (data) => ({ id: 'mb-1', ...data })
      });

      const result = await HulyClient.createMailbox('https://mock', { email: 'e', password: 'p' }, { address: 'test@mail.com' });
      assert.ok(result);
      const call = calls.find(c => c.method === 'createMailbox');
      assert.deepEqual(call.args[0], { address: 'test@mail.com' });
    });

    it('deletes a mailbox', async () => {
      const { calls } = mockAuthClient({
        deleteMailbox: async () => ({})
      });

      const result = await HulyClient.deleteMailbox('https://mock', { email: 'e', password: 'p' }, 'mb-1');
      assert.ok(result.message.includes('mb-1'));
    });
  });

  // ── Person / Social ID ──────────────────────────────────

  describe('findPersonBySocialKey', () => {
    it('calls findPersonBySocialKey with the key', async () => {
      const { calls } = mockAuthClient({
        findPersonBySocialKey: async (key) => ({ uuid: 'person-1', key })
      });

      const result = await HulyClient.findPersonBySocialKey('https://mock', { email: 'e', password: 'p' }, 'email:user@test.com');
      assert.equal(result.key, 'email:user@test.com');
    });
  });

  describe('addEmailSocialId', () => {
    it('calls addEmailSocialId with the email', async () => {
      const { calls } = mockAuthClient({
        addEmailSocialId: async (email) => ({ type: 'email', value: email })
      });

      const result = await HulyClient.addEmailSocialId('https://mock', { email: 'e', password: 'p' }, 'new@test.com');
      assert.equal(result.value, 'new@test.com');
    });
  });

  // ── Subscriptions ────────────────────────────────────────

  describe('getSubscriptions', () => {
    it('calls getSubscriptions', async () => {
      const { calls } = mockAuthClient({
        getSubscriptions: async () => [{ id: 'sub-1', status: 'active' }]
      });

      const result = await HulyClient.getSubscriptions('https://mock', { email: 'e', password: 'p' });
      assert.ok(Array.isArray(result));
      assert.equal(result[0].id, 'sub-1');
    });
  });

  // ── Token Auth ──────────────────────────────────────────

  describe('Token auth', () => {
    it('static methods work with { token } creds', async () => {
      const { calls } = mockAuthClient({
        getUserWorkspaces: async () => [
          { url: 'ws-1', name: 'Workspace 1', mode: 'active', createdOn: Date.now() }
        ]
      });

      const result = await HulyClient.listWorkspaces('https://mock', { token: 'my-token' });
      assert.ok(Array.isArray(result));
      assert.equal(result[0].slug, 'ws-1');
    });

    it('deleteWorkspace works with token creds', async () => {
      const { calls } = mockWsAuthClient({
        deleteWorkspace: async () => ({})
      });

      const result = await HulyClient.deleteWorkspace('https://mock', { token: 'my-token' }, 'ws-1');
      assert.ok(result.message.includes('ws-1'));
      const call = calls.find(c => c.method === 'deleteWorkspace');
      assert.ok(call, 'Should have called deleteWorkspace');
    });

    it('changePassword rejects with token auth', async () => {
      mockAuthClient({
        changePassword: async () => ({})
      });

      await assert.rejects(
        () => HulyClient.changePassword('https://mock', { token: 'my-token' }, 'newpass'),
        /requires email\/password auth/i
      );
    });

    it('constructor accepts token option', () => {
      const client = new HulyClient({
        url: 'https://mock',
        token: 'my-token',
        workspace: 'ws-1'
      });
      assert.equal(client.token, 'my-token');
      assert.equal(client.email, null);
      assert.equal(client.password, null);
    });

    it('connect rejects with no token and no email/password', async () => {
      const client = new HulyClient({
        url: 'https://mock',
        workspace: 'ws-1'
      });

      await assert.rejects(
        () => client.connect(),
        /Missing required auth/i
      );
    });

    it('connect rejects with no workspace', async () => {
      const client = new HulyClient({
        url: 'https://mock',
        token: 'my-token'
      });

      await assert.rejects(
        () => client.connect(),
        /Missing required config: workspace/i
      );
    });
  });
});

// ════════════════════════════════════════════════════════════════
// 4. HTTP SERVER TESTS (start server, hit endpoints)
// ════════════════════════════════════════════════════════════════

describe('HTTP Server Tests', { timeout: 120_000 }, () => {
  let server;
  let baseUrl;
  let port;
  const httpTestIssueIds = [];

  /**
   * Make an HTTP request and return { status, headers, body }.
   */
  async function request(method, path, body, headers = {}) {
    const url = `${baseUrl}${path}`;
    const opts = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers
      }
    };
    if (body) {
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body: json
    };
  }

  before(async () => {
    // Pick a random high port
    port = 30000 + Math.floor(Math.random() * 20000);
    baseUrl = `http://127.0.0.1:${port}`;

    // We need to start the server in a child process to isolate its module scope
    const { spawn } = await import('child_process');

    await new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        PORT: String(port),
        HULY_URL,
        HULY_WORKSPACE: WORKSPACE,
        MCP_AUTH_TOKEN: '',  // No token auth for main tests
      };
      // Remove MCP_AUTH_TOKEN to disable auth
      delete env.MCP_AUTH_TOKEN;

      server = spawn('node', ['src/server.mjs'], {
        cwd: '/Users/bgx4k3p/Developer/huly-mcp-server',
        env,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      let started = false;

      server.stderr.on('data', (data) => {
        const msg = data.toString();
        if (!started && msg.includes('listening')) {
          started = true;
          resolve();
        }
      });

      server.on('error', reject);
      server.on('exit', (code) => {
        if (!started) reject(new Error(`Server exited with code ${code}`));
      });

      // Timeout: if server doesn't start in 30s, fail
      setTimeout(() => {
        if (!started) reject(new Error('Server start timeout'));
      }, 30000);
    });

    // Create test project via the HTTP API
    const createRes = await request('POST', '/api/projects', {
      identifier: PROJECT,
      name: 'MCP Test Project',
      description: 'Automated HTTP test project'
    });
    // 200 = created, or it already exists from integration tests
    if (createRes.status !== 200 && createRes.status !== 201) {
      // If it errors with "already exists", that's fine
      if (!JSON.stringify(createRes.body).includes('already exists')) {
        throw new Error(`Failed to create test project: ${JSON.stringify(createRes.body)}`);
      }
    }
  });

  after(async () => {
    // Delete test project (cleans up all test data)
    try {
      await request('DELETE', `/api/projects/${PROJECT}`);
    } catch {
      // best effort
    }

    if (server) {
      server.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 1000));
      if (!server.killed) server.kill('SIGKILL');
    }
  });

  // ── Health check ────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const res = await request('GET', '/health');
      assert.equal(res.status, 200);
      assert.equal(res.body.status, 'ok');
      assert.ok(res.body.timestamp, 'Should include a timestamp');
    });
  });

  // ── OpenAPI spec ────────────────────────────────────────────

  describe('GET /api/openapi.json', () => {
    it('returns the OpenAPI spec', async () => {
      const res = await request('GET', '/api/openapi.json');
      assert.equal(res.status, 200);
      assert.equal(res.body.openapi, '3.0.3');
      assert.ok(res.body.paths, 'Should have paths');
      assert.ok(res.body.paths['/health'], 'Should have /health path');
      assert.ok(res.body.paths['/api/projects'], 'Should have /api/projects path');
    });
  });

  // ── Auth rejection ──────────────────────────────────────────

  describe('Auth rejection', () => {
    it('rejects requests when MCP_AUTH_TOKEN is set and no token provided', async () => {
      // Start a second server with auth enabled on a different port
      const { spawn } = await import('child_process');
      const authPort = port + 1;
      const authBaseUrl = `http://127.0.0.1:${authPort}`;

      const authServer = spawn('node', ['src/server.mjs'], {
        cwd: '/Users/bgx4k3p/Developer/huly-mcp-server',
        env: {
          ...process.env,
          PORT: String(authPort),
          HULY_URL,
          HULY_WORKSPACE: WORKSPACE,
          MCP_AUTH_TOKEN: 'test-secret-token-12345',
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });

      // Wait for startup
      await new Promise((resolve, reject) => {
        let started = false;
        authServer.stderr.on('data', (data) => {
          if (!started && data.toString().includes('listening')) {
            started = true;
            resolve();
          }
        });
        authServer.on('error', reject);
        setTimeout(() => { if (!started) reject(new Error('Auth server timeout')); }, 15000);
      });

      try {
        // Request without token
        const noAuthRes = await fetch(`${authBaseUrl}/api/projects`);
        assert.equal(noAuthRes.status, 401);

        // Request with wrong token
        const wrongRes = await fetch(`${authBaseUrl}/api/projects`, {
          headers: { 'Authorization': 'Bearer wrong-token' }
        });
        assert.equal(wrongRes.status, 401);

        // Request with correct token
        const goodRes = await fetch(`${authBaseUrl}/api/projects`, {
          headers: { 'Authorization': 'Bearer test-secret-token-12345' }
        });
        assert.equal(goodRes.status, 200);

        // Health check should work without auth
        const healthRes = await fetch(`${authBaseUrl}/health`);
        assert.equal(healthRes.status, 200);
      } finally {
        authServer.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!authServer.killed) authServer.kill('SIGKILL');
      }
    });
  });

  // ── Rate limit headers ──────────────────────────────────────

  describe('Rate limit headers', () => {
    it('includes rate limit headers in response', async () => {
      const res = await request('GET', '/api/projects');
      assert.ok(res.headers['x-ratelimit-limit'], 'Should have X-RateLimit-Limit header');
      assert.ok(res.headers['x-ratelimit-remaining'] !== undefined, 'Should have X-RateLimit-Remaining');
      assert.ok(res.headers['x-ratelimit-reset'], 'Should have X-RateLimit-Reset header');
    });
  });

  // ── GET /api/projects ───────────────────────────────────────

  describe('GET /api/projects', () => {
    it('returns projects array including OPS', async () => {
      const res = await request('GET', '/api/projects');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      const ops = res.body.find(p => p.identifier === PROJECT);
      assert.ok(ops, `Should find ${PROJECT}`);
    });
  });

  // ── GET /api/projects/MCPT/summary ───────────────────────────

  describe('GET /api/projects/MCPT/summary', () => {
    it('returns project summary', async () => {
      const res = await request('GET', `/api/projects/${PROJECT}/summary`);
      assert.equal(res.status, 200);
      assert.ok(res.body, 'Should return a body');
      assert.ok(
        typeof res.body.totalIssues === 'number' || typeof res.body.total === 'number',
        'Should have a total issue count'
      );
    });
  });

  // ── Account-level HTTP routes ───────────────────────────────

  describe('GET /api/workspaces', () => {
    it('returns workspaces array', async () => {
      const res = await request('GET', '/api/workspaces');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 3);
      const slugs = res.body.map(w => w.slug);
      assert.ok(slugs.includes(WORKSPACE));
    });
  });

  describe('GET /api/profile', () => {
    it('returns user profile', async () => {
      const res = await request('GET', '/api/profile');
      assert.equal(res.status, 200);
      assert.ok(res.body.uuid || res.body.firstName);
    });
  });

  describe('GET /api/social-ids', () => {
    it('returns social IDs', async () => {
      const res = await request('GET', '/api/social-ids');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  // ── POST create + GET retrieve issue via REST ───────────────

  describe('Create and retrieve issue via REST', () => {
    let createdIssueNumber;

    it('POST creates a new issue', async () => {
      const res = await request('POST', `/api/projects/${PROJECT}/issues`, {
        title: `${TEST_PREFIX} HTTP server test issue`,
        description: 'Created via HTTP server integration test.',
        priority: 'low'
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.id, 'Should return issue id');
      assert.ok(res.body.id.startsWith(`${PROJECT}-`));

      createdIssueNumber = res.body.id.split('-')[1];
      httpTestIssueIds.push(res.body.id);
    });

    it('GET retrieves the created issue', async () => {
      assert.ok(createdIssueNumber, 'Issue must have been created');
      const res = await request('GET', `/api/projects/${PROJECT}/issues/${createdIssueNumber}`);
      assert.equal(res.status, 200);
      assert.ok(res.body.title.includes(TEST_PREFIX));
    });
  });

  // ── Account-level HTTP routes ──────────────────────────────

  describe('GET /api/account', () => {
    it('returns account info', async () => {
      const res = await request('GET', '/api/account');
      assert.equal(res.status, 200);
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('GET /api/mailboxes', () => {
    it('returns mailboxes array', async () => {
      const res = await request('GET', '/api/mailboxes');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('GET /api/integrations', () => {
    it('returns integrations array', async () => {
      const res = await request('GET', '/api/integrations');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('GET /api/subscriptions', () => {
    it('returns subscriptions or error', async () => {
      const res = await request('GET', '/api/subscriptions');
      // May fail on self-hosted (no billing), accept 200 or 500
      assert.ok([200, 500].includes(res.status));
    });
  });

  describe('GET /api/workspaces/:slug/info', () => {
    it('returns workspace info', async () => {
      const res = await request('GET', `/api/workspaces/${WORKSPACE}/info`);
      assert.equal(res.status, 200);
      assert.equal(res.body.slug, WORKSPACE);
      assert.equal(res.body.mode, 'active');
    });
  });

  describe('GET /api/workspaces/:slug/members', () => {
    it('returns members for test workspace', async () => {
      const res = await request('GET', `/api/workspaces/${WORKSPACE}/members`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length >= 1);
    });
  });

  // ── Workspace-level routes ─────────────────────────────────

  describe('GET /api/projects/:identifier', () => {
    it('returns OPS project details', async () => {
      const res = await request('GET', '/api/projects/OPS');
      assert.equal(res.status, 200);
      assert.equal(res.body.identifier, 'OPS');
    });
  });

  describe('GET /api/projects/MCPT/issues (with filters)', () => {
    it('returns issues with limit', async () => {
      const res = await request('GET', '/api/projects/MCPT/issues?limit=5');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length <= 5);
    });
  });

  describe('PATCH /api/issues/:issueId', () => {
    it('updates an issue', async () => {
      // Use the issue created in the earlier REST test
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('PATCH', `/api/issues/${issueId}`, {
        title: `${TEST_PREFIX} HTTP updated issue`
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.updated || res.body.id);
    });
  });

  describe('GET /api/statuses', () => {
    it('returns statuses array', async () => {
      const res = await request('GET', '/api/statuses');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0);
    });
  });

  describe('GET /api/members', () => {
    it('returns members array', async () => {
      const res = await request('GET', '/api/members');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0);
    });
  });

  describe('GET /api/labels', () => {
    it('returns labels array', async () => {
      const res = await request('GET', '/api/labels');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('POST /api/labels', () => {
    it('creates a label', async () => {
      const res = await request('POST', '/api/labels', {
        name: `${TEST_PREFIX}-http-label-${Date.now()}`
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.id || res.body.message);
    });
  });

  describe('GET /api/projects/MCPT/task-types', () => {
    it('returns task types', async () => {
      const res = await request('GET', '/api/projects/MCPT/task-types');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
      assert.ok(res.body.length > 0);
    });
  });

  describe('GET /api/projects/MCPT/milestones', () => {
    it('returns milestones array', async () => {
      const res = await request('GET', '/api/projects/MCPT/milestones');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('GET /api/search', () => {
    it('searches issues by query', async () => {
      const res = await request('GET', '/api/search?query=test&limit=5');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });

    it('returns 400 without query param', async () => {
      const res = await request('GET', '/api/search');
      assert.equal(res.status, 400);
    });
  });

  describe('GET /api/my-issues', () => {
    it('returns issues assigned to current user', async () => {
      const res = await request('GET', '/api/my-issues');
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  describe('Issue labels via REST', () => {
    it('adds and removes a label on an issue', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];

      // Add label
      const addRes = await request('POST', `/api/issues/${issueId}/labels`, {
        label: 'http-test-label'
      });
      assert.equal(addRes.status, 200);

      // Remove label
      const removeRes = await request('DELETE', `/api/issues/${issueId}/labels/http-test-label`);
      assert.equal(removeRes.status, 200);
    });
  });

  describe('Issue comments via REST', () => {
    it('adds and lists comments', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];

      // Add comment
      const addRes = await request('POST', `/api/issues/${issueId}/comments`, {
        text: 'HTTP test comment'
      });
      assert.equal(addRes.status, 201);

      // List comments
      const listRes = await request('GET', `/api/issues/${issueId}/comments`);
      assert.equal(listRes.status, 200);
      assert.ok(Array.isArray(listRes.body));
      assert.ok(listRes.body.length >= 1);
    });
  });

  describe('Issue due date via REST', () => {
    it('sets a due date', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('PATCH', `/api/issues/${issueId}/due-date`, {
        dueDate: '2026-12-31'
      });
      assert.equal(res.status, 200);
    });
  });

  describe('Issue estimation via REST', () => {
    it('sets estimation', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('PATCH', `/api/issues/${issueId}/estimation`, {
        hours: 8
      });
      assert.equal(res.status, 200);
    });
  });

  describe('Issue time logs via REST', () => {
    it('logs time', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('POST', `/api/issues/${issueId}/time-logs`, {
        hours: 2,
        description: 'HTTP test time log'
      });
      assert.equal(res.status, 201);
    });
  });

  describe('Issue assignee via REST', () => {
    it('assigns and unassigns', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];

      // Get a member name
      const membersRes = await request('GET', '/api/members');
      if (membersRes.body.length === 0) return;
      const memberName = membersRes.body[0].name;

      // Assign
      const assignRes = await request('PATCH', `/api/issues/${issueId}/assignee`, {
        assignee: memberName
      });
      assert.equal(assignRes.status, 200);

      // Unassign
      const unassignRes = await request('PATCH', `/api/issues/${issueId}/assignee`, {
        assignee: ''
      });
      assert.equal(unassignRes.status, 200);
    });
  });

  describe('Issue relations via REST', () => {
    let secondIssueId;

    before(async () => {
      const res = await request('POST', '/api/projects/MCPT/issues', {
        title: `${TEST_PREFIX} HTTP relation target`
      });
      secondIssueId = res.body.id;
      httpTestIssueIds.push(secondIssueId);
    });

    it('adds a relation', async () => {
      if (httpTestIssueIds.length < 2) return;
      const res = await request('POST', `/api/issues/${httpTestIssueIds[0]}/relations`, {
        relatedToIssueId: secondIssueId
      });
      assert.equal(res.status, 200);
    });

    it('adds a blocked-by', async () => {
      if (httpTestIssueIds.length < 2) return;
      const res = await request('POST', `/api/issues/${httpTestIssueIds[0]}/blocked-by`, {
        blockedByIssueId: secondIssueId
      });
      assert.equal(res.status, 200);
    });

    it('sets parent', async () => {
      if (httpTestIssueIds.length < 2) return;
      const res = await request('POST', `/api/issues/${secondIssueId}/parent`, {
        parentIssueId: httpTestIssueIds[0]
      });
      assert.equal(res.status, 200);
    });
  });

  describe('Issue history via REST', () => {
    it('returns issue history', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('GET', `/api/issues/${issueId}/history`);
      assert.equal(res.status, 200);
      assert.ok(typeof res.body === 'object');
    });
  });

  describe('Issue move via REST', () => {
    it('move to same project returns already message', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('POST', `/api/issues/${issueId}/move`, {
        targetProject: PROJECT
      });
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('already'));
    });
  });

  describe('Batch create issues via REST', () => {
    it('creates multiple issues', async () => {
      const res = await request('POST', '/api/projects/MCPT/batch-issues', {
        issues: [
          { title: `${TEST_PREFIX} HTTP batch 1` },
          { title: `${TEST_PREFIX} HTTP batch 2` }
        ]
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.total >= 2 || (res.body.created && res.body.created.length >= 2));

      // Collect for cleanup
      const created = res.body.created || [];
      for (const item of created) {
        if (item.id) httpTestIssueIds.push(item.id);
      }
    });
  });

  describe('Create from template via REST', () => {
    it('creates issues from sprint template', async () => {
      const res = await request('POST', '/api/projects/MCPT/template', {
        template: 'sprint',
        title: `${TEST_PREFIX} HTTP Sprint`
      });
      assert.equal(res.status, 201);
      assert.ok(res.body.total >= 1 || (res.body.created && res.body.created.length >= 1));

      // Collect for cleanup
      const created = res.body.created || [];
      for (const item of created) {
        if (item.id) httpTestIssueIds.push(item.id);
      }
    });
  });

  describe('Milestone via REST', () => {
    const msName = `${TEST_PREFIX}-http-ms-${Date.now()}`;

    it('creates a milestone', async () => {
      const res = await request('POST', '/api/projects/MCPT/milestones', {
        name: msName,
        description: 'HTTP test milestone'
      });
      assert.equal(res.status, 201);
    });

    it('gets the milestone', async () => {
      const res = await request('GET', `/api/projects/MCPT/milestones/${encodeURIComponent(msName)}`);
      assert.equal(res.status, 200);
      assert.equal(res.body.name, msName);
    });

    it('sets milestone on an issue', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('PATCH', `/api/issues/${issueId}/milestone`, {
        milestone: msName
      });
      assert.equal(res.status, 200);
    });

    it('clears milestone from issue', async () => {
      if (httpTestIssueIds.length === 0) return;
      const issueId = httpTestIssueIds[0];
      const res = await request('PATCH', `/api/issues/${issueId}/milestone`, {
        milestone: ''
      });
      assert.equal(res.status, 200);
    });
  });

  describe('404 for unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const res = await request('GET', '/api/nonexistent');
      assert.equal(res.status, 404);
    });
  });

  describe('SSE endpoint', () => {
    it('connects to event stream', async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);

      try {
        const res = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
        assert.equal(res.status, 200);
        assert.equal(res.headers.get('content-type'), 'text/event-stream');
      } catch (e) {
        if (e.name !== 'AbortError') throw e;
      } finally {
        clearTimeout(timeout);
        controller.abort();
      }
    });
  });

  // ── Component listing via REST ───────────────────────────────

  describe('Component listing via REST', () => {
    it('lists components', async () => {
      const res = await request('GET', `/api/projects/${PROJECT}/components`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  // ── Time reports via REST ──────────────────────────────────

  describe('Time reports via REST', () => {
    it('lists time reports for an issue', async () => {
      if (httpTestIssueIds.length === 0) return;
      const res = await request('GET', `/api/issues/${httpTestIssueIds[0]}/time-reports`);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body));
    });
  });

  // ── Comment update/delete via REST ─────────────────────────

  describe('Comment update/delete via REST', () => {
    let commentIssueId;
    let commentId;

    it('creates issue and comment', async () => {
      const issueRes = await request('POST', `/api/projects/${PROJECT}/issues`, {
        title: `${TEST_PREFIX} HTTP comment ops`
      });
      commentIssueId = issueRes.body.id;
      httpTestIssueIds.push(commentIssueId);

      const commentRes = await request('POST', `/api/issues/${commentIssueId}/comments`, {
        text: 'Original'
      });
      assert.equal(commentRes.status, 201);
      commentId = commentRes.body.id;
    });

    it('updates a comment', async () => {
      if (!commentId) return;
      const res = await request('PATCH', `/api/issues/${commentIssueId}/comments/${commentId}`, {
        text: 'Updated via REST'
      });
      assert.equal(res.status, 200);
    });

    it('deletes a comment', async () => {
      if (!commentId) return;
      const res = await request('DELETE', `/api/issues/${commentIssueId}/comments/${commentId}`);
      assert.equal(res.status, 200);
    });
  });

  // ── Delete issue via REST ──────────────────────────────────

  describe('DELETE /api/issues/:issueId', () => {
    it('creates and deletes an issue', async () => {
      const createRes = await request('POST', `/api/projects/${PROJECT}/issues`, {
        title: `${TEST_PREFIX} HTTP delete me`
      });
      assert.equal(createRes.status, 201);
      const id = createRes.body.id;

      const deleteRes = await request('DELETE', `/api/issues/${id}`);
      assert.equal(deleteRes.status, 200);
      assert.ok(deleteRes.body.message.includes('deleted'));
    });
  });

  // ── Project archive via REST ───────────────────────────────

  describe('Project create + delete via REST', () => {
    const tempProj = 'HTPR';

    it('creates a temporary project', async () => {
      const res = await request('POST', '/api/projects', {
        identifier: tempProj, name: 'HTTP Temp Project'
      });
      assert.ok([200, 201].includes(res.status));
    });

    it('deletes the temporary project', async () => {
      const res = await request('DELETE', `/api/projects/${tempProj}`);
      assert.equal(res.status, 200);
      assert.ok(res.body.message.includes('deleted'));
    });
  });

  describe('OpenAPI spec completeness', () => {
    it('documents all major route paths', async () => {
      const res = await request('GET', '/api/openapi.json');
      const paths = Object.keys(res.body.paths);
      assert.ok(paths.includes('/api/projects'), 'Should have /api/projects');
      assert.ok(paths.includes('/api/my-issues'), 'Should have /api/my-issues');
      assert.ok(paths.includes('/api/search'), 'Should have /api/search');
      assert.ok(paths.includes('/api/events'), 'Should have /api/events');
      assert.ok(paths.includes('/api/members'), 'Should have /api/members');
      assert.ok(paths.includes('/api/statuses'), 'Should have /api/statuses');
      assert.ok(paths.includes('/api/labels'), 'Should have /api/labels');
      assert.ok(paths.includes('/health'), 'Should have /health');
    });
  });
});
