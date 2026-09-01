import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const core = require('@hcengineering/core').default;
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const task = require('@hcengineering/task').default;
const contactPlugin = require('@hcengineering/contact').default;
const chunter = require('@hcengineering/chunter').default;

const SPACE = core.space.Space;
const ISSUE_CLASS = tracker.class.Issue;
const PROJECT_CLASS = tracker.class.Project;

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, condition]) => {
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
      if (Array.isArray(condition.$in)) return condition.$in.includes(doc[key]);
      return true;
    }
    return doc[key] === condition;
  });
}

function applySort(docs, sort) {
  if (!sort) return docs;
  const entries = Object.entries(sort);
  return [...docs].sort((a, b) => {
    for (const [key, direction] of entries) {
      const delta = (a[key] ?? 0) - (b[key] ?? 0);
      if (delta !== 0) return direction < 0 ? -delta : delta;
    }
    return 0;
  });
}

function harness(seed = {}) {
  const store = new Map([
    [PROJECT_CLASS, seed.projects ?? []],
    [ISSUE_CLASS, seed.issues ?? []],
    [tracker.class.IssueStatus, seed.statuses ?? []],
    [tracker.class.Component, seed.components ?? []],
    [tracker.class.Milestone, seed.milestones ?? []],
    [tracker.class.TimeSpendReport, seed.timeReports ?? []],
    [tags.class.TagElement, seed.labels ?? []],
    [tags.class.TagReference, seed.tagRefs ?? []],
    [task.class.TaskType, seed.taskTypes ?? []],
    [task.class.ProjectType, seed.projectTypes ?? []],
    [contactPlugin.mixin.Employee, seed.employees ?? []],
    [chunter.class.ChatMessage, seed.comments ?? []]
  ]);
  const docsOf = classRef => store.get(classRef) ?? [];
  const calls = [];

  const sdk = {
    findOne: async (classRef, query = {}) => {
      calls.push({ method: 'findOne', classRef, query });
      return docsOf(classRef).find(doc => matches(doc, query)) ?? null;
    },
    findAll: async (classRef, query = {}, options) => {
      calls.push({ method: 'findAll', classRef, query, options });
      return applySort(docsOf(classRef).filter(doc => matches(doc, query)), options?.sort);
    },
    updateDoc: async (classRef, space, id, data) => {
      calls.push({ method: 'updateDoc', classRef, space, id, data });
      const doc = docsOf(classRef).find(item => item._id === id);
      if (doc) Object.assign(doc, data);
    },
    updateCollection: async (classRef, space, id, attachedTo, attachedToClass, collection, data) => {
      calls.push({
        method: 'updateCollection', classRef, space, id, attachedTo, attachedToClass, collection, data
      });
    },
    addCollection: async (classRef, space, attachedTo, attachedToClass, collection, data) => {
      calls.push({ method: 'addCollection', classRef, space, attachedTo, attachedToClass, collection, data });
    }
  };

  const client = new HulyClient({
    url: 'https://huly.example.test', token: 't', workspace: 'w'
  });
  client._getClient = async () => sdk;

  const select = (method, classRef) => calls.filter(call =>
    call.method === method && (classRef === undefined || call.classRef === classRef)
  );
  return { client, sdk, calls, select, store };
}

const EMPLOYEES = [
  { _id: 'emp-1', name: 'Ada Lovelace', active: true },
  { _id: 'emp-2', name: 'Grace Hopper', active: true }
];

// Every Huly Doc carries createdOn, statuses included — the model-level ones
// share a timestamp from when the model was installed. The cursor sorts on it.
const STATUSES = [
  { _id: 's-todo', name: 'Todo', category: 'task:statusCategory:ToDo', color: 1, createdOn: 2 },
  { _id: 's-done', name: 'Done', category: 'task:statusCategory:Won', color: 2, createdOn: 1 }
];

const TASK_TYPES = [
  { _id: 'tt-issue', name: 'Issue', statuses: ['s-todo'] },
  { _id: 'tt-epic', name: 'Epic', statuses: ['s-done'] }
];

function projects() {
  return [
    {
      _id: 'proj-space', space: SPACE, identifier: 'PROJ', name: 'Huly MCP',
      sequence: 42, members: ['emp-1', 'emp-2'], owners: ['emp-1'],
      type: 'pt-classic', createdOn: 100, modifiedOn: 200
    },
    {
      _id: 'other-space', space: SPACE, identifier: 'OTHER', name: 'Other',
      sequence: 3, members: [], owners: [], type: 'pt-classic', createdOn: 50, modifiedOn: 60
    }
  ];
}

describe('getProject expansions', () => {
  it('returns the flat project shape and issues no expansion query when nothing is included', async () => {
    const { client, select } = harness({ projects: projects() });

    const project = await client.getProject('proj');

    assert.deepEqual(project, {
      id: 'proj-space',
      identifier: 'PROJ',
      name: 'Huly MCP',
      description: '',
      archived: false,
      private: false,
      members: 2,
      owners: 1,
      issueCount: 42,
      createdOn: 100,
      modifiedOn: 200,
      extra: { _id: 'proj-space', space: SPACE, sequence: 42, type: 'pt-classic' }
    });
    assert.deepEqual(select('findOne', PROJECT_CLASS).map(call => call.query), [{ identifier: 'PROJ' }]);
    assert.equal(select('findAll').length, 0, 'a bare read must not touch any related collection');
  });

  it('scopes the milestone expansion to this project and fetches nothing else', async () => {
    const { client, select } = harness({
      projects: projects(),
      employees: EMPLOYEES,
      milestones: [
        { _id: 'ms-1', space: 'proj-space', label: 'v1', status: 1, targetDate: Date.UTC(2026, 3, 1) },
        { _id: 'ms-2', space: 'other-space', label: 'v9', status: 0, targetDate: null }
      ],
      components: [{ _id: 'comp-1', space: 'proj-space', label: 'API' }]
    });

    const project = await client.getProject('PROJ', { include: ['milestones'] });

    assert.deepEqual(project.milestones, [
      { name: 'v1', status: 'In Progress', targetDate: '2026-04-01' }
    ]);
    assert.deepEqual(select('findAll', tracker.class.Milestone).map(call => call.query),
      [{ space: 'proj-space' }]);
    assert.equal(select('findAll', tracker.class.Component).length, 0);
    assert.equal(select('findAll', tags.class.TagElement).length, 0);
    assert.equal(select('findAll', contactPlugin.mixin.Employee).length, 0,
      'milestones alone must not pay for the employee lookup');
  });

  it('resolves component leads and replaces the member count with member names', async () => {
    const { client, select } = harness({
      projects: projects(),
      employees: EMPLOYEES,
      components: [
        { _id: 'comp-1', space: 'proj-space', label: 'API', description: 'Gateway', lead: 'emp-1' },
        { _id: 'comp-2', space: 'proj-space', label: 'Web', lead: 'emp-gone' },
        { _id: 'comp-3', space: 'other-space', label: 'Elsewhere', lead: 'emp-2' }
      ]
    });

    const project = await client.getProject('PROJ', { include: ['components', 'members'] });

    assert.deepEqual(project.components, [
      { name: 'API', description: 'Gateway', lead: 'Ada Lovelace' },
      { name: 'Web', description: '', lead: null }
    ]);
    assert.deepEqual(project.members, ['Ada Lovelace', 'Grace Hopper']);
    assert.deepEqual(select('findAll', tracker.class.Component).map(call => call.query),
      [{ space: 'proj-space' }]);
    assert.equal(select('findAll', contactPlugin.mixin.Employee).length, 1,
      'both expansions must share a single employee lookup');
    assert.equal(select('findAll', tracker.class.Milestone).length, 0);
  });

  it('reads labels workspace-wide, restricted to issue tags, without an employee lookup', async () => {
    const { client, select } = harness({
      projects: projects(),
      employees: EMPLOYEES,
      labels: [
        { _id: 'tag-1', space: 'proj-space', title: 'bug', targetClass: ISSUE_CLASS, color: 0x5E6AD2 },
        { _id: 'tag-2', space: 'other-space', title: 'chore', targetClass: ISSUE_CLASS }
      ]
    });

    const project = await client.getProject('PROJ', { include: ['labels'] });

    assert.deepEqual(project.labels, [
      { name: 'bug', color: 0x5E6AD2 },
      { name: 'chore', color: null }
    ]);
    assert.deepEqual(select('findAll', tags.class.TagElement).map(call => call.query),
      [{ targetClass: ISSUE_CLASS }]);
    assert.equal(select('findAll', contactPlugin.mixin.Employee).length, 0);
    assert.equal(project.members, 2, 'members stays a count when the expansion was not requested');
  });

  it('rejects an unknown project and an unsupported expansion name', async () => {
    const { client, select } = harness({ projects: projects() });

    await assert.rejects(() => client.getProject('NOPE'), /Project not found: NOPE/);
    assert.equal(select('findAll').length, 0);

    await assert.rejects(
      () => client.getProject('PROJ', { include: ['issues'] }),
      /Unsupported include value: issues/
    );
  });
});

describe('getIssue expansions', () => {
  function issueHarness(seed = {}) {
    return harness({
      projects: projects(),
      statuses: STATUSES,
      taskTypes: TASK_TYPES,
      employees: EMPLOYEES,
      ...seed
    });
  }

  const parentIssue = () => ({
    _id: 'issue-1', _class: ISSUE_CLASS, space: 'proj-space', number: 1,
    title: 'Parent issue', status: 's-todo', priority: 2, kind: 'tt-issue',
    subIssues: 3, attachedTo: 'proj-space', attachedToClass: PROJECT_CLASS,
    createdOn: 10, modifiedOn: 20
  });

  it('bounds children and resolves their status and type even when neither field was asked for', async () => {
    const { client, select } = issueHarness({
      issues: [
        parentIssue(),
        {
          _id: 'child-a', space: 'proj-space', number: 11, title: 'Child A',
          status: 's-todo', kind: 'tt-issue', attachedTo: 'issue-1', attachedToClass: ISSUE_CLASS
        },
        {
          _id: 'child-b', space: 'proj-space', number: 12, title: 'Child B',
          status: 's-done', kind: 'tt-epic', attachedTo: 'issue-1', attachedToClass: ISSUE_CLASS
        },
        {
          _id: 'child-c', space: 'proj-space', number: 13, title: 'Child C',
          status: 's-todo', kind: 'tt-issue', attachedTo: 'issue-1', attachedToClass: ISSUE_CLASS
        }
      ]
    });

    const issue = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['children'], childrenLimit: 2
    });

    assert.deepEqual(issue, {
      id: 'PROJ-1',
      title: 'Parent issue',
      children: [
        { id: 'PROJ-11', title: 'Child A', status: 'Todo', type: 'Issue' },
        { id: 'PROJ-12', title: 'Child B', status: 'Done', type: 'Epic' }
      ],
      childrenCount: 3,
      childrenTruncated: true
    });
    const childQuery = select('findAll', ISSUE_CLASS).map(call => call.query);
    // Scoped to the project so a child moved to another project is excluded
    // rather than returned under this project's identifier prefix.
    assert.deepEqual(childQuery, [{
      space: 'proj-space', attachedTo: 'issue-1', attachedToClass: ISSUE_CLASS
    }]);
  });

  it('renders related issues with their own project prefix and keeps blockedBy out unless asked', async () => {
    const { client, select } = issueHarness({
      issues: [
        {
          ...parentIssue(),
          relations: [{ _id: 'rel-1' }, { _id: 'rel-2' }],
          blockedBy: [{ _id: 'rel-3' }]
        },
        { _id: 'rel-1', space: 'proj-space', number: 5, title: 'Same project' },
        { _id: 'rel-2', space: 'other-space', number: 9, title: 'Across the workspace' },
        { _id: 'rel-3', space: 'other-space', number: 12, title: 'The blocker' }
      ]
    });

    const relationsOnly = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['relations']
    });

    assert.deepEqual(relationsOnly, {
      id: 'PROJ-1',
      title: 'Parent issue',
      relations: [
        { id: 'PROJ-5', title: 'Same project' },
        { id: 'OTHER-9', title: 'Across the workspace' }
      ],
      relationsCount: 2,
      relationsTruncated: false
    });

    const batched = select('findAll', ISSUE_CLASS).filter(call => Object.hasOwn(call.query, '_id'));
    assert.equal(batched.length, 1, 'related issues must be resolved in one batched query');
    assert.deepEqual(batched[0].query, { _id: { $in: ['rel-1', 'rel-2', 'rel-3'] } });
    assert.deepEqual(select('findAll', PROJECT_CLASS).map(call => call.query),
      [{ _id: { $in: ['proj-space', 'other-space'] } }]);

    const bounded = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['relations', 'blockedBy'], relationsLimit: 1
    });
    assert.deepEqual(bounded.relations, [{ id: 'PROJ-5', title: 'Same project' }]);
    assert.equal(bounded.relationsCount, 2);
    assert.equal(bounded.relationsTruncated, true);
    assert.deepEqual(bounded.blockedBy, [{ id: 'OTHER-12', title: 'The blocker' }]);
    assert.equal(bounded.blockedByCount, 1);
    assert.equal(bounded.blockedByTruncated, false);
  });

  it('reads time reports newest-first and bounded, without fetching comments', async () => {
    const { client, select } = issueHarness({
      issues: [parentIssue()],
      timeReports: [
        { _id: 'tr-mid', attachedTo: 'issue-1', value: 2, description: 'middle', date: 200 },
        { _id: 'tr-new', attachedTo: 'issue-1', value: 1, description: 'newest', date: 300 },
        { _id: 'tr-old', attachedTo: 'issue-1', value: 3, description: '', date: 100 }
      ]
    });

    const issue = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['timeReports'], timeReportsLimit: 2
    });

    assert.deepEqual(issue.timeReports, [
      { id: 'tr-new', hours: 1, description: 'newest', date: new Date(300).toISOString() },
      { id: 'tr-mid', hours: 2, description: 'middle', date: new Date(200).toISOString() }
    ]);
    assert.equal(issue.timeReportsCount, 3);
    assert.equal(issue.timeReportsTruncated, true);

    const [reportCall] = select('findAll', tracker.class.TimeSpendReport);
    assert.deepEqual(reportCall.query, { attachedTo: 'issue-1' });
    assert.deepEqual(reportCall.options, { sort: { date: -1 } });
    assert.equal(select('findAll', chunter.class.ChatMessage).length, 0);
  });

  it('bounds comments and activity independently from a single comment fetch', async () => {
    const { client, select } = issueHarness({
      issues: [parentIssue()],
      comments: [
        { _id: 'c-late', attachedTo: 'issue-1', message: 'second', createdOn: 20, modifiedOn: 21, createdBy: 'emp-1' },
        { _id: 'c-early', attachedTo: 'issue-1', message: 'first', createdOn: 10, modifiedOn: 11 }
      ],
      timeReports: [{ _id: 'tr-1', attachedTo: 'issue-1', value: 1.5, description: 'work', date: 15 }]
    });

    const issue = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['comments', 'activity'], commentsLimit: 1, activityLimit: 5
    });

    assert.deepEqual(issue.comments, [
      { id: 'c-early', text: 'first', createdBy: null, createdOn: 10, modifiedOn: 11 }
    ]);
    assert.equal(issue.commentsCount, 2);
    assert.equal(issue.commentsTruncated, true);
    assert.deepEqual(issue.activity.map(entry => [entry.type, entry.date]),
      [['comment', 10], ['time_logged', 15], ['comment', 20]]);
    assert.equal(issue.activityCount, 3);
    assert.equal(issue.activityTruncated, false);
    assert.equal(Object.hasOwn(issue, 'timeReports'), false,
      'activity must not leak its time-report source collection');
    assert.equal(select('findAll', chunter.class.ChatMessage).length, 1);
  });

  it('renders the parent with the parent project prefix and skips the lookup for project-owned issues', async () => {
    const { client, select } = issueHarness({
      issues: [
        {
          ...parentIssue(), _id: 'issue-2', number: 2, title: 'Sub issue',
          attachedTo: 'parent-id', attachedToClass: ISSUE_CLASS
        },
        { _id: 'parent-id', space: 'other-space', number: 7, title: 'Epic' },
        { ...parentIssue(), _id: 'issue-3', number: 3 }
      ]
    });

    const child = await client.getIssue('PROJ-2', { fields: ['parent', 'childCount'], include: [] });
    assert.deepEqual(child, { id: 'PROJ-2', parent: 'OTHER-7', childCount: 3 });

    const before = select('findOne', ISSUE_CLASS).length;
    const root = await client.getIssue('PROJ-3', { fields: ['parent'], include: [] });
    assert.deepEqual(root, { id: 'PROJ-3', parent: null });
    assert.equal(select('findOne', ISSUE_CLASS).length - before, 1,
      'a project-owned issue must not trigger a parent lookup');
  });

  it('reads a collaborator-backed description by reference and previews it on request', async () => {
    const body = 'huly words '.repeat(40);
    const { client } = issueHarness({
      issues: [
        { ...parentIssue(), description: 'abc123-description-4' },
        { ...parentIssue(), _id: 'issue-5', number: 5, description: 'stored inline' }
      ]
    });
    const reads = [];
    client._readCollaboratorField = async (...args) => {
      reads.push(args);
      return body;
    };

    const full = await client.getIssue('PROJ-1', { fields: ['title'], include: ['description'] });
    assert.deepEqual(reads, [['issue-1', ISSUE_CLASS, 'description', 'abc123-description-4']]);
    assert.equal(full.description, body);
    assert.equal(full.descriptionTruncated, false);

    const preview = await client.getIssue('PROJ-1', {
      fields: ['title'], include: ['description'], descriptionPreviewChars: 100
    });
    assert.equal(preview.descriptionTruncated, true);
    assert.ok(preview.description.endsWith('…'));
    assert.ok(preview.description.length <= 101);

    const inline = await client.getIssue('PROJ-5', { fields: ['title'], include: ['description'] });
    assert.equal(inline.description, 'stored inline');
    assert.equal(reads.length, 2, 'a plain description must not reach the collaborator service');
  });
});

describe('getMilestone issue expansion', () => {
  function milestoneHarness(issues) {
    return harness({
      projects: projects(),
      statuses: STATUSES,
      taskTypes: TASK_TYPES,
      milestones: [
        { _id: 'ms-1', space: 'proj-space', label: 'v1', status: 1, targetDate: Date.UTC(2026, 3, 1), comments: 2 },
        { _id: 'ms-other', space: 'other-space', label: 'v9', status: 0 }
      ],
      issues
    });
  }

  const milestoneIssue = (id, number, overrides = {}) => ({
    _id: id, space: 'proj-space', number, title: `Issue ${number}`,
    status: 's-todo', kind: 'tt-issue', milestone: 'ms-1', ...overrides
  });

  it('scopes the issue query to the project and reports the full count next to a bounded page', async () => {
    const { client, select } = milestoneHarness([
      milestoneIssue('i-1', 1),
      milestoneIssue('i-2', 2, { status: 's-done', kind: 'tt-epic' }),
      milestoneIssue('i-3', 3),
      milestoneIssue('i-4', 4, { space: 'other-space' }),
      milestoneIssue('i-5', 5, { milestone: 'ms-other' })
    ]);

    const milestone = await client.getMilestone('proj', 'V1', { include: ['issues'], issuesLimit: 2 });

    assert.deepEqual(select('findAll', ISSUE_CLASS).map(call => call.query),
      [{ space: 'proj-space', milestone: 'ms-1' }]);
    assert.deepEqual(milestone.issues, [
      { id: 'PROJ-1', title: 'Issue 1', status: 'Todo', type: 'Issue' },
      { id: 'PROJ-2', title: 'Issue 2', status: 'Done', type: 'Epic' }
    ]);
    assert.equal(milestone.issuesCount, 3);
    assert.equal(milestone.issuesTruncated, true);
    assert.equal(milestone.issueCount, milestone.issuesCount,
      'the headline count and the expansion count describe the same set');
    assert.equal(milestone.name, 'v1');
    assert.equal(milestone.status, 'In Progress');
    assert.equal(milestone.targetDate, '2026-04-01');
    assert.equal(milestone.comments, 2);
  });

  it('applies the default issue bound and refuses a bound above the ceiling', async () => {
    const many = Array.from({ length: 25 }, (_, index) => milestoneIssue(`i-${index}`, index + 1));
    const { client } = milestoneHarness(many);

    const milestone = await client.getMilestone('PROJ', 'v1', { include: ['issues'] });
    assert.equal(milestone.issues.length, 20);
    assert.equal(milestone.issuesCount, 25);
    assert.equal(milestone.issuesTruncated, true);

    await assert.rejects(
      () => client.getMilestone('PROJ', 'v1', { include: ['issues'], issuesLimit: 101 }),
      /integer from 1 to 100/
    );
  });

  it('counts issues without expanding them or building lookup maps', async () => {
    const { client, select } = milestoneHarness([milestoneIssue('i-1', 1), milestoneIssue('i-2', 2)]);

    const milestone = await client.getMilestone('PROJ', 'v1');

    assert.equal(milestone.issueCount, 2);
    assert.equal(Object.hasOwn(milestone, 'issues'), false);
    assert.equal(Object.hasOwn(milestone, 'issuesCount'), false);
    assert.equal(select('findAll', tracker.class.IssueStatus).length, 0);
    assert.equal(select('findAll', task.class.TaskType).length, 0);
  });

  it('does not match a same-named milestone owned by another project', async () => {
    const { client } = milestoneHarness([]);

    await assert.rejects(() => client.getMilestone('PROJ', 'v9'), /Milestone not found: v9/);
    await assert.rejects(() => client.getMilestone('NOPE', 'v1'), /Project not found: NOPE/);
  });
});

describe('listLabels envelope', () => {
  const labelFixtures = () => [
    {
      _id: 'tag-1', space: 'proj-space', title: 'bug', targetClass: ISSUE_CLASS,
      color: 0x5E6AD2, createdOn: 3
    },
    {
      _id: 'tag-2', space: 'proj-space', title: 'chore', targetClass: ISSUE_CLASS,
      description: 'Housekeeping', category: 'tracker:category:Other', createdOn: 2
    },
    { _id: 'tag-3', space: 'proj-space', title: 'doc', targetClass: ISSUE_CLASS, createdOn: 1 }
  ];

  it('restricts the query to issue tags and returns the resolved label shape', async () => {
    const { client, select } = harness({ labels: labelFixtures() });

    const page = await client.listLabels();

    assert.deepEqual(select('findAll', tags.class.TagElement).map(call => call.query),
      [{ targetClass: ISSUE_CLASS }]);
    assert.deepEqual(page.items[0], {
      id: 'tag-1',
      name: 'bug',
      description: '',
      color: 0x5E6AD2,
      category: null,
      extra: {
        _id: 'tag-1', space: 'proj-space', title: 'bug',
        targetClass: ISSUE_CLASS, createdOn: 3
      }
    });
    assert.equal(page.items[1].description, 'Housekeeping');
    assert.equal(page.items[1].category, 'tracker:category:Other');
    assert.equal(page.items[1].color, null);
    assert.equal(page.count, 3);
    assert.equal(page.hasMore, false);
    assert.equal(page.truncated, false);
    assert.equal(Object.hasOwn(page, 'nextCursor'), false);
  });

  it('states truncation on the envelope when a page is cut short', async () => {
    const { client } = harness({ labels: labelFixtures() });

    const page = await client.listLabels({ limit: 2 });

    assert.deepEqual(page.items.map(item => item.id), ['tag-1', 'tag-2']);
    assert.equal(page.count, 2);
    assert.equal(page.hasMore, true);
    assert.equal(page.truncated, true);
    assert.equal(typeof page.nextCursor, 'string');
  });
});

describe('listProjectTypes', () => {
  it('names the task types of each type in one pass and drops dangling references', async () => {
    const { client, select } = harness({
      projectTypes: [
        {
          _id: 'pt-classic', name: 'Classic', shortDescription: 'Default workflow',
          tasks: ['tt-epic', 'tt-issue', 'tt-removed'], createdOn: 2
        },
        { _id: 'task:type:Bugs', createdOn: 1 }
      ],
      taskTypes: TASK_TYPES
    });

    const page = await client.listProjectTypes();
    const byId = new Map(page.items.map(item => [item.id, item]));

    const { extra: classicExtra, ...classic } = byId.get('pt-classic');
    assert.deepEqual(classic, {
      id: 'pt-classic',
      name: 'Classic',
      description: 'Default workflow',
      taskTypes: ['Epic', 'Issue']
    });
    const { extra: _bugsExtra, ...bugs } = byId.get('task:type:Bugs');
    assert.deepEqual(bugs, {
      id: 'task:type:Bugs',
      name: 'Bugs',
      description: null,
      taskTypes: []
    });
    assert.equal(classicExtra.createdOn, 2, 'the source timestamp must reach the cursor tuple');
    assert.equal(page.count, 2);
    assert.equal(page.hasMore, false);
    assert.equal(select('findAll', task.class.TaskType).length, 1,
      'task types must be resolved from one workspace-wide read');
  });
});

describe('listStatuses scoping', () => {
  function statusHarness() {
    return harness({
      projects: projects(),
      statuses: [
        ...STATUSES,
        { _id: 's-loose', name: 'Orphan', category: 'task:statusCategory:Active', color: 3, createdOn: 4 },
        { _id: 's-odd', name: 'Odd', category: 'task:statusCategory:Unmapped', color: 4, description: 'Custom', createdOn: 3 }
      ],
      taskTypes: [
        ...TASK_TYPES,
        { _id: 'tt-bug', name: 'Bug', statuses: ['s-loose'] }
      ],
      projectTypes: [
        { _id: 'pt-classic', name: 'Classic', tasks: ['tt-issue', 'tt-epic'] },
        { _id: 'pt-bugs', name: 'Bugs', tasks: ['tt-bug'] }
      ]
    });
  }

  it('returns every status with mapped categories and no taxonomy reads when unscoped', async () => {
    const { client, select } = statusHarness();

    const page = await client.listStatuses();
    const byId = new Map(page.items.map(item => [item.id, item]));

    assert.equal(page.count, 4);
    const { extra: todoExtra, ...todo } = byId.get('s-todo');
    assert.deepEqual(todo,
      { id: 's-todo', name: 'Todo', category: 'Todo', color: 1, description: '' });
    const { extra: _doneExtra, ...done } = byId.get('s-done');
    assert.deepEqual(done,
      { id: 's-done', name: 'Done', category: 'Done', color: 2, description: '' });
    // The source timestamp rides in extra so the cursor can sort on it. Compact
    // output strips extra, so this costs no response bytes.
    assert.ok(todoExtra.createdOn > 0, 'status rows must carry a cursor timestamp');
    assert.equal(byId.get('s-odd').category, 'task:statusCategory:Unmapped',
      'an unmapped category must pass through rather than resolve to a wrong name');
    assert.equal(byId.get('s-odd').description, 'Custom');
    assert.equal(select('findAll', task.class.TaskType).length, 0);
    assert.equal(select('findAll', task.class.ProjectType).length, 0);
    assert.equal(select('findOne', PROJECT_CLASS).length, 0);
  });

  it('orders statuses by creation time instead of degenerating to id order', async () => {
    const { client } = statusHarness();

    const page = await client.listStatuses();

    // When every status tuples to createdOn 0, the comparator falls through to
    // its id-descending tiebreak and yields: s-todo, s-odd, s-loose, s-done.
    assert.deepEqual(page.items.map(s => s.id), ['s-loose', 's-odd', 's-todo', 's-done']);
  });

  it('pages statuses across a cursor without gaps or repeats', async () => {
    const { client } = statusHarness();

    const first = await client.listStatuses(undefined, undefined, { limit: 2 });
    assert.deepEqual(first.items.map(s => s.id), ['s-loose', 's-odd']);
    assert.ok(first.nextCursor, 'a truncated status page must offer a cursor');

    const second = await client.listStatuses(undefined, undefined,
      { limit: 2, cursor: first.nextCursor });

    assert.deepEqual(second.items.map(s => s.id), ['s-todo', 's-done']);
    assert.equal(second.nextCursor, undefined);
  });

  it('rejects a task type that exists elsewhere but not in the addressed project', async () => {
    const { client } = statusHarness();

    await assert.rejects(
      () => client.listStatuses('PROJ', 'Bug'),
      /Task type not found: Bug/
    );
    await assert.rejects(() => client.listStatuses('NOPE'), /Project not found: NOPE/);
    await assert.rejects(() => client.listStatuses(undefined, 'Nothing'), /Task type not found: Nothing/);
  });

  it('scopes to a task type across the workspace when no project is given', async () => {
    const { client } = statusHarness();

    const page = await client.listStatuses(undefined, 'bug');

    assert.deepEqual(page.items.map(item => item.id), ['s-loose']);
    assert.equal(page.count, 1);
    assert.equal(page.items[0].category, 'Active');
  });
});

describe('_detachParent', () => {
  function detachHarness(childOverrides = {}, oldParent = null) {
    return harness({
      projects: projects(),
      issues: [
        {
          _id: 'child-id', _class: ISSUE_CLASS, space: 'proj-space', number: 2,
          title: 'Sub issue', attachedTo: 'old-parent-id', attachedToClass: ISSUE_CLASS,
          collection: 'subIssues', parents: [{ parentId: 'old-parent-id' }],
          ...childOverrides
        },
        ...(oldParent ? [oldParent] : [])
      ]
    });
  }

  it('returns the issue to the project collection and trims the old parent in its own space', async () => {
    const { client, select } = detachHarness({}, {
      _id: 'old-parent-id', space: 'other-space', number: 7, subIssues: 2,
      childInfo: [
        { childId: 'child-id', estimation: 3, reportedTime: 1 },
        { childId: 'sibling-id', estimation: 0, reportedTime: 0 }
      ]
    });

    const result = await client.setParent('PROJ-2', '');

    assert.deepEqual(select('updateDoc', ISSUE_CLASS), [{
      method: 'updateDoc',
      classRef: ISSUE_CLASS,
      space: 'other-space',
      id: 'old-parent-id',
      data: {
        childInfo: [{ childId: 'sibling-id', estimation: 0, reportedTime: 0 }],
        subIssues: 1
      }
    }]);
    assert.deepEqual(select('updateCollection'), [{
      method: 'updateCollection',
      classRef: ISSUE_CLASS,
      space: 'proj-space',
      id: 'child-id',
      attachedTo: 'proj-space',
      attachedToClass: PROJECT_CLASS,
      collection: 'issues',
      data: {
        parents: [],
        attachedTo: 'proj-space',
        attachedToClass: PROJECT_CLASS,
        collection: 'issues'
      }
    }]);
    assert.deepEqual(result, {
      message: 'Removed parent from PROJ-2', issueId: 'PROJ-2', parentId: null
    });
  });

  it('detaches even when the recorded parent no longer exists', async () => {
    const { client, select } = detachHarness();

    await client.setParent('PROJ-2', '   ');

    assert.equal(select('updateDoc').length, 0);
    assert.equal(select('updateCollection').length, 1);
    assert.equal(select('updateCollection')[0].space, 'proj-space');
  });

  it('writes nothing when the issue is already owned by the project', async () => {
    const { client, select } = detachHarness({
      attachedTo: 'proj-space', attachedToClass: PROJECT_CLASS, collection: 'issues'
    });

    for (const parentId of ['', undefined, null]) {
      const result = await client.setParent('PROJ-2', parentId);
      assert.deepEqual(result, { message: 'PROJ-2 has no parent', issueId: 'PROJ-2', parentId: null });
    }
    assert.equal(select('updateDoc').length, 0);
    assert.equal(select('updateCollection').length, 0);
  });
});

describe('_buildRelatedIssueMap', () => {
  it('asks for nothing when no issue carries a relation', async () => {
    const { client, sdk, select } = harness({ projects: projects() });

    const map = await client._buildRelatedIssueMap(sdk, [
      { _id: 'a' }, { _id: 'b', relations: [], blockedBy: [] }
    ]);

    assert.equal(map.size, 0);
    assert.equal(select('findAll').length, 0);
  });

  it('deduplicates references across issues and both link kinds into one query pair', async () => {
    const { client, sdk, select } = harness({
      projects: projects(),
      issues: [
        { _id: 'rel-1', space: 'proj-space', number: 5, title: 'First' },
        { _id: 'rel-2', space: 'other-space', number: 9, title: 'Second' }
      ]
    });

    const map = await client._buildRelatedIssueMap(sdk, [
      { _id: 'a', relations: [{ _id: 'rel-1' }], blockedBy: [{ _id: 'rel-2' }] },
      { _id: 'b', relations: [{ _id: 'rel-2' }], blockedBy: [{ _id: 'rel-1' }] }
    ]);

    assert.deepEqual(select('findAll', ISSUE_CLASS).map(call => call.query),
      [{ _id: { $in: ['rel-1', 'rel-2'] } }]);
    assert.deepEqual(select('findAll', PROJECT_CLASS).map(call => call.query),
      [{ _id: { $in: ['proj-space', 'other-space'] } }]);
    assert.deepEqual([...map.entries()], [
      ['rel-1', { id: 'PROJ-5', title: 'First' }],
      ['rel-2', { id: 'OTHER-9', title: 'Second' }]
    ]);
  });

  it('marks an unresolvable project and omits a reference that no longer exists', async () => {
    const { client, sdk } = harness({
      projects: [],
      issues: [{ _id: 'rel-1', space: 'ghost-space', number: 5, title: 'Orphan' }]
    });

    const map = await client._buildRelatedIssueMap(sdk, [
      { _id: 'a', relations: [{ _id: 'rel-1' }, { _id: 'rel-gone' }] }
    ]);

    assert.deepEqual([...map.entries()], [['rel-1', { id: '?-5', title: 'Orphan' }]]);
    assert.equal(map.has('rel-gone'), false);
  });
});
