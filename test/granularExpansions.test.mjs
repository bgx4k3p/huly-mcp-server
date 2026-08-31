import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const contactPlugin = require('@hcengineering/contact').default;

function testClient(sdk) {
  const client = new HulyClient({
    url: 'https://huly.example.test', token: 'test-token', workspace: 'expansion-test'
  });
  client._getClient = async () => sdk;
  return client;
}

describe('granular project and milestone expansions', () => {
  it('fetches only requested project relationships for the selected page', async () => {
    const calls = [];
    const projects = [
      { _id: 'p1', identifier: 'ONE', name: 'One', members: ['e1'], createdOn: 2 },
      { _id: 'p2', identifier: 'TWO', name: 'Two', members: ['e2'], createdOn: 1 }
    ];
    const sdk = {
      findAll: async (classRef, query) => {
        calls.push({ classRef, query });
        if (classRef === tracker.class.Project) return projects;
        if (classRef === contactPlugin.mixin.Employee) {
          return [{ _id: 'e1', name: 'Alice' }, { _id: 'e2', name: 'Bob' }];
        }
        return [];
      }
    };
    const page = await testClient(sdk).listProjects({ include: ['members'], limit: 1 });

    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0].members, ['Alice']);
    assert.ok(page.nextCursor);
    assert.equal(calls.some(call => call.classRef === tracker.class.Milestone), false);
    assert.equal(calls.some(call => call.classRef === tracker.class.Component), false);
    assert.equal(calls.some(call => call.classRef === tags.class.TagElement), false);
    assert.equal(calls.filter(call => call.classRef === contactPlugin.mixin.Employee).length, 1);
  });

  it('bounds milestone issue expansions and scopes the issue query to the current page', async () => {
    const calls = [];
    const milestones = [
      { _id: 'm1', label: 'First', status: 0, createdOn: 2 },
      { _id: 'm2', label: 'Second', status: 0, createdOn: 1 }
    ];
    const issues = Array.from({ length: 4 }, (_, index) => ({
      _id: `i${index + 1}`,
      number: index + 1,
      title: `Issue ${index + 1}`,
      status: 's1',
      kind: 't1',
      milestone: 'm1'
    }));
    const sdk = {
      findOne: async classRef => classRef === tracker.class.Project
        ? { _id: 'p1', identifier: 'ONE' }
        : null,
      findAll: async (classRef, query) => {
        calls.push({ classRef, query });
        if (classRef === tracker.class.Milestone) return milestones;
        if (classRef === tracker.class.Issue) return issues;
        return [];
      }
    };
    const client = testClient(sdk);
    client._buildStatusMaps = async () => ({ statusMap: new Map([['s1', 'Todo']]) });
    client._buildTaskTypeMap = async () => new Map([['t1', 'Issue']]);

    const page = await client.listMilestones('ONE', undefined, {
      include: ['issues'], issuesLimit: 2, limit: 1
    });

    assert.equal(page.items.length, 1);
    assert.deepEqual(page.items[0].issues.map(issue => issue.id), ['ONE-1', 'ONE-2']);
    assert.equal(page.items[0].issuesCount, 4);
    assert.equal(page.items[0].issuesTruncated, true);
    const issueQuery = calls.find(call => call.classRef === tracker.class.Issue).query;
    assert.deepEqual(issueQuery.milestone, { $in: ['m1'] });
  });

  it('rejects unsupported expansion names', async () => {
    const sdk = { findAll: async () => [] };
    const client = testClient(sdk);
    await assert.rejects(
      () => client.listProjects({ include: ['everything'] }),
      /Unsupported include value/
    );
    await assert.rejects(
      () => client.listMilestones('ONE', undefined, { include: ['comments'] }),
      /Unsupported include value/
    );
  });
});
