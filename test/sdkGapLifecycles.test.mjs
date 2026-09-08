import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HulyClient } from '../src/client.mjs';
import { createMcpServer } from '../src/mcpShared.mjs';

const require = createRequire(import.meta.url);
const core = require('@hcengineering/core').default;
const tracker = require('@hcengineering/tracker').default;
const task = require('@hcengineering/task').default;
const tags = require('@hcengineering/tags').default;
const contact = require('@hcengineering/contact').default;
const { jsonToPmNode, markupToJSON } = require('@hcengineering/text');

function harness() {
  const project = {
    _id: 'p1', _class: tracker.class.Project, space: core.space.Space, identifier: 'PROJ',
    type: 'pt1', members: ['account-ada', 'account-grace'], owners: ['account-ada'],
    defaultIssueStatus: 's1', defaultTimeReportDay: 'CurrentWorkDay',
    'test:mixin:Roles': { role1: ['account-ada', 'account-grace'] }
  };
  const store = new Map([
    [tracker.class.Project, [project, { ...project, _id: 'p2', identifier: 'OTHER' }]],
    [contact.mixin.Employee, [
      { _id: 'e1', name: 'Ada Lovelace', personUuid: 'account-ada', active: true },
      { _id: 'e2', name: 'Grace Hopper', personUuid: 'account-grace', active: true }
    ]],
    [task.class.ProjectType, [{ _id: 'pt1', tasks: ['t1'], targetClass: 'test:mixin:Roles' }]],
    [task.class.TaskType, [{ _id: 't1', name: 'Task', parent: 'pt1', ofClass: tracker.class.Issue, statuses: ['s1', 's2'] }]],
    [tracker.class.IssueStatus, [{ _id: 's1', name: 'Todo' }, { _id: 's2', name: 'Done' }]],
    [core.class.Role, [{ _id: 'role1', attachedTo: 'pt1' }]],
    [tracker.class.Component, [{ _id: 'c1', space: 'p1', label: 'API' }]],
    [tracker.class.Milestone, [{ _id: 'm1', space: 'p1', label: 'v1' }]],
    [tags.class.TagElement, [{ _id: 'tag1', targetClass: tracker.class.Issue, title: 'release' }]],
    [tracker.class.Issue, [{ _id: 'i1', _class: tracker.class.Issue, space: 'p1', title: 'Related' }]],
    [tracker.class.IssueTemplate, []]
  ]);
  const writes = [];
  const documents = ref => store.get(ref) ?? [];
  const matches = (doc, query) => Object.entries(query).every(([key, value]) =>
    value?.$in ? value.$in.includes(doc[key]) : doc[key] === value);
  const sdk = {
    findAll: async (ref, query = {}) => structuredClone(documents(ref).filter(doc => matches(doc, query))),
    findOne: async (ref, query = {}) => structuredClone(documents(ref).find(doc => matches(doc, query))),
    createDoc: async (ref, space, data, id) => {
      writes.push({ method: 'createDoc', ref, space, data });
      if (!store.has(ref)) store.set(ref, []);
      documents(ref).push({ _id: id, _class: ref, space, createdOn: writes.length, ...data });
    },
    updateDoc: async (ref, space, id, data) => {
      writes.push({ method: 'updateDoc', ref, space, id, data });
      Object.assign(documents(ref).find(doc => doc._id === id), data);
    },
    createMixin: async () => {},
    removeDoc: async (ref, space, id) => {
      writes.push({ method: 'removeDoc', ref, space, id });
      store.set(ref, documents(ref).filter(doc => doc._id !== id));
    },
    apply: () => {
      const pending = [];
      return {
        updateDoc: async (...args) => pending.push(() => sdk.updateDoc(...args)),
        updateMixin: async (id, ref, space, mixin, data) => pending.push(() => {
          writes.push({ method: 'updateMixin', id, ref, space, mixin, data });
          Object.assign(documents(ref).find(doc => doc._id === id)[mixin], data);
        }),
        commit: async () => { for (const apply of pending) await apply(); return { result: true }; }
      };
    }
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'test' });
  client._accountUuid = 'account-ada';
  client._getClient = async () => sdk;
  return { client, sdk, store, project, writes };
}

describe('stored Huly issue templates', () => {
  it('round-trips every template field, stores valid markup and actual model references, and deletes', async () => {
    const { client, store } = harness();
    const fields = {
      title: ' Release ', description: '**Ship**', priority: 'high', assignee: 'Ada Lovelace',
      component: 'API', milestone: 'v1', estimation: 3.5, labels: ['release'], type: 'Task'
    };
    const created = await client.createIssueTemplate('PROJ', {
      ...fields, children: [{ ...fields, id: 'child-1', title: 'Child' }],
      relations: [{ id: 'i1', objectClass: tracker.class.Issue }]
    });
    const raw = store.get(tracker.class.IssueTemplate)[0];
    assert.equal(raw.space, 'p1');
    assert.equal(raw.assignee, 'e1');
    assert.equal(raw.component, 'c1');
    assert.equal(raw.milestone, 'm1');
    assert.equal(raw.kind, 't1');
    assert.equal(raw.children[0].id, 'child-1');
    assert.deepEqual(raw.labels, ['tag1']);
    assert.deepEqual(raw.relations, [{ _id: 'i1', _class: tracker.class.Issue }]);
    for (const doc of [raw, ...raw.children]) jsonToPmNode(markupToJSON(doc.description)).check();
    const read = await client.getIssueTemplate('PROJ', created.id);
    for (const [field, expected] of Object.entries({ ...fields, title: 'Release', priority: 'High' })) {
      assert.deepEqual(read[field], expected, field);
    }
    await client.updateIssueTemplate('PROJ', created.id, {
      title: 'Renamed', description: '', priority: 'none', assignee: '', component: '', milestone: '',
      estimation: 0, labels: [], type: '', children: [], relations: []
    });
    const updated = await client.getIssueTemplate('PROJ', created.id);
    assert.equal(updated.title, 'Renamed');
    assert.equal(updated.description, '');
    assert.equal(updated.assignee, null);
    assert.equal(updated.component, null);
    assert.equal(updated.milestone, null);
    assert.equal(updated.estimation, 0);
    assert.equal(updated.type, 'Task');
    for (const field of ['labels', 'children', 'relations']) assert.deepEqual(updated[field], []);
    assert.equal((await client.listIssueTemplates('PROJ')).items[0].id, created.id);
    await client.deleteIssueTemplate('PROJ', created.id);
    await assert.rejects(() => client.getIssueTemplate('PROJ', created.id), /not found/);
    assert.deepEqual((await client.listIssueTemplates('PROJ')).items, []);
    assert.equal(store.get(tracker.class.Issue).length, 1, 'Deleting a template must retain existing issues');
  });

  it('preserves omitted fields and child IDs while replacing children', async () => {
    const { client } = harness();
    const created = await client.createIssueTemplate('PROJ', { title: 'Keep', description: 'Body', children: [{ title: 'Child' }] });
    const before = await client.getIssueTemplate('PROJ', created.id);
    await client.updateIssueTemplate('PROJ', created.id, { children: [{ id: before.children[0].id, title: 'Edited' }] });
    const after = await client.getIssueTemplate('PROJ', created.id);
    assert.equal(after.description, 'Body');
    assert.equal(after.title, 'Keep');
    assert.equal(after.children[0].id, before.children[0].id);
    assert.equal(after.children[0].title, 'Edited');
  });

  it('rejects invalid nested data before writing and scopes every operation to its project', async () => {
    const { client, writes } = harness();
    for (const invalid of [
      { title: '' }, { title: 'Bad', priority: 'critical' },
      { title: 'Bad', labels: ['missing'] }, { title: 'Bad', children: [{ title: 'Child', component: 'missing' }] },
      { title: 'Bad', children: null }, { title: 'Bad', relations: null },
      { title: 'Bad', relations: [{ id: 'i1' }] },
      { title: 'Bad', children: [{ title: 'Child', status: 'Ignored before' }] },
      { title: 'Bad', children: [{ id: 'same', title: 'A' }, { id: 'same', title: 'B' }] }
    ]) await assert.rejects(() => client.createIssueTemplate('PROJ', invalid));
    assert.equal(writes.length, 0);
    const created = await client.createIssueTemplate('PROJ', { title: 'Scoped' });
    const count = writes.length;
    await assert.rejects(() => client.getIssueTemplate('OTHER', created.id), /not found/);
    await assert.rejects(() => client.updateIssueTemplate('OTHER', created.id, { title: 'Wrong' }), /not found/);
    await assert.rejects(() => client.deleteIssueTemplate('OTHER', created.id), /not found/);
    assert.equal(writes.length, count);
  });

  it('paginates stored templates without losing or duplicating IDs', async () => {
    const { client } = harness();
    for (const title of ['A', 'B', 'C']) await client.createIssueTemplate('PROJ', { title });
    const first = await client.listIssueTemplates('PROJ', { limit: 2 });
    const second = await client.listIssueTemplates('PROJ', { limit: 2, cursor: first.nextCursor });
    assert.equal(new Set([...first.items, ...second.items].map(doc => doc.id)).size, 3);
    assert.equal(second.nextCursor, undefined);
  });
});

describe('project membership and defaults', () => {
  it('uses account UUIDs for membership and reads names in single and list results', async () => {
    const { client, project } = harness();
    await client.updateProject('PROJ', { owners: ['Grace Hopper'], members: ['account-grace', 'Grace Hopper'] });
    assert.deepEqual(project.members, ['account-grace']);
    assert.deepEqual(project.owners, ['account-grace']);
    assert.deepEqual(project['test:mixin:Roles'].role1, ['account-grace']);
    const single = await client.getProject('PROJ', { include: ['members', 'owners'] });
    assert.deepEqual(single.members, ['Grace Hopper']);
    assert.deepEqual(single.owners, ['Grace Hopper']);
    const listed = (await client.listProjects({ include: ['members', 'owners'] })).items.find(p => p.identifier === 'PROJ');
    assert.deepEqual(listed.members, single.members);
    assert.deepEqual(listed.owners, single.owners);
    await client.updateProject('PROJ', { members: [] });
    assert.deepEqual(project.members, []);
    assert.deepEqual(project['test:mixin:Roles'].role1, []);
    await client.updateProject('PROJ', { owners: ['Ada Lovelace'] });
    assert.deepEqual(project.members, ['account-ada']);
  });

  it('rejects empty ownership, inaccessible private projects and invalid identities without changing fields', async () => {
    const { client, project, writes, store } = harness();
    for (const fields of [
      { owners: [] }, { members: ['missing'] }, { isPrivate: true, members: ['Grace Hopper'] },
      { defaultIssueStatus: 'Unknown' }, { defaultTimeReportDay: 'Yesterday' }
    ]) await assert.rejects(() => client.updateProject('PROJ', { name: 'Should not change', ...fields }));
    store.get(contact.mixin.Employee).push({ _id: 'e3', name: 'Ada Lovelace', personUuid: 'other-ada', active: true });
    await assert.rejects(() => client.updateProject('PROJ', { owners: ['Ada Lovelace'] }), /Ambiguous/);
    assert.equal(writes.length, 0);
    assert.equal(project.name, undefined);
  });

  it('creates with supplied settings, retains the creator and updates/read defaults', async () => {
    const { client, store } = harness();
    await client.createProject('NEW', 'New', '', true, 'pt1', {
      members: ['Grace Hopper'], owners: ['Grace Hopper'], defaultAssignee: 'Grace Hopper',
      defaultIssueStatus: 'Done', defaultTimeReportDay: 'PreviousWorkDay'
    });
    const created = store.get(tracker.class.Project).find(p => p.identifier === 'NEW');
    assert.deepEqual(created.members, ['account-ada', 'account-grace']);
    assert.deepEqual(created.owners, ['account-ada', 'account-grace']);
    assert.equal(created.defaultAssignee, 'e2');
    assert.equal(created.defaultIssueStatus, 's2');
    assert.equal(created.defaultTimeReportDay, 'PreviousWorkDay');
    await client.updateProject('NEW', { defaultAssignee: '', defaultIssueStatus: 'Todo', defaultTimeReportDay: 'CurrentWorkDay' });
    const read = await client.getProject('NEW', { include: ['defaults'] });
    assert.equal(read.defaultAssignee, null);
    assert.equal(read.defaultIssueStatus, 'Todo');
    assert.equal(read.defaultTimeReportDay, 'CurrentWorkDay');
  });
});

describe('SDK field exposure', () => {
  it('advertises the same mutable template and project settings for creation and update', () => {
    const tools = new Map(createMcpServer().TOOLS.map(tool => [tool.name, tool.inputSchema.properties]));
    const fields = name => Object.keys(tools.get(name)).filter(key => !['workspace', 'project', 'templateId'].includes(key)).sort();
    assert.deepEqual(fields('create_issue_template'), fields('update_issue_template'));
    for (const name of ['create_project', 'update_project']) {
      for (const key of ['members', 'owners', 'defaultAssignee', 'defaultIssueStatus', 'defaultTimeReportDay']) {
        assert.ok(tools.get(name)[key], `${name}.${key}`);
      }
    }
  });
});
