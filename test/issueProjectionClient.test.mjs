import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const chunter = require('@hcengineering/chunter').default;

const baseIssue = {
  _id: 'issue-1',
  _class: tracker.class.Issue,
  number: 1,
  title: 'Projection fixture',
  description: `${'markdown word '.repeat(30)}[complete link](https://example.test)`,
  status: 'status-todo',
  priority: 2,
  kind: 'task-type',
  createdOn: 100,
  modifiedOn: 200
};

function createHarness({ comments = [], timeReports = [], children = [] } = {}) {
  const calls = [];
  const sdk = {
    findOne: async (classRef) => classRef === tracker.class.Project
      ? { _id: 'project-id', identifier: 'PROJ' }
      : null,
    findAll: async (classRef, query, options) => {
      calls.push({ classRef, query, options });
      if (classRef === chunter.class.ChatMessage) return comments;
      if (classRef === tracker.class.TimeSpendReport) return timeReports;
      if (classRef === tracker.class.Issue && query.attachedTo) return children;
      if (classRef === tags.class.TagReference) return [];
      return [];
    }
  };
  const client = new HulyClient({
    url: 'https://huly.example.test', token: 'test-token', workspace: 'projection-test'
  });
  client._getClient = async () => sdk;
  client._paginatedFindAll = async () => ({ items: [baseIssue] });
  client._buildStatusMaps = async () => ({
    statuses: [{ _id: 'status-todo', name: 'Todo' }],
    statusMap: new Map([['status-todo', 'Todo']]),
    doneStatuses: new Set()
  });
  client._buildTaskTypeMap = async () => new Map([['task-type', 'Task']]);
  client._buildEmployeeMap = async () => ({ employeeMap: new Map() });
  return { client, calls };
}

describe('issue projection client behavior', () => {
  it('fetches and returns only requested fields and expansions', async () => {
    const comments = [
      { _id: 'c1', attachedTo: 'issue-1', message: 'first', createdOn: 1 },
      { _id: 'c2', attachedTo: 'issue-1', message: 'second', createdOn: 2 }
    ];
    const { client, calls } = createHarness({ comments });
    const page = await client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { responseMode: 'compact', fields: ['title'], include: ['comments'], commentsLimit: 1 }
    );

    assert.deepEqual(page.items[0], {
      title: 'Projection fixture',
      id: 'PROJ-1',
      comments: [{ id: 'c1', text: 'first', createdBy: null, createdOn: 1, modifiedOn: undefined }],
      commentsCount: 2,
      commentsTruncated: true
    });
    assert.equal(calls.filter(call => call.classRef === chunter.class.ChatMessage).length, 1);
    assert.equal(calls.some(call => call.classRef === tracker.class.TimeSpendReport), false);
    assert.equal(calls.some(call => call.classRef === tags.class.TagReference), false);
    assert.equal(calls.some(call => call.classRef === tracker.class.Milestone), false);
  });

  it('builds independently bounded activity without returning source collections', async () => {
    const { client } = createHarness({
      comments: [{ _id: 'c1', attachedTo: 'issue-1', message: 'comment', createdOn: 20 }],
      timeReports: [{ _id: 't1', attachedTo: 'issue-1', value: 1.5, description: 'work', date: 10 }]
    });
    const page = await client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { responseMode: 'compact', fields: ['title'], include: ['activity'], activityLimit: 1 }
    );
    const issue = page.items[0];

    assert.deepEqual(issue.activity.map(item => item.type), ['time_logged']);
    assert.equal(issue.activityCount, 2);
    assert.equal(issue.activityTruncated, true);
    assert.equal(Object.hasOwn(issue, 'comments'), false);
    assert.equal(Object.hasOwn(issue, 'timeReports'), false);
  });

  it('marks deterministic list previews and supports an explicit full-content path', async () => {
    const { client } = createHarness();
    const preview = await client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      {
        responseMode: 'compact', fields: ['title'], include: ['description'],
        descriptionPreviewChars: 100
      }
    );
    const full = await client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      {
        responseMode: 'compact', fields: ['title'], include: ['description'],
        descriptionPreviewChars: 0
      }
    );

    assert.equal(preview.items[0].descriptionTruncated, true);
    assert.ok(preview.items[0].description.endsWith('…'));
    assert.equal(full.items[0].description, baseIssue.description);
    assert.equal(full.items[0].descriptionTruncated, false);
  });

  it('never truncates get_issue descriptions by default and bounds requested details', async () => {
    const comments = [
      { _id: 'c1', message: 'first', createdOn: 1 },
      { _id: 'c2', message: 'second', createdOn: 2 }
    ];
    const { client } = createHarness({ comments });
    client._parseAndFindIssue = async () => ({
      project: { _id: 'project-id', identifier: 'PROJ' },
      issue: baseIssue
    });

    const defaultRead = await client.getIssue('PROJ-1', { responseMode: 'compact' });
    const granular = await client.getIssue('PROJ-1', {
      responseMode: 'compact', fields: ['title'], include: ['comments'], commentsLimit: 1
    });

    assert.equal(defaultRead.description, baseIssue.description);
    assert.equal(defaultRead.descriptionTruncated, false);
    assert.deepEqual(granular.comments.map(item => item.id), ['c1']);
    assert.equal(granular.commentsCount, 2);
    assert.equal(granular.commentsTruncated, true);
    assert.equal(Object.hasOwn(granular, 'description'), false);
  });

  it('reduces related-record calls for a targeted projection versus raw full fields', async () => {
    const compactHarness = createHarness();
    const rawHarness = createHarness();
    const compact = await compactHarness.client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { responseMode: 'compact', fields: ['title'] }
    );
    const raw = await rawHarness.client.listIssues(
      'PROJ', undefined, undefined, undefined, undefined, 10, undefined,
      { responseMode: 'raw' }
    );

    assert.deepEqual(compact.items[0], { title: 'Projection fixture', id: 'PROJ-1' });
    assert.ok(Object.hasOwn(raw.items[0], 'status'));
    assert.ok(Object.hasOwn(raw.items[0], 'extra'));
    assert.ok(compactHarness.calls.length < rawHarness.calls.length);
  });
});
