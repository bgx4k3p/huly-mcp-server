/**
 * A getter must describe an item exactly as its list does, so callers never see two shapes for one thing.
 */
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const chunter = require('@hcengineering/chunter').default;
const task = require('@hcengineering/task').default;
const contactPlugin = require('@hcengineering/contact').default;

const markup = text => JSON.stringify({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function harness() {
  const data = new Map([
    [tags.class.TagElement, [{ _id: 'tag-1', title: 'Bug', description: markup('Broken things'), color: 3, category: 'cat-1', targetClass: tracker.class.Issue, createdOn: 1 }]],
    [contactPlugin.mixin.Employee, [
      { _id: 'emp-1', name: 'Ada Lovelace', active: true, role: 'OWNER', position: 'Lead', channels: [{ value: 'ada@example.test' }], createdOn: 1 },
      { _id: 'emp-2', name: 'Ada Byron', active: true, createdOn: 2 },
      { _id: 'emp-gone', name: 'Former Member', active: false, createdOn: 3 }
    ]],
    [chunter.class.ChatMessage, [{ _id: 'c-1', attachedTo: 'issue-1', message: markup('Hello'), createdBy: 'acc-1', createdOn: 5, modifiedOn: 6, editedOn: 6 }]],
    [tracker.class.TimeSpendReport, [{ _id: 'r-1', attachedTo: 'issue-1', value: 2, description: '', date: Date.UTC(2026, 0, 2), employee: 'emp-gone', createdOn: 7 }]],
    [task.class.TaskType, [{ _id: 'tt-1', name: 'Bug', description: markup('Defects'), kind: 'task', ofClass: tracker.class.Issue, parent: 'pt', statuses: ['s-1'], createdOn: 1 }]],
    [task.class.ProjectType, [{ _id: 'pt', tasks: ['tt-1'] }]],
    [tracker.class.Project, [{ _id: 'proj', identifier: 'PROJ', type: 'pt' }]]
  ]);
  const matches = (doc, query) => Object.entries(query).every(([key, value]) =>
    value && typeof value === 'object' && '$in' in value ? value.$in.includes(doc[key]) : doc[key] === value);
  const sdk = {
    findAll: async (classRef, query = {}) => (data.get(classRef) ?? []).filter(doc => matches(doc, query)),
    findOne: async (classRef, query = {}) => (data.get(classRef) ?? []).find(doc => matches(doc, query)) ?? null,
    updateDoc: async () => {}
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'w' });
  client._getClient = async () => sdk;
  client._parseAndFindIssue = async () => ({ project: { _id: 'proj', identifier: 'PROJ' }, issue: { _id: 'issue-1' } });
  return { client, sdk };
}

describe('list/get parity', () => {
  for (const [entity, list, get] of [
    ['label', client => client.listLabels(), client => client.getLabel('bug')],
    ['member', client => client.listMembers(), client => client.getMember('ada lovelace')],
    ['comment', client => client.listComments('PROJ-1'), client => client.getComment('PROJ-1', 'c-1')],
    ['time report', client => client.listTimeReports('PROJ-1'), client => client.getTimeReport('PROJ-1', 'r-1')],
    ['task type', client => client.listTaskTypes('PROJ'), client => client.getTaskType('PROJ', 'bug')]
  ]) {
    it(`returns a ${entity} exactly as its list does`, async () => {
      const { client } = harness();
      const item = await get(client);
      const listed = (await list(client)).items.find(candidate => candidate.id === item.id);
      assert.deepEqual(item, listed);
    });
  }

  it('matches members by full name, not by any name containing the text', async () => {
    const { client } = harness();
    await assert.rejects(() => client.getMember('ada'), /Member not found: ada/);
    assert.equal((await client.getMember('ADA BYRON')).id, 'emp-2');
  });

  it('names a time report author who has since left the workspace', async () => {
    const { client } = harness();
    assert.equal((await client.listTimeReports('PROJ-1')).items[0].employee, 'Former Member');
  });

  it('marks a comment as edited when its text is replaced', async () => {
    const { client, sdk } = harness();
    const writes = [];
    sdk.updateDoc = async (...args) => { writes.push(args); };
    const before = Date.now();

    await client.updateComment('PROJ-1', 'c-1', 'Edited');

    assert.ok(writes[0][3].editedOn >= before);
  });
});
