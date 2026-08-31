import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient, PRIORITY_MAP } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;

function generator(seed = 0x48554c59) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function matchesQuery(issue, query) {
  if (query.space !== undefined && issue.space !== query.space) return false;
  if (query.priority !== undefined && issue.priority !== query.priority) return false;
  if (query.milestone !== undefined && issue.milestone !== query.milestone) return false;
  if (typeof query.status === 'string' && issue.status !== query.status) return false;
  if (query.status?.$in && !query.status.$in.includes(issue.status)) return false;
  if (query._id?.$in && !query._id.$in.includes(issue._id)) return false;
  return true;
}

function createFilterHarness() {
  const statuses = [
    { _id: 'status-todo', name: 'Todo' },
    { _id: 'status-done', name: 'Done' }
  ];
  const milestones = [
    { _id: 'milestone-one', label: 'M1' },
    { _id: 'milestone-two', label: 'M2' }
  ];
  const labelElements = [
    { _id: 'label-alpha', title: 'Alpha' },
    { _id: 'label-beta', title: 'Beta' }
  ];
  const issues = Array.from({ length: 96 }, (_, index) => ({
    _id: `issue-${String(index + 1).padStart(3, '0')}`,
    number: index + 1,
    title: `Issue ${index + 1}`,
    space: 'project-id',
    createdOn: 10_000 - index,
    modifiedOn: 10_000 - index,
    status: statuses[index % statuses.length]._id,
    priority: index % 4,
    milestone: index % 3 === 0 ? milestones[(index / 3) % 2]._id : null
  }));
  const labelReferences = issues.flatMap((issue, index) => [
    ...(index % 2 === 0 ? [{ tag: 'label-alpha', attachedTo: issue._id }] : []),
    ...(index % 3 === 0 ? [{ tag: 'label-beta', attachedTo: issue._id }] : [])
  ]);
  const sdk = {
    findOne: async classRef => classRef === tracker.class.Project
      ? { _id: 'project-id', identifier: 'PROJ' }
      : null,
    findAll: async classRef => {
      if (classRef === tracker.class.Milestone) return milestones;
      if (classRef === tags.class.TagElement) return labelElements;
      return [];
    }
  };
  const client = new HulyClient({
    url: 'https://huly.example.test', token: 'test-token', workspace: 'release-validation'
  });
  client._getClient = async () => sdk;
  client._buildStatusMaps = async () => ({
    statuses,
    statusMap: new Map(statuses.map(item => [item._id, item.name])),
    doneStatuses: new Set(['status-done'])
  });
  client._paginatedFindAll = async (_sdk, classRef, query, options = {}) => {
    const source = classRef === tags.class.TagReference
      ? labelReferences.filter(reference => reference.tag === query.tag)
      : issues.filter(issue => matchesQuery(issue, query));
    const limit = options.limit ?? source.length;
    return { items: source.slice(0, limit) };
  };
  return { client, issues, labelReferences };
}

describe('release validation properties', () => {
  it('preserves every requested filter postcondition across randomized combinations', async () => {
    const { client, issues, labelReferences } = createFilterHarness();
    const random = generator();
    const choose = values => values[Math.floor(random() * values.length)];
    const priorityNames = Object.keys(PRIORITY_MAP).filter(name => name !== 'no priority');

    for (let iteration = 0; iteration < 80; iteration += 1) {
      const status = choose([undefined, 'Todo', 'Done']);
      const priority = choose([undefined, ...priorityNames]);
      const label = choose([undefined, 'Alpha', 'Beta']);
      const milestone = choose([undefined, 'M1', 'M2']);
      const page = await client.listIssues(
        'PROJ', status, priority, label, milestone, 100, undefined,
        { responseMode: 'compact', fields: ['title'] }
      );
      const allowedByLabel = label
        ? new Set(labelReferences
          .filter(reference => reference.tag === `label-${label.toLowerCase()}`)
          .map(reference => reference.attachedTo))
        : null;
      const expected = issues.filter(issue =>
        (!status || issue.status === `status-${status.toLowerCase()}`) &&
        (!priority || issue.priority === PRIORITY_MAP[priority]) &&
        (!milestone || issue.milestone === `milestone-${milestone === 'M1' ? 'one' : 'two'}`) &&
        (!allowedByLabel || allowedByLabel.has(issue._id))
      );

      assert.deepEqual(
        page.items.map(item => item.id),
        expected.map(issue => `PROJ-${issue.number}`),
        JSON.stringify({ iteration, status, priority, label, milestone })
      );
    }
  });

  it('invalidates the label lookup cache after every label mutation', async () => {
    const tag = { _id: 'tag-id', space: 'tag-space', title: 'Existing' };
    const sdk = {
      findOne: async (classRef, query) => {
        if (classRef === tracker.class.Project) return { _id: 'project-id' };
        if (query.title === 'New') return null;
        return tag;
      },
      // createLabel enumerates projects so it can skip built-in model spaces.
      findAll: async (classRef) => (classRef === tracker.class.Project ? [{ _id: 'project-id' }] : []),
      createDoc: async () => {},
      updateDoc: async () => {},
      removeDoc: async () => {}
    };
    const client = new HulyClient({
      url: 'https://huly.example.test', token: 'test-token', workspace: 'release-validation'
    });
    client._getClient = async () => sdk;

    client._labelLookupCache.set('stale', { value: tag, expiresAt: Date.now() + 60_000 });
    await client.createLabel('New');
    assert.equal(client._labelLookupCache.size, 0);

    client._labelLookupCache.set('stale', { value: tag, expiresAt: Date.now() + 60_000 });
    await client.updateLabel('Existing', { newName: 'Renamed' });
    assert.equal(client._labelLookupCache.size, 0);

    client._labelLookupCache.set('stale', { value: tag, expiresAt: Date.now() + 60_000 });
    await client.deleteLabel('Existing');
    assert.equal(client._labelLookupCache.size, 0);
  });
});
