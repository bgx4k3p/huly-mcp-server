import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const task = require('@hcengineering/task').default;
const contactPlugin = require('@hcengineering/contact').default;
const chunter = require('@hcengineering/chunter').default;

const MODEL_SPACE = 'core:space:Space';

const STATUSES = [
  { _id: 'status-todo', name: 'Todo', category: 'task:statusCategory:ToDo' },
  { _id: 'status-progress', name: 'In Progress', category: 'task:statusCategory:Active' },
  { _id: 'status-review', name: 'In Review', category: 'task:statusCategory:Active' },
  { _id: 'status-triage', name: 'Triage', category: 'task:statusCategory:UnStarted' },
  { _id: 'status-done', name: 'Done', category: 'task:statusCategory:Won' },
  { _id: 'status-cancelled', name: 'Cancelled', category: 'task:statusCategory:Lost' }
];

const TASK_TYPES = [
  { _id: 'task-type', name: 'Task', statuses: ['status-todo', 'status-progress', 'status-done'] },
  { _id: 'bug-type', name: 'Bug', statuses: ['status-triage'] }
];

const PROJECT_TYPES = [{ _id: 'project-type', tasks: ['task-type', 'bug-type'] }];

const EMPLOYEES = [
  { _id: 'emp-1', name: 'Ada Lovelace', active: true, channels: [{ value: 'ada@example.test' }] },
  { _id: 'emp-2', name: 'Grace Hopper', active: true, channels: [{ value: 'grace@example.test' }] }
];

function baseProject(overrides = {}) {
  return {
    _id: 'project-id',
    space: MODEL_SPACE,
    identifier: 'PROJ',
    name: 'Project',
    sequence: 10,
    type: 'project-type',
    defaultIssueStatus: 'status-todo',
    ...overrides
  };
}

function baseIssue(overrides = {}) {
  return {
    _id: 'issue-1',
    _class: tracker.class.Issue,
    space: 'project-id',
    number: 1,
    identifier: 'PROJ-1',
    title: 'Existing issue',
    description: '',
    status: 'status-todo',
    priority: 2,
    kind: 'task-type',
    assignee: null,
    attachedTo: 'project-id',
    attachedToClass: tracker.class.Project,
    collection: 'issues',
    createdOn: 1000,
    modifiedOn: 2000,
    ...overrides
  };
}

function matches(record, query) {
  return Object.entries(query).every(([key, condition]) => {
    if (key.startsWith('$')) return true;
    const value = record[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$in' in condition) return condition.$in.includes(value);
      if ('$lt' in condition) return value < condition.$lt;
      return true;
    }
    return value === condition;
  });
}

function createHarness(data = {}) {
  const state = {
    projects: [baseProject()],
    issues: [],
    statuses: STATUSES,
    taskTypes: TASK_TYPES,
    projectTypes: PROJECT_TYPES,
    employees: EMPLOYEES,
    components: [],
    milestones: [],
    tagElements: [],
    tagReferences: [],
    comments: [],
    timeReports: [],
    ...data
  };

  const collectionFor = classRef => {
    switch (classRef) {
      case tracker.class.Project: return state.projects;
      case tracker.class.Issue: return state.issues;
      case tracker.class.IssueStatus: return state.statuses;
      case tracker.class.Component: return state.components;
      case tracker.class.Milestone: return state.milestones;
      case tracker.class.TimeSpendReport: return state.timeReports;
      case task.class.TaskType: return state.taskTypes;
      case task.class.ProjectType: return state.projectTypes;
      case contactPlugin.mixin.Employee: return state.employees;
      case tags.class.TagElement: return state.tagElements;
      case tags.class.TagReference: return state.tagReferences;
      case chunter.class.ChatMessage: return state.comments;
      default: return [];
    }
  };

  const calls = [];
  const sdk = {
    findOne: async (classRef, query) => {
      calls.push({ method: 'findOne', classRef, query });
      return collectionFor(classRef).find(record => matches(record, query)) ?? null;
    },
    findAll: async (classRef, query = {}, options) => {
      calls.push({ method: 'findAll', classRef, query, options });
      return collectionFor(classRef).filter(record => matches(record, query));
    },
    updateDoc: async (classRef, space, id, data) => {
      calls.push({ method: 'updateDoc', classRef, space, id, data });
      const target = collectionFor(classRef).find(record => record._id === id);
      if (!target) return;
      for (const [key, value] of Object.entries(data)) {
        if (key !== '$inc') {
          target[key] = value;
          continue;
        }
        for (const [field, delta] of Object.entries(value)) {
          target[field] = (target[field] ?? 0) + delta;
        }
      }
    },
    addCollection: async (classRef, space, attachedTo, attachedToClass, collection, data, id) => {
      calls.push({
        method: 'addCollection', classRef, space, attachedTo, attachedToClass, collection, data, id
      });
      collectionFor(classRef).push({
        _id: id ?? `generated-${calls.length}`, space, attachedTo, attachedToClass, collection, ...data
      });
    },
    removeCollection: async (classRef, space, id, attachedTo, attachedToClass, collection) => {
      calls.push({
        method: 'removeCollection', classRef, space, id, attachedTo, attachedToClass, collection
      });
    },
    createDoc: async (classRef, space, docData, id) => {
      calls.push({ method: 'createDoc', classRef, space, data: docData, id });
      collectionFor(classRef).push({ _id: id, space, ...docData });
    }
  };

  const client = new HulyClient({
    url: 'https://huly.example.test',
    token: 'test-token',
    email: data.email,
    workspace: 'test-workspace'
  });
  client._getClient = async () => sdk;

  const collaboratorWrites = [];
  client._writeCollaboratorField = async (objectId, objectClass, text, format) => {
    collaboratorWrites.push({ objectId, objectClass, text, format });
  };

  const select = (method, classRef) => calls.filter(call =>
    call.method === method && (classRef === undefined || call.classRef === classRef)
  );

  return { client, calls, state, collaboratorWrites, select };
}

describe('createIssue payload', () => {
  it('writes the issue into the project space with SDK-typed field values', async () => {
    const { client, select } = createHarness({
      components: [{ _id: 'comp-1', space: 'project-id', label: 'API' }],
      milestones: [{ _id: 'ms-1', space: 'project-id', label: 'v1', status: 0 }]
    });

    const result = await client.createIssue(
      'proj', 'Ship it', undefined, 'medium', 'In Progress', undefined, undefined,
      { assignee: 'ada lovelace', component: 'API', milestone: 'v1', estimation: '4.5', dueDate: '2026-04-01' }
    );

    // The project sequence lives in the project's own space; the issue lives in the project.
    assert.deepEqual(select('updateDoc', tracker.class.Project), [{
      method: 'updateDoc',
      classRef: tracker.class.Project,
      space: MODEL_SPACE,
      id: 'project-id',
      data: { $inc: { sequence: 1 } }
    }]);

    const writes = select('addCollection', tracker.class.Issue);
    assert.equal(writes.length, 1);
    const [write] = writes;
    assert.equal(write.space, 'project-id');
    assert.equal(write.attachedTo, 'project-id');
    assert.equal(write.attachedToClass, tracker.class.Project);
    assert.equal(write.collection, 'issues');

    const { rank, ...data } = write.data;
    assert.equal(typeof rank, 'string');
    assert.deepEqual(data, {
      title: 'Ship it',
      identifier: 'PROJ-11',
      description: '',
      status: 'status-progress',
      priority: 3,
      number: 11,
      assignee: 'emp-1',
      component: 'comp-1',
      milestone: 'ms-1',
      estimation: 4.5,
      dueDate: new Date('2026-04-01').getTime(),
      remainingTime: 0,
      reportedTime: 0,
      childInfo: [],
      parents: [],
      kind: 'task-type'
    });
    assert.equal(result.id, 'PROJ-11');
  });

  it('creates nothing when the status is unavailable for the resolved task type', async () => {
    const { client, select } = createHarness();

    // "Triage" exists in the workspace but only on the Bug task type.
    await assert.rejects(
      () => client.createIssue('PROJ', 'Scoped', undefined, undefined, 'Triage'),
      /Status "Triage" not found/
    );
    assert.equal(select('addCollection').length, 0);
  });

  it('routes the description through the collaborator using the requested format', async () => {
    const { client, select, collaboratorWrites } = createHarness();

    await client.createIssue(
      'PROJ', 'Documented', '# Heading', undefined, undefined, undefined, undefined,
      { descriptionFormat: 'html' }
    );

    const [write] = select('addCollection', tracker.class.Issue);
    assert.equal(write.data.description, '');
    const [refUpdate] = select('updateDoc', tracker.class.Issue);
    assert.equal(refUpdate.space, 'project-id');
    assert.equal(refUpdate.id, write.id);
    assert.ok(refUpdate.data.description.startsWith(`${write.id}-description-`));
    assert.deepEqual(collaboratorWrites, [{
      objectId: write.id,
      objectClass: tracker.class.Issue,
      text: '# Heading',
      format: 'html'
    }]);
  });

  it('does not touch the description document when no description is given', async () => {
    const { client, select, collaboratorWrites } = createHarness();

    await client.createIssue('PROJ', 'Bare');

    assert.equal(select('updateDoc', tracker.class.Issue).length, 0);
    assert.equal(collaboratorWrites.length, 0);
  });
});

describe('updateIssue payload', () => {
  function updateHarness(data = {}) {
    const harness = createHarness({ issues: [baseIssue()], ...data });
    harness.client._parseAndFindIssue = async () => ({
      project: harness.state.projects[0],
      issue: harness.state.issues[0]
    });
    return harness;
  }

  it('sends a single update carrying only the supplied fields', async () => {
    const { client, select } = updateHarness();

    const result = await client.updateIssue('PROJ-1', 'Renamed');

    assert.deepEqual(select('updateDoc', tracker.class.Issue), [{
      method: 'updateDoc',
      classRef: tracker.class.Issue,
      space: 'project-id',
      id: 'issue-1',
      data: { title: 'Renamed' }
    }]);
    assert.deepEqual(result.updated, ['title']);
  });

  it('clears the due date and coerces a numeric-string estimation', async () => {
    const { client, select } = updateHarness();

    await client.updateIssue('PROJ-1', undefined, undefined, undefined, undefined, undefined, {
      dueDate: '', estimation: '2.5'
    });

    const [update] = select('updateDoc', tracker.class.Issue);
    assert.deepEqual(update.data, { dueDate: null, estimation: 2.5 });
  });

  it('writes a description without issuing an empty document update', async () => {
    const { client, select, collaboratorWrites } = updateHarness();

    const result = await client.updateIssue('PROJ-1', undefined, 'new body');

    assert.equal(select('updateDoc').length, 0);
    assert.deepEqual(collaboratorWrites.map(write => write.text), ['new body']);
    assert.deepEqual(result.updated, ['description']);
  });

  it('scopes a new status to the newly requested task type', async () => {
    const { client, select } = updateHarness();

    // "Triage" belongs to the Bug workflow only, so it resolves only because
    // the type change is applied before the status lookup.
    await client.updateIssue('PROJ-1', undefined, undefined, undefined, 'Triage', 'Bug');

    const [update] = select('updateDoc', tracker.class.Issue);
    assert.deepEqual(update.data, { kind: 'bug-type', status: 'status-triage' });
  });
});

describe('assignIssue writes', () => {
  function assignHarness() {
    const harness = createHarness({ issues: [baseIssue({ assignee: 'emp-2' })] });
    harness.client._parseAndFindIssue = async () => ({
      project: harness.state.projects[0],
      issue: harness.state.issues[0]
    });
    return harness;
  }

  it('clears the assignee without scanning members', async () => {
    const { client, select } = assignHarness();

    await client.assignIssue('PROJ-1', '   ');

    assert.deepEqual(select('updateDoc', tracker.class.Issue).map(call => call.data), [{ assignee: null }]);
    assert.equal(select('findAll', contactPlugin.mixin.Employee).length, 0);
  });

  it('stores the member id and refuses an unknown member without writing', async () => {
    const { client, select } = assignHarness();

    const result = await client.assignIssue('PROJ-1', 'ada lovelace');
    assert.deepEqual(select('updateDoc', tracker.class.Issue).map(call => call.data), [{ assignee: 'emp-1' }]);
    assert.equal(result.assignee, 'Ada Lovelace');

    await assert.rejects(() => client.assignIssue('PROJ-1', 'Nobody'), /Member "Nobody" not found/);
    assert.equal(select('updateDoc', tracker.class.Issue).length, 1);
  });
});

describe('moveIssue and deleteIssue', () => {
  function moveHarness(issueOverrides = {}) {
    const destination = baseProject({
      _id: 'dest-id', identifier: 'DEST', sequence: 20, defaultIssueStatus: 'status-triage'
    });
    const harness = createHarness({
      projects: [baseProject(), destination],
      issues: [baseIssue(issueOverrides)]
    });
    harness.client._parseAndFindIssue = async () => ({
      project: harness.state.projects[0],
      issue: harness.state.issues[0]
    });
    return harness;
  }

  it('rewrites space, number, identifier and parent link in one update', async () => {
    const { client, select } = moveHarness({ status: 'status-review' });

    const result = await client.moveIssue('PROJ-1', 'dest');

    assert.deepEqual(select('updateDoc', tracker.class.Project).map(call => ({
      space: call.space, id: call.id, data: call.data
    })), [{ space: MODEL_SPACE, id: 'dest-id', data: { $inc: { sequence: 1 } } }]);

    assert.deepEqual(select('updateDoc', tracker.class.Issue), [{
      method: 'updateDoc',
      classRef: tracker.class.Issue,
      space: 'project-id',
      id: 'issue-1',
      data: {
        space: 'dest-id',
        number: 21,
        identifier: 'DEST-21',
        attachedTo: 'dest-id',
        // status-review is not in the destination task type's workflow, so the
        // issue lands on the destination default rather than keeping a status
        // borrowed from some other project type.
        status: 'status-triage'
      }
    }]);
    assert.equal(result.newId, 'DEST-21');
  });

  it('keeps a status the destination workflow actually contains', async () => {
    const { client, select } = moveHarness({ status: 'status-todo' });

    await client.moveIssue('PROJ-1', 'dest');

    const update = select('updateDoc', tracker.class.Issue)[0];
    assert.equal(update.data.status, 'status-todo',
      'a status inside the destination workflow must survive the move');
  });

  it('does not renumber or write when the target is the current project', async () => {
    const { client, select } = moveHarness();

    const result = await client.moveIssue('PROJ-1', 'proj');

    assert.equal(select('updateDoc').length, 0);
    assert.match(result.message, /already in project/);
  });

  it('removes an issue from the collection that owns it', async () => {
    const harness = createHarness({
      issues: [baseIssue({
        attachedTo: 'parent-issue', attachedToClass: tracker.class.Issue, collection: 'subIssues'
      })]
    });
    harness.client._parseAndFindIssue = async () => ({
      project: harness.state.projects[0],
      issue: harness.state.issues[0]
    });

    await harness.client.deleteIssue('PROJ-1');

    assert.deepEqual(harness.select('removeCollection'), [{
      method: 'removeCollection',
      classRef: tracker.class.Issue,
      space: 'project-id',
      id: 'issue-1',
      attachedTo: 'parent-issue',
      attachedToClass: tracker.class.Issue,
      collection: 'subIssues'
    }]);
  });
});

describe('batchCreateIssues', () => {
  it('reserves exactly one number per titled issue and assigns them consecutively', async () => {
    const { client, select } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'First' },
      { description: 'no title' },
      { title: 'Second' }
    ]);

    assert.deepEqual(select('updateDoc', tracker.class.Project).map(call => call.data),
      [{ $inc: { sequence: 2 } }]);
    assert.deepEqual(
      select('addCollection', tracker.class.Issue).map(call => call.data.identifier),
      ['PROJ-11', 'PROJ-12']
    );
    assert.deepEqual(
      select('addCollection', tracker.class.Issue).map(call => call.data.number),
      [11, 12]
    );
    assert.deepEqual(result.created.map(item => item.id), ['PROJ-11', 'PROJ-12']);
    assert.equal(result.total, 2);
    assert.equal(result.errors.length, 1);
  });

  it('reports per-item failures without creating them and without counting them', async () => {
    const { client, select } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'Good' },
      { title: 'Bad status', status: 'Triage' },
      { title: 'Bad assignee', assignee: 'Nobody' }
    ]);

    assert.deepEqual(
      select('addCollection', tracker.class.Issue).map(call => call.data.title),
      ['Good']
    );
    assert.equal(result.total, result.created.length);
    assert.equal(result.created.length, 1);
    assert.deepEqual(result.errors.map(item => item.input.title), ['Bad status', 'Bad assignee']);
  });

  it('rejects empty and oversized batches before reserving any numbers', async () => {
    const { client, select, state } = createHarness();

    await assert.rejects(() => client.batchCreateIssues('PROJ', []), /non-empty array/);
    await assert.rejects(
      () => client.batchCreateIssues('PROJ', Array.from({ length: 501 }, () => ({ title: 'x' }))),
      /Batch size limited to 500/
    );
    assert.equal(select('updateDoc').length, 0);
    assert.equal(state.projects[0].sequence, 10);
  });
});

describe('searchIssues and getMyIssues query scoping', () => {
  const searchIssue = () => baseIssue({ _id: 'issue-9', number: 9, assignee: 'emp-1' });

  it('forwards the search term to the SDK scoped to the requested project', async () => {
    const { client, select } = createHarness({ issues: [searchIssue()] });

    const page = await client.searchIssues('login', 'proj', 10);

    const issueQueries = select('findAll', tracker.class.Issue)
      .filter(call => Object.hasOwn(call.query, '$search'));
    assert.deepEqual(issueQueries.map(call => call.query), [{ $search: 'login', space: 'project-id' }]);
    assert.deepEqual(page.items.map(item => item.id), ['PROJ-9']);
    assert.equal(page.hasMore, false);
  });

  it('enforces the page-size ceiling instead of silently clamping it', async () => {
    const { client } = createHarness();

    await assert.rejects(() => client.searchIssues('login', undefined, 101), /integer from 1 to 100/);
  });

  it('constrains my-issues to the resolved employee id', async () => {
    const { client, select } = createHarness({
      email: 'ada@example.test',
      issues: [
        baseIssue({ _id: 'mine', number: 4, assignee: 'emp-1' }),
        baseIssue({ _id: 'theirs', number: 5, assignee: 'emp-2' })
      ]
    });

    const page = await client.getMyIssues();

    const assigneeQueries = select('findAll', tracker.class.Issue)
      .filter(call => Object.hasOwn(call.query, 'assignee'));
    assert.deepEqual(assigneeQueries[0].query, { assignee: 'emp-1' });
    assert.deepEqual(page.items.map(item => item.id), ['PROJ-4']);
  });

  it('fails instead of returning every issue when the user cannot be identified', async () => {
    const { client, select } = createHarness({ email: 'stranger@example.test' });

    await assert.rejects(() => client.getMyIssues(), /Could not find current user/);
    assert.equal(select('findAll', tracker.class.Issue).length, 0);
  });
});

describe('summarizeProject aggregation', () => {
  it('counts overdue only for open issues with a past due date', async () => {
    const past = Date.now() - 86400000;
    const future = Date.now() + 86400000;
    const { client } = createHarness({
      issues: [
        baseIssue({ _id: 'a', number: 1, priority: 1, status: 'status-todo', dueDate: past, estimation: '3' }),
        baseIssue({ _id: 'b', number: 2, priority: 1, status: 'status-done', dueDate: past }),
        baseIssue({ _id: 'c', number: 3, priority: 0, status: 'status-cancelled', dueDate: past }),
        baseIssue({ _id: 'd', number: 4, priority: 0, status: 'status-todo', dueDate: future }),
        baseIssue({ _id: 'e', number: 5, priority: 0, status: 'status-todo', reportedTime: '1.5' })
      ],
      milestones: [{ _id: 'ms-1', space: 'project-id', label: 'v1', status: 1, targetDate: Date.UTC(2026, 3, 1) }]
    });

    const summary = await client.summarizeProject('proj');

    assert.equal(summary.totalIssues, 5);
    assert.deepEqual(summary.overdue.issues.map(item => item.id), ['PROJ-1']);
    assert.equal(summary.overdue.count, 1);
    assert.deepEqual(summary.byStatus, { Todo: 3, Done: 1, Cancelled: 1 });
    assert.deepEqual(summary.byPriority, { Urgent: 2, 'No Priority': 3 });
    assert.deepEqual(summary.timeTracking, { totalEstimatedHours: 3, totalReportedHours: 1.5 });
    assert.deepEqual(summary.milestones, [{ name: 'v1', status: 'In Progress', targetDate: '2026-04-01' }]);
  });
});

describe('listIssues and getIssue projection', () => {
  it('combines every resolved filter into one issue query', async () => {
    const { client, select } = createHarness({
      issues: [baseIssue({ status: 'status-progress', priority: 3, milestone: 'ms-1' })],
      milestones: [{ _id: 'ms-1', space: 'project-id', label: 'v1', status: 0 }]
    });

    await client.listIssues('proj', 'in progress', 'medium', undefined, 'V1');

    assert.deepEqual(select('findAll', tracker.class.Issue).map(call => call.query), [{
      space: 'project-id',
      priority: 3,
      status: 'status-progress',
      milestone: 'ms-1'
    }]);
  });

  it('applies the smaller page ceiling once an expansion is requested', async () => {
    const { client } = createHarness({ issues: [baseIssue()] });

    await assert.rejects(
      () => client.listIssues('PROJ', undefined, undefined, undefined, undefined, 100, undefined,
        { include: ['comments'] }),
      /integer from 1 to 50/
    );
    const detail = await client.listIssues('PROJ', undefined, undefined, undefined, undefined, 50, undefined,
      { include: ['comments'] });
    const plain = await client.listIssues('PROJ', undefined, undefined, undefined, undefined, 100);
    assert.equal(detail.count, 1);
    assert.equal(plain.count, 1);
  });

  it('returns exactly the requested fields in their wire format', async () => {
    const { client } = createHarness({
      issues: [baseIssue({
        status: 'status-done',
        dueDate: Date.UTC(2026, 3, 1),
        estimation: '3',
        reportedTime: '1.5'
      })]
    });

    const page = await client.listIssues('PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { fields: ['status', 'dueDate', 'estimation', 'reportedTime'] });

    assert.deepEqual(page.items, [{
      id: 'PROJ-1',
      status: 'Done',
      dueDate: '2026-04-01',
      estimation: 3,
      reportedTime: 1.5
    }]);
  });

  it('rolls child time up one level, as the Huly UI does', async () => {
    // An issue's own reportedTime counts only time booked directly on it —
    // Huly never rolls descendants into it. The per-child totals live in the
    // server-maintained childInfo array, and the UI sums one level from there.
    const { client } = createHarness({
      issues: [baseIssue({
        estimation: 2,
        reportedTime: 0.5,
        subIssues: 2,
        childInfo: [
          { childId: 'kid-1', estimation: 3, reportedTime: 1.5 },
          { childId: 'kid-2', estimation: '4', reportedTime: '2' }
        ]
      })]
    });

    const page = await client.listIssues('PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { fields: ['estimation', 'reportedTime', 'estimationTotal', 'reportedTimeTotal'] });

    assert.deepEqual(page.items, [{
      id: 'PROJ-1',
      estimation: 2,
      reportedTime: 0.5,
      estimationTotal: 9,
      reportedTimeTotal: 4
    }]);
  });

  it('omits the rollup entirely for an issue with no children', async () => {
    const { client } = createHarness({ issues: [baseIssue({ estimation: 2, reportedTime: 0.5 })] });

    const page = await client.listIssues('PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { fields: ['estimation', 'reportedTime', 'estimationTotal', 'reportedTimeTotal'] });

    // A leaf must cost no extra bytes against the response budgets.
    assert.deepEqual(page.items, [{ id: 'PROJ-1', estimation: 2, reportedTime: 0.5 }]);
  });

  it('derives completedAt only from done-category statuses', async () => {
    const harness = createHarness();
    const readWith = async status => {
      harness.client._parseAndFindIssue = async () => ({
        project: harness.state.projects[0],
        issue: baseIssue({ status, modifiedOn: 4242 })
      });
      return harness.client.getIssue('PROJ-1', { fields: ['completedAt'], include: [] });
    };

    assert.deepEqual(await readWith('status-done'), { id: 'PROJ-1', completedAt: 4242 });
    assert.deepEqual(await readWith('status-cancelled'), { id: 'PROJ-1', completedAt: null });
    assert.deepEqual(await readWith('status-progress'), { id: 'PROJ-1', completedAt: null });
  });
});
