import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const core = require('@hcengineering/core').default;
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const task = require('@hcengineering/task').default;
const contact = require('@hcengineering/contact').default;

const SPACE = core.space.Space;

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value !== null && typeof value === 'object' && Array.isArray(value.$in)) {
      return value.$in.includes(doc[key]);
    }
    return doc[key] === value;
  });
}

// A `tracker:project:*` id is a model-level space: Huly resolves the write and
// silently drops the document. Modelling that here means a write aimed at the
// wrong space disappears from the store instead of looking like a success.
const discardsWrites = space => String(space).startsWith('tracker:project:');

function createHarness(seed = {}) {
  const store = new Map([
    [tracker.class.Project, seed.projects ?? []],
    [tracker.class.Component, seed.components ?? []],
    [tracker.class.Milestone, seed.milestones ?? []],
    [tracker.class.Issue, seed.issues ?? []],
    [tracker.class.IssueStatus, seed.statuses ?? []],
    [tags.class.TagElement, seed.labels ?? []],
    [tags.class.TagReference, seed.tagRefs ?? []],
    [task.class.TaskType, seed.taskTypes ?? []],
    [task.class.ProjectType, seed.projectTypes ?? []],
    [contact.mixin.Employee, seed.employees ?? []]
  ]);
  const calls = {
    createDoc: [], updateDoc: [], removeDoc: [],
    addCollection: [], removeCollection: [], createMixin: []
  };
  const docsOf = classRef => {
    if (!store.has(classRef)) store.set(classRef, []);
    return store.get(classRef);
  };

  const sdk = {
    findAll: async (classRef, query = {}) => docsOf(classRef).filter(doc => matches(doc, query)),
    findOne: async (classRef, query = {}) => docsOf(classRef).find(doc => matches(doc, query)) ?? null,
    createDoc: async (classRef, space, data, id) => {
      calls.createDoc.push({ classRef, space, data, id });
      if (!discardsWrites(space)) docsOf(classRef).push({ _id: id, space, ...data });
      return id;
    },
    updateDoc: async (classRef, space, id, data) => {
      calls.updateDoc.push({ classRef, space, id, data });
      const doc = docsOf(classRef).find(item => item._id === id);
      if (doc) Object.assign(doc, data);
    },
    removeDoc: async (classRef, space, id) => {
      calls.removeDoc.push({ classRef, space, id });
      const docs = docsOf(classRef);
      const index = docs.findIndex(item => item._id === id);
      if (index >= 0) docs.splice(index, 1);
    },
    addCollection: async (classRef, space, attachedTo, attachedToClass, collection, data) => {
      calls.addCollection.push({ classRef, space, attachedTo, attachedToClass, collection, data });
    },
    removeCollection: async (classRef, space, id, attachedTo, attachedToClass, collection) => {
      calls.removeCollection.push({ classRef, space, id, attachedTo, attachedToClass, collection });
    },
    createMixin: async (...args) => { calls.createMixin.push(args); }
  };

  const client = new HulyClient({
    url: 'https://huly.example.test', token: 't', workspace: 'w'
  });
  client._accountUuid = 'account-uuid';
  client._getClient = async () => sdk;
  return { client, calls, store };
}

// The built-in project is listed first so that any "pick the first/only
// project" regression selects a model-level space and gets caught.
function projectFixtures() {
  return [
    { _id: 'tracker:project:DefaultProject', space: SPACE, identifier: 'START', name: 'Start', type: 'pt-alpha', createdOn: 3 },
    { _id: 'alpha-space', space: SPACE, identifier: 'ALPHA', name: 'Alpha', type: 'pt-alpha', members: ['emp-1'], createdOn: 2 },
    { _id: 'beta-space', space: SPACE, identifier: 'BETA', name: 'Beta', type: 'pt-beta', members: [], createdOn: 1 }
  ];
}

function taxonomyFixtures() {
  return {
    projectTypes: [
      { _id: 'pt-alpha', name: 'Classic', tasks: ['tt-issue', 'tt-epic'], statuses: ['s-todo', 's-epic'] },
      { _id: 'pt-beta', name: 'Bugs', tasks: ['tt-bug'], statuses: ['s-bug'] }
    ],
    taskTypes: [
      { _id: 'tt-issue', name: 'Issue', ofClass: tracker.class.Issue, statuses: ['s-todo'] },
      { _id: 'tt-epic', name: 'Epic', ofClass: tracker.class.Issue, statuses: ['s-epic'] },
      { _id: 'tt-bug', name: 'Bug', ofClass: tracker.class.Issue, statuses: ['s-bug'] }
    ],
    statuses: [
      { _id: 's-todo', name: 'Todo', category: 'task:statusCategory:ToDo' },
      { _id: 's-epic', name: 'Epic Ready', category: 'task:statusCategory:Active' },
      { _id: 's-bug', name: 'Bug Triage', category: 'task:statusCategory:ToDo' },
      { _id: 's-loose', name: 'Orphan', category: 'task:statusCategory:Active' }
    ]
  };
}

describe('taxonomy writes land in the owning space', () => {
  it('creates a component in the identified project, not the workspace default', async () => {
    const { client, calls, store } = createHarness({ projects: projectFixtures() });

    const result = await client.createComponent('beta', 'API', 'Gateway', undefined, 'plain');

    assert.equal(calls.createDoc.length, 1);
    assert.equal(calls.createDoc[0].classRef, tracker.class.Component);
    assert.equal(calls.createDoc[0].space, 'beta-space');
    assert.equal(calls.createDoc[0].data.label, 'API');
    assert.equal(result.id, calls.createDoc[0].id);
    // A component written to a model-level space is discarded server-side.
    assert.equal(store.get(tracker.class.Component).length, 1);
  });

  it('scopes the milestone duplicate probe to the target project and stores a numeric status', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      milestones: [{ _id: 'ms-alpha', space: 'alpha-space', label: 'v1', status: 0, targetDate: 1 }]
    });

    const result = await client.createMilestone('BETA', 'v1', 'ship it', '2026-06-01', 'completed');

    assert.notEqual(result.id, 'ms-alpha', 'a same-named milestone in another project must not block creation');
    assert.equal(calls.createDoc[0].space, 'beta-space');
    assert.equal(calls.createDoc[0].data.label, 'v1');
    assert.equal(calls.createDoc[0].data.status, 2, 'status must reach the SDK as the numeric enum');
    assert.equal(calls.createDoc[0].data.targetDate, new Date('2026-06-01').getTime());
    assert.equal(result.status, 'Completed');
    assert.equal(result.targetDate, '2026-06-01');
  });

  it('deletes the object owned by the named project when names collide across projects', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      components: [
        { _id: 'comp-alpha', space: 'alpha-space', label: 'API' },
        { _id: 'comp-beta', space: 'beta-space', label: 'API' }
      ],
      milestones: [
        { _id: 'ms-alpha', space: 'alpha-space', label: 'v1', status: 0 },
        { _id: 'ms-beta', space: 'beta-space', label: 'v1', status: 0 }
      ]
    });

    await client.deleteComponent('BETA', 'api');
    await client.deleteMilestone('BETA', 'V1');

    assert.deepEqual(
      calls.removeDoc.map(call => [call.space, call.id]),
      [['beta-space', 'comp-beta'], ['beta-space', 'ms-beta']]
    );
  });

  it('addresses project mutations through the project space, not the project id', async () => {
    const { client, calls } = createHarness({ projects: projectFixtures() });

    await client.updateProject('alpha', { name: 'Renamed' });
    await client.archiveProject('alpha');
    await client.deleteProject('alpha');

    assert.deepEqual(calls.updateDoc.map(call => call.space), [SPACE, SPACE]);
    assert.deepEqual(calls.updateDoc.map(call => call.id), ['alpha-space', 'alpha-space']);
    assert.equal(calls.removeDoc[0].space, SPACE);
    assert.equal(calls.removeDoc[0].id, 'alpha-space');
  });

  it('updates a label through the label document own space', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      labels: [{
        _id: 'tag-1', space: 'alpha-space', title: 'Alpha',
        targetClass: tracker.class.Issue, color: 3
      }]
    });

    const result = await client.updateLabel('Alpha', { newName: 'Renamed', color: 'teal' });

    assert.equal(calls.updateDoc[0].classRef, tags.class.TagElement);
    assert.equal(calls.updateDoc[0].space, 'alpha-space');
    assert.deepEqual(calls.updateDoc[0].data, { title: 'Renamed', color: 12 });
    assert.deepEqual(result.updated, ['title', 'color']);
  });

  it('attaches labels in the issue project space and reuses an existing tag element', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      issues: [{ _id: 'issue-1', space: 'alpha-space', number: 1 }],
      labels: [{
        _id: 'tag-1', space: 'beta-space', title: 'bug',
        targetClass: tracker.class.Issue, color: 3
      }]
    });

    await client.addLabel('ALPHA-1', 'bug');
    assert.equal(calls.createDoc.length, 0, 'an existing tag element must be reused, not duplicated');
    assert.equal(calls.addCollection[0].space, 'alpha-space');
    assert.equal(calls.addCollection[0].attachedTo, 'issue-1');
    assert.deepEqual(calls.addCollection[0].data, { title: 'bug', color: 3, tag: 'tag-1' });

    await client.addLabel('ALPHA-1', 'fresh');
    assert.equal(calls.createDoc.length, 1);
    assert.equal(calls.createDoc[0].classRef, tags.class.TagElement);
    assert.equal(calls.createDoc[0].space, 'alpha-space');
    assert.equal(calls.addCollection[1].data.tag, calls.createDoc[0].id);
  });

  it('removes only the tag reference attached to the addressed issue', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      issues: [{ _id: 'issue-1', space: 'alpha-space', number: 1 }],
      tagRefs: [
        {
          _id: 'ref-1', space: 'alpha-space', title: 'bug', tag: 'tag-1',
          attachedTo: 'issue-1', attachedToClass: tracker.class.Issue, collection: 'labels'
        },
        {
          _id: 'ref-2', space: 'beta-space', title: 'bug', tag: 'tag-1',
          attachedTo: 'issue-2', attachedToClass: tracker.class.Issue, collection: 'labels'
        }
      ]
    });

    await client.removeLabel('ALPHA-1', 'BUG');
    assert.deepEqual(calls.removeCollection.map(call => call.id), ['ref-1']);
    assert.equal(calls.removeCollection[0].space, 'alpha-space');

    const missing = await client.removeLabel('ALPHA-1', 'nope');
    assert.match(missing.message, /not found on issue/);
    assert.equal(calls.removeCollection.length, 1, 'an unmatched name must not detach anything');
  });

  it('refuses a milestone owned by a different project and writes nothing', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      issues: [{ _id: 'issue-1', space: 'alpha-space', number: 1 }],
      milestones: [{ _id: 'ms-beta', space: 'beta-space', label: 'v2', status: 0 }]
    });

    await assert.rejects(() => client.setMilestone('ALPHA-1', 'v2'), /Milestone "v2" not found/);
    assert.equal(calls.updateDoc.length, 0);
  });
});

describe('advertised taxonomy parameters reach the SDK', () => {
  it('forwards project privacy as `private`, including an explicit false', async () => {
    // update_project advertises `isPrivate`; a handler reading `private`
    // instead dropped privacy changes silently.
    const { client, calls } = createHarness({ projects: projectFixtures() });

    const result = await client.updateProject('ALPHA', { isPrivate: false });

    assert.deepEqual(calls.updateDoc[0].data, { private: false });
    assert.deepEqual(result.updated, ['private']);
  });

  it('resolves a default assignee by name and clears it on an empty string', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      employees: [{ _id: 'emp-1', name: 'Ada Lovelace', active: true }]
    });

    await client.updateProject('ALPHA', { defaultAssignee: 'ada lovelace' });
    assert.equal(calls.updateDoc[0].data.defaultAssignee, 'emp-1');

    await client.updateProject('ALPHA', { defaultAssignee: '' });
    assert.ok('defaultAssignee' in calls.updateDoc[1].data, 'clearing must send the field, not omit it');
    assert.equal(calls.updateDoc[1].data.defaultAssignee, null);
  });

  it('unarchives when archived is explicitly false', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures().map(project => ({ ...project, archived: true }))
    });

    const result = await client.archiveProject('ALPHA', false);

    assert.equal(calls.updateDoc[0].data.archived, false, 'the archived=true default must not override an explicit false');
    assert.equal(result.archived, false);
  });

  it('renames a component through `label` and clears its lead on an empty string', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      components: [{ _id: 'comp-alpha', space: 'alpha-space', label: 'API', lead: 'emp-1' }],
      employees: [{ _id: 'emp-1', name: 'Ada Lovelace', active: true }]
    });

    const result = await client.updateComponent('ALPHA', 'api', { name: 'Gateway', lead: '' });

    assert.equal(calls.updateDoc[0].space, 'alpha-space');
    assert.equal(calls.updateDoc[0].id, 'comp-alpha');
    assert.equal(calls.updateDoc[0].data.label, 'Gateway');
    assert.ok(!('name' in calls.updateDoc[0].data), 'a Component stores its name in `label`');
    assert.equal(calls.updateDoc[0].data.lead, null);
    assert.equal(result.name, 'Gateway');
  });

  it('clears and sets an issue milestone with an explicit value', async () => {
    const { client, calls } = createHarness({
      projects: projectFixtures(),
      issues: [{ _id: 'issue-1', space: 'alpha-space', number: 1 }],
      milestones: [{ _id: 'ms-alpha', space: 'alpha-space', label: 'v1', status: 0 }]
    });

    await client.setMilestone('ALPHA-1', '');
    assert.ok('milestone' in calls.updateDoc[0].data, 'clearing must send milestone, not an undefined no-op');
    assert.equal(calls.updateDoc[0].data.milestone, null);

    await client.setMilestone('ALPHA-1', 'V1');
    assert.equal(calls.updateDoc[1].space, 'alpha-space');
    assert.equal(calls.updateDoc[1].data.milestone, 'ms-alpha');
  });

  it('coerces label colours to palette numbers before writing', async () => {
    const { client, calls } = createHarness({ projects: projectFixtures() });

    await client.createLabel('gold-label', 'gold');
    await client.createLabel('rgb-label', 0xBB83FC);
    await client.createLabel('default-label');

    assert.deepEqual(calls.createDoc.map(call => call.data.color), [18, 0xBB83FC, 9]);
    assert.deepEqual(
      calls.createDoc.map(call => call.data.targetClass),
      Array(3).fill(tracker.class.Issue)
    );
  });
});

describe('taxonomy filters fail closed', () => {
  it('rejects an unknown milestone status instead of returning every milestone', async () => {
    const { client } = createHarness({
      projects: projectFixtures(),
      milestones: [
        { _id: 'ms-1', space: 'alpha-space', label: 'v1', status: 0, createdOn: 3 },
        { _id: 'ms-2', space: 'alpha-space', label: 'v2', status: 1, createdOn: 2 },
        { _id: 'ms-3', space: 'beta-space', label: 'v3', status: 1, createdOn: 1 }
      ]
    });

    await assert.rejects(() => client.listMilestones('ALPHA', 'done'), /Milestone status not found: done/);

    const page = await client.listMilestones('ALPHA', 'in progress');
    assert.deepEqual(page.items.map(item => item.name), ['v2'],
      'the filter must exclude other statuses and other projects');
  });

  it('scopes statuses to the project type and then to the task type', async () => {
    const { client } = createHarness({ projects: projectFixtures(), ...taxonomyFixtures() });

    const scoped = await client.listStatuses('ALPHA');
    assert.deepEqual(scoped.items.map(item => item.id).sort(), ['s-epic', 's-todo'],
      'statuses of other project types and unattached statuses must stay out');

    const byTaskType = await client.listStatuses('ALPHA', 'epic');
    assert.deepEqual(byTaskType.items.map(item => item.id), ['s-epic']);

    assert.equal((await client.getStatus('ALPHA', 'Epic Ready')).id, 's-epic');
    await assert.rejects(() => client.getStatus('ALPHA', 'Bug Triage'), /Status not found/);
  });

  it('keeps task type lookups inside the project own project type', async () => {
    const { client } = createHarness({ projects: projectFixtures(), ...taxonomyFixtures() });

    const page = await client.listTaskTypes('ALPHA');
    assert.deepEqual(page.items.map(item => item.name).sort(), ['Epic', 'Issue']);

    assert.equal((await client.getTaskType('BETA', 'bug')).id, 'tt-bug');
    await assert.rejects(() => client.getTaskType('ALPHA', 'Bug'), /Task type not found: "Bug"/);
  });

  it('keeps component reads inside the addressed project', async () => {
    const { client } = createHarness({
      projects: projectFixtures(),
      components: [
        { _id: 'comp-alpha', space: 'alpha-space', label: 'API', createdOn: 2 },
        { _id: 'comp-beta', space: 'beta-space', label: 'API', createdOn: 1 }
      ]
    });

    const page = await client.listComponents('BETA');
    assert.deepEqual(page.items.map(item => item.id), ['comp-beta']);
    assert.equal((await client.getComponent('BETA', 'api')).id, 'comp-beta');
  });

  it('groups nested project taxonomy by owning project', async () => {
    const { client } = createHarness({
      projects: projectFixtures(),
      components: [
        { _id: 'comp-alpha', space: 'alpha-space', label: 'API', lead: 'emp-1', createdOn: 2 },
        { _id: 'comp-beta', space: 'beta-space', label: 'Web', lead: null, createdOn: 1 }
      ],
      milestones: [{ _id: 'ms-beta', space: 'beta-space', label: 'v3', status: 1, createdOn: 1 }],
      employees: [{ _id: 'emp-1', name: 'Ada Lovelace', active: true }]
    });

    const page = await client.listProjects({ include: ['components', 'milestones', 'members'] });
    const byIdentifier = new Map(page.items.map(item => [item.identifier, item]));

    assert.deepEqual(byIdentifier.get('ALPHA').components, [
      { name: 'API', description: '', lead: 'Ada Lovelace' }
    ]);
    assert.deepEqual(byIdentifier.get('ALPHA').milestones, []);
    assert.deepEqual(byIdentifier.get('BETA').milestones, [
      { name: 'v3', status: 'In Progress', targetDate: null }
    ]);
    assert.deepEqual(byIdentifier.get('ALPHA').members, ['Ada Lovelace']);
  });
});

describe('project type resolution', () => {
  it('refuses to guess a project type and scopes the default status to the chosen one', async () => {
    const { client, calls } = createHarness({ projects: projectFixtures(), ...taxonomyFixtures() });

    await assert.rejects(() => client.createProject('new', 'New'), /Specify projectType explicitly/);
    assert.equal(calls.createDoc.length, 0, 'an ambiguous project type must not create a project');

    await client.createProject('bugs', 'Bugs project', '', false, 'Bugs');

    assert.equal(calls.createDoc[0].data.type, 'pt-beta');
    assert.equal(calls.createDoc[0].data.defaultIssueStatus, 's-bug',
      'the default status must come from the resolved type, not the workspace-wide Todo');
    assert.equal(calls.createDoc[0].space, SPACE);
  });
});
