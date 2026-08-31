import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const chunter = require('@hcengineering/chunter').default;

function createHarness({
  milestones = [],
  labelElements = [],
  labelReferences = [],
  issues = [],
  projectRecord = { _id: 'project-id', identifier: 'PROJ' }
} = {}) {
  const calls = [];
  const paginatedQueries = [];
  const fakeSdk = {
    findOne: async (_class, query) => {
      calls.push({ method: 'findOne', classRef: _class, query });
      if (_class === tracker.class.Project) {
        return projectRecord;
      }
      return null;
    },
    findAll: async (_class, query, options) => {
      calls.push({ method: 'findAll', classRef: _class, query, options });
      if (_class === tracker.class.Milestone) return milestones;
      if (_class === tags.class.TagElement) return labelElements;
      if (_class === tags.class.TagReference && query.tag) return labelReferences;
      if (_class === tags.class.TagReference) return [];
      return [];
    }
  };

  const client = new HulyClient({
    url: 'https://huly.example.test',
    token: 'test-token',
    workspace: 'test-workspace'
  });
  client._getClient = async () => fakeSdk;
  client._buildStatusMaps = async () => ({
    statuses: [{ _id: 'status-todo', name: 'Todo' }],
    statusMap: new Map([['status-todo', 'Todo']]),
    doneStatuses: new Set()
  });
  client._buildTaskTypeMap = async () => new Map([['task-type', 'Task']]);
  client._buildEmployeeMap = async () => ({ employees: [], employeeMap: new Map() });
  client._paginatedFindAll = async (_sdk, _class, query, options = {}) => {
    if (_class === tags.class.TagReference) {
      return {
        items: labelReferences.slice(0, options.limit),
        ...(labelReferences.length > options.limit ? { nextCursor: 'more-labels' } : {})
      };
    }
    paginatedQueries.push(query);
    return { items: issues };
  };

  return { client, fakeSdk, calls, paginatedQueries };
}

describe('listIssues filter correctness', () => {
  it('rejects an unknown priority instead of treating it as no priority', async () => {
    const { client, paginatedQueries } = createHarness();

    await assert.rejects(
      () => client.listIssues('PROJ', undefined, 'bogus'),
      /Priority not found: bogus/
    );
    assert.equal(paginatedQueries.length, 0);
  });

  it('rejects an unknown status instead of broadening the query', async () => {
    const { client, paginatedQueries } = createHarness();

    await assert.rejects(
      () => client.listIssues('PROJ', 'Missing status'),
      /Status not found: Missing status/
    );
    assert.equal(paginatedQueries.length, 0);
  });

  it('rejects an unknown milestone instead of broadening the query', async () => {
    const { client, paginatedQueries } = createHarness();

    await assert.rejects(
      () => client.listIssues('PROJ', undefined, undefined, undefined, 'Missing milestone'),
      /Milestone not found: Missing milestone/
    );
    assert.equal(paginatedQueries.length, 0);
  });

  it('rejects an unknown label instead of broadening the query', async () => {
    const { client, paginatedQueries } = createHarness();

    await assert.rejects(
      () => client.listIssues('PROJ', undefined, undefined, 'Missing label'),
      /Label not found: Missing label/
    );
    assert.equal(paginatedQueries.length, 0);
  });

  it('returns an empty page for a valid label with no matching issues', async () => {
    const { client, paginatedQueries } = createHarness({
      labelElements: [{ _id: 'label-id', title: 'Bug' }]
    });

    const result = await client.listIssues('PROJ', undefined, undefined, 'bug');

    assert.deepEqual(result, { items: [], count: 0, hasMore: false, truncated: false });
    assert.equal(paginatedQueries.length, 0);
  });

  it('constrains the issue query to IDs resolved from the requested label', async () => {
    const { client, paginatedQueries } = createHarness({
      labelElements: [{ _id: 'label-id', title: 'Bug' }],
      labelReferences: [
        { attachedTo: 'issue-1', tag: 'label-id' },
        { attachedTo: 'issue-2', tag: 'label-id' }
      ]
    });

    await client.listIssues('PROJ', undefined, undefined, 'bug');

    assert.equal(paginatedQueries.length, 1);
    assert.deepEqual(paginatedQueries[0], {
      space: 'project-id',
      _id: { $in: ['issue-1', 'issue-2'] }
    });
  });

  it('batches high-cardinality label issue queries into at most 100 IDs', async () => {
    const labelReferences = Array.from({ length: 125 }, (_, index) => ({
      attachedTo: `issue-${index + 1}`,
      tag: 'label-id'
    }));
    const { client, paginatedQueries } = createHarness({
      labelElements: [{ _id: 'label-id', title: 'Bulk' }],
      labelReferences
    });

    await client.listIssues('PROJ', undefined, undefined, 'Bulk');

    assert.equal(paginatedQueries.length, 2);
    assert.deepEqual(
      paginatedQueries.map(query => query._id.$in.length),
      [100, 25]
    );
  });

  it('fails explicitly when a label exceeds the bounded inversion limit', async () => {
    const labelReferences = Array.from({ length: 5001 }, (_, index) => ({
      attachedTo: `issue-${index + 1}`,
      tag: 'label-id'
    }));
    const { client, paginatedQueries } = createHarness({
      labelElements: [{ _id: 'label-id', title: 'Huge' }],
      labelReferences
    });

    await assert.rejects(
      () => client.listIssues('PROJ', undefined, undefined, 'Huge'),
      /more than 5000 issues/
    );
    assert.equal(paginatedQueries.length, 0);
  });

  it('distinguishes a valid zero-match filter from an invalid filter', async () => {
    const { client } = createHarness({
      milestones: [{ _id: 'milestone-id', label: 'v1' }]
    });

    const result = await client.listIssues('PROJ', undefined, undefined, undefined, 'V1');

    assert.deepEqual(result, { items: [], count: 0, hasMore: false, truncated: false });
  });
});

describe('other issue-list filter safety', () => {
  it('rejects an unknown project in searchIssues', async () => {
    const { client } = createHarness({ projectRecord: null });
    await assert.rejects(
      () => client.searchIssues('fixture', 'MISSING'),
      /Project not found: MISSING/
    );
  });

  it('rejects an unknown project in getMyIssues', async () => {
    const { client } = createHarness({ projectRecord: null });
    client._buildEmployeeMap = async () => ({
      employees: [{ _id: 'employee-1', channels: [] }],
      employeeMap: new Map([['employee-1', 'Fixture User']])
    });
    await assert.rejects(
      () => client.getMyIssues('MISSING'),
      /Project not found: MISSING/
    );
  });

  it('rejects an unknown status in getMyIssues', async () => {
    const { client } = createHarness();
    client._buildEmployeeMap = async () => ({
      employees: [{ _id: 'employee-1', channels: [] }],
      employeeMap: new Map([['employee-1', 'Fixture User']])
    });
    await assert.rejects(
      () => client.getMyIssues(undefined, 'Missing status'),
      /Status not found: Missing status/
    );
  });

  it('rejects an unknown milestone status', async () => {
    const { client } = createHarness();
    await assert.rejects(
      () => client.listMilestones('PROJ', 'Not a milestone status'),
      /Milestone status not found/
    );
  });

  it('caps generic asynchronous work at the requested concurrency', async () => {
    const { client } = createHarness();
    let active = 0;
    let peak = 0;
    const results = await client._mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      4,
      async value => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
        return value * 2;
      }
    );
    assert.equal(peak, 4);
    assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index * 2));
  });
});

describe('listIssues related-record scoping', () => {
  it('queries labels and expanded details only for selected issue IDs', async () => {
    const issue = {
      _id: 'issue-1',
      _class: tracker.class.Issue,
      number: 1,
      title: 'Selected issue',
      description: '',
      status: 'status-todo',
      priority: 2,
      kind: 'task-type',
      createdOn: 100,
      modifiedOn: 101
    };
    const { client, calls } = createHarness({ issues: [issue] });

    await client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 20, undefined,
      { include: ['comments', 'timeReports', 'children'], fields: ['labels'] }
    );

    const findAll = (classRef) => calls.filter(call =>
      call.method === 'findAll' && call.classRef === classRef
    );
    assert.deepEqual(
      findAll(tags.class.TagReference).map(call => call.query),
      [{ attachedTo: { $in: ['issue-1'] } }]
    );
    assert.deepEqual(
      findAll(chunter.class.ChatMessage).map(call => call.query),
      [{ attachedTo: { $in: ['issue-1'] } }]
    );
    assert.deepEqual(
      findAll(tracker.class.TimeSpendReport).map(call => call.query),
      [{ attachedTo: { $in: ['issue-1'] } }]
    );
    assert.deepEqual(
      findAll(tracker.class.Issue).map(call => call.query),
      [{
        attachedTo: { $in: ['issue-1'] },
        attachedToClass: tracker.class.Issue,
        space: 'project-id'
      }]
    );
  });
});
