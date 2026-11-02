import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';
import { issueRank } from '../src/issueRank.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const task = require('@hcengineering/task').default;
const contactPlugin = require('@hcengineering/contact').default;
const chunter = require('@hcengineering/chunter').default;
const { makeRank } = require('@hcengineering/rank');

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
    findOne: async (classRef, query, options) => {
      calls.push({ method: 'findOne', classRef, query, options });
      const found = collectionFor(classRef).filter(record => matches(record, query));
      const [[field, order] = []] = Object.entries(options?.sort ?? {});
      if (field) found.sort((a, b) => order * (a[field] < b[field] ? -1 : a[field] > b[field] ? 1 : 0));
      return found[0] ?? null;
    },
    findAll: async (classRef, query = {}, options) => {
      calls.push({ method: 'findAll', classRef, query, options });
      return collectionFor(classRef).filter(record => matches(record, query));
    },
    updateDoc: async (classRef, space, id, data, retrieve) => {
      calls.push({ method: 'updateDoc', classRef, space, id, data });
      const target = collectionFor(classRef).find(record => record._id === id);
      if (!target) return {};
      for (const [key, value] of Object.entries(data)) {
        if (key !== '$inc') {
          target[key] = value;
          continue;
        }
        for (const [field, delta] of Object.entries(value)) {
          target[field] = (target[field] ?? 0) + delta;
        }
      }
      // Like the server, return the updated document only when asked to retrieve it.
      return retrieve ? { object: { ...target } } : {};
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

    assert.deepEqual(write.data, {
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
      kind: 'task-type',
      rank: issueRank(undefined, 11)
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

  for (const [label, args, pattern] of [
    ['unknown assignee', [undefined, undefined, { assignee: 'Nobody' }], /Employee not found/],
    ['unknown component', [undefined, undefined, { component: 'Nope' }], /Component not found/],
    ['unknown milestone', [undefined, undefined, { milestone: 'Nope' }], /Milestone not found/],
    ['unknown task type', [undefined, 'Saga', {}], /Task type "Saga" not found/],
    ['invalid estimation', [undefined, undefined, { estimation: 'abc' }], /estimation must be a number/],
    ['invalid due date', [undefined, undefined, { dueDate: 'someday' }], /Invalid date/],
    ['unknown priority', ['critical', undefined, {}], /Priority not found/],
    ['unknown status', [undefined, undefined, {}, 'Triage'], /Status "Triage" not found/]
  ]) {
    it(`spends no issue number when the input has an ${label}`, async () => {
      const { client, select, state } = createHarness();
      const [priority, type, extra, status] = args;

      await assert.rejects(
        () => client.createIssue('PROJ', 'Rejected', undefined, priority, status, undefined, type, extra),
        pattern
      );
      assert.equal(select('updateDoc', tracker.class.Project).length, 0);
      assert.equal(state.projects[0].sequence, 10);
      assert.equal(select('addCollection').length, 0);
    });
  }

  it('takes the issue number from the reservation result, not a separate read', async () => {
    const { client, select, state } = createHarness();
    // Another client creates an issue between this reservation and any follow-up read.
    const sdk = await client._getClient();
    const updateDoc = sdk.updateDoc;
    sdk.updateDoc = async (...args) => {
      const result = await updateDoc(...args);
      if (args[0] === tracker.class.Project) state.projects[0].sequence += 1;
      return result;
    };

    const result = await client.createIssue('PROJ', 'Raced');

    assert.equal(result.id, 'PROJ-11');
    assert.equal(select('addCollection', tracker.class.Issue)[0].data.number, 11);
  });

  it('fails instead of guessing a number when Huly does not return the updated project', async () => {
    const { client, select } = createHarness();
    const sdk = await client._getClient();
    sdk.updateDoc = async () => ({});

    await assert.rejects(() => client.createIssue('PROJ', 'Unnumbered'), /did not return the updated sequence/);
    assert.equal(select('addCollection').length, 0);
  });

  it('reports the status and priority it stored, named as reads name them', async () => {
    const { client, select } = createHarness({ projects: [baseProject({ defaultIssueStatus: 'status-progress' })] });

    const result = await client.createIssue('PROJ', 'Defaults', undefined, 'HIGH');

    assert.equal(select('addCollection', tracker.class.Issue)[0].data.status, 'status-progress');
    assert.equal(result.status, 'In Progress', 'must not claim Todo when the project default is another status');
    assert.equal(result.priority, 'High');
  });

  it('defaults to a status in the chosen task type\'s workflow, not the project default outside it', async () => {
    const { client, select } = createHarness();

    // The project default is Todo, but the Bug workflow holds only Triage.
    const result = await client.createIssue('PROJ', 'A bug', undefined, undefined, undefined, undefined, 'Bug');

    assert.equal(select('addCollection', tracker.class.Issue)[0].data.status, 'status-triage');
    assert.equal(result.status, 'Triage');
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

  it('clears the assignee on a blank name without scanning members', async () => {
    const { client, select } = updateHarness();

    await client.updateIssue('PROJ-1', undefined, undefined, undefined, undefined, undefined, { assignee: '   ' });

    assert.deepEqual(select('updateDoc', tracker.class.Issue).map(call => call.data), [{ assignee: null }]);
    assert.equal(select('findAll', contactPlugin.mixin.Employee).length, 0);
  });

  it('stores the member id and refuses an unknown member without writing', async () => {
    const { client, select } = updateHarness();

    await client.updateIssue('PROJ-1', undefined, undefined, undefined, undefined, undefined, { assignee: 'ada lovelace' });
    assert.deepEqual(select('updateDoc', tracker.class.Issue).map(call => call.data), [{ assignee: 'emp-1' }]);

    await assert.rejects(
      () => client.updateIssue('PROJ-1', undefined, undefined, undefined, undefined, undefined, { assignee: 'Nobody' }),
      /Employee not found: Nobody/
    );
    assert.equal(select('updateDoc', tracker.class.Issue).length, 1);
  });

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

  it('clears every optional issue reference through update_issue', async () => {
    const { client, select } = updateHarness();

    await client.updateIssue('PROJ-1', undefined, undefined, undefined, undefined, undefined, {
      assignee: '', component: '   ', milestone: ''
    });

    const [update] = select('updateDoc', tracker.class.Issue);
    assert.deepEqual(update.data, { assignee: null, component: null, milestone: null });
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
        rank: issueRank(undefined, 21),
        attachedTo: 'dest-id',
        // status-review is not in the Task workflow, and neither is the destination's default (Triage), so the
        // issue lands on the first status of its own workflow rather than one borrowed from elsewhere.
        status: 'status-todo'
      }
    }]);
    assert.equal(result.newId, 'DEST-21');
  });

  it('ranks the moved issue after the last issue in the destination project', async () => {
    const harness = moveHarness();
    const lastRank = makeRank(makeRank(undefined, undefined), undefined);
    harness.state.issues.push(
      baseIssue({ _id: 'dest-a', space: 'dest-id', rank: makeRank(undefined, undefined) }),
      baseIssue({ _id: 'dest-b', space: 'dest-id', rank: lastRank }),
      // A higher rank in another project must not influence the destination order.
      baseIssue({ _id: 'other', space: 'other-id', rank: makeRank(lastRank, undefined) })
    );

    await harness.client.moveIssue('PROJ-1', 'dest');

    const [update] = harness.select('updateDoc', tracker.class.Issue);
    assert.equal(update.data.rank, issueRank(lastRank, 21));
  });

  it('spends no destination number when the move cannot be resolved', async () => {
    const harness = moveHarness({ kind: undefined });
    harness.state.projects[1].type = 'unconfigured-type';

    await assert.rejects(() => harness.client.moveIssue('PROJ-1', 'dest'), /No task types configured/);
    assert.equal(harness.select('updateDoc').length, 0);
    assert.equal(harness.state.projects[1].sequence, 20);
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

  it('numbers only the valid items, leaving no gaps for rejected ones', async () => {
    const { client, select } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'First' },
      { title: 'Bad status', status: 'Triage' },
      { title: 'Bad type', type: 'Saga' },
      { title: 'Bad priority', priority: 'critical' },
      { title: 'Bad estimation', estimation: 'abc' },
      { title: 'Bad due date', dueDate: 'someday' },
      { title: 'Bad component', component: 'Nope' },
      { title: 'Bad milestone', milestone: 'Nope' },
      { title: 'Second' }
    ]);

    assert.deepEqual(select('updateDoc', tracker.class.Project).map(call => call.data),
      [{ $inc: { sequence: 2 } }]);
    assert.deepEqual(result.created.map(item => item.id), ['PROJ-11', 'PROJ-12']);
    assert.equal(result.errors.length, 7);
    assert.ok(result.errors.every(item => item.input.title.startsWith('Bad ')));
    assert.deepEqual(
      select('addCollection', tracker.class.Issue).map(call => call.data.rank),
      [issueRank(undefined, 11), issueRank(undefined, 12)],
      'batch items share one position and are ordered by their numbers'
    );
  });

  it('ranks new issues after the last issue in their own project only', async () => {
    const last = makeRank(makeRank(undefined, undefined), undefined);
    const { client, select } = createHarness({
      issues: [
        baseIssue({ _id: 'a', rank: makeRank(undefined, undefined) }),
        baseIssue({ _id: 'b', rank: last }),
        baseIssue({ _id: 'other', space: 'other-project', rank: makeRank(last, undefined) })
      ]
    });

    await client.createIssue('PROJ', 'Single');
    await client.batchCreateIssues('PROJ', [{ title: 'Batch' }]);

    const [single, batch] = select('addCollection', tracker.class.Issue).map(call => call.data.rank);
    assert.equal(single, issueRank(last, 11));
    assert.equal(batch, issueRank(single, 12));
  });

  it('gives creates that race on the same last rank distinct ranks in number order', async () => {
    const { client, select } = createHarness({
      issues: [baseIssue({ rank: makeRank(undefined, undefined) })]
    });
    // Hold every last-rank read until all three callers have made one, so each computes its
    // rank from the same stale value, as concurrent sessions would.
    const sdk = await client._getClient();
    const findOne = sdk.findOne;
    const waiting = [];
    sdk.findOne = async (classRef, query, options) => {
      const result = await findOne(classRef, query, options);
      if (classRef === tracker.class.Issue && options?.sort?.rank) {
        await new Promise(resolve => {
          waiting.push(resolve);
          if (waiting.length === 3) waiting.forEach(release => release());
        });
      }
      return result;
    };

    await Promise.all([
      client.createIssue('PROJ', 'Session A'),
      client.createIssue('PROJ', 'Session B'),
      client.batchCreateIssues('PROJ', [{ title: 'Session C1' }, { title: 'Session C2' }])
    ]);

    const writes = select('addCollection', tracker.class.Issue)
      .map(call => ({ number: call.data.number, rank: call.data.rank }))
      .sort((a, b) => a.number - b.number);
    assert.deepEqual(writes.map(write => write.number), [11, 12, 13, 14]);
    assert.equal(new Set(writes.map(write => write.rank)).size, 4, 'no two issues may share a rank');
    const position = rank => rank.slice(0, rank.indexOf(':'));
    assert.equal(new Set(writes.map(write => position(write.rank))).size, 1,
      'every racing create computed the same position');
    assert.deepEqual(writes.map(write => write.rank), writes.map(write => write.rank).sort(),
      'rank order matches number order');
  });

  it('reserves nothing when every item is rejected', async () => {
    const { client, select, state } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'Bad assignee', assignee: 'Nobody' },
      { description: 'no title' }
    ]);

    assert.equal(result.total, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(select('updateDoc').length, 0);
    assert.equal(state.projects[0].sequence, 10);
  });

  it('checks each status against the workflow of the item\'s own task type', async () => {
    const { client, select } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'Bug in triage', type: 'Bug', status: 'Triage' },
      { title: 'Task in triage', status: 'Triage' }
    ]);

    assert.deepEqual(result.created.map(item => item.title), ['Bug in triage']);
    assert.deepEqual(result.errors.map(item => item.input.title), ['Task in triage']);
    const [write] = select('addCollection', tracker.class.Issue);
    assert.equal(write.data.kind, 'bug-type');
    assert.equal(write.data.status, 'status-triage');
  });

  it('defaults each batch item to a status in its own workflow and reports what it stored', async () => {
    const { client, select } = createHarness();

    const result = await client.batchCreateIssues('PROJ', [
      { title: 'Task item' },
      { title: 'Bug item', type: 'Bug', priority: 'urgent' }
    ]);

    assert.deepEqual(select('addCollection', tracker.class.Issue).map(call => call.data.status),
      ['status-todo', 'status-triage']);
    assert.deepEqual(result.created.map(item => [item.status, item.priority]),
      [['Todo', 'No Priority'], ['Triage', 'Urgent']]);
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
