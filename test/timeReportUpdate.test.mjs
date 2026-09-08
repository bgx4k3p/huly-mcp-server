import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const contact = require('@hcengineering/contact').default;
const tracker = require('@hcengineering/tracker').default;

function harness() {
  const issue = { _id: 'issue-1', _class: tracker.class.Issue, space: 'project-1', number: 1 };
  const otherIssue = { _id: 'issue-2', _class: tracker.class.Issue, space: 'project-1', number: 2 };
  const reports = [
    {
      _id: 'report-1', _class: tracker.class.TimeSpendReport, space: 'project-1',
      attachedTo: issue._id, attachedToClass: tracker.class.Issue, collection: 'reports',
      value: 2, description: 'Before', date: new Date('2026-06-01').getTime(), employee: 'employee-1'
    },
    {
      _id: 'report-2', _class: tracker.class.TimeSpendReport, space: 'project-1',
      attachedTo: otherIssue._id, attachedToClass: tracker.class.Issue, collection: 'reports',
      value: 4, description: 'Other', date: new Date('2026-06-01').getTime(), employee: null
    }
  ];
  const employees = [{ _id: 'employee-1', name: 'Ada Lovelace', active: true }];
  const calls = [];
  const sdk = {
    findAll: async (ref, query = {}) => {
      const source = ref === tracker.class.TimeSpendReport ? reports
        : ref === contact.mixin.Employee ? employees : [];
      return source.filter(doc => Object.entries(query).every(([key, value]) => doc[key] === value));
    },
    findOne: async (ref, query = {}) => {
      const source = ref === tracker.class.TimeSpendReport ? reports
        : ref === contact.mixin.Employee ? employees : [];
      return source.find(doc => Object.entries(query).every(([key, value]) => doc[key] === value)) ?? null;
    },
    updateCollection: async (ref, space, id, attachedTo, attachedToClass, collection, data) => {
      calls.push({ ref, space, id, attachedTo, attachedToClass, collection, data });
      Object.assign(reports.find(report => report._id === id), data);
    }
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'w' });
  client._getClient = async () => sdk;
  client._parseAndFindIssue = async (_sdk, issueId) => ({
    project: { _id: 'project-1', identifier: 'PROJ' },
    issue: issueId === 'PROJ-1' ? issue : otherIssue
  });
  return { client, issue, reports, calls };
}

describe('time report update round trip', () => {
  it('updates every editable SDK field and reads the employee name back', async () => {
    const { client, calls } = harness();

    const result = await client.updateTimeReport('PROJ-1', 'report-1', {
      hours: 3.5,
      description: 'After',
      date: '2026-06-03',
      employee: 'Ada Lovelace'
    });
    const read = await client.getTimeReport('PROJ-1', 'report-1');

    assert.deepEqual(result.updated, ['hours', 'description', 'date', 'employee']);
    assert.deepEqual(calls[0], {
      ref: tracker.class.TimeSpendReport,
      space: 'project-1',
      id: 'report-1',
      attachedTo: 'issue-1',
      attachedToClass: tracker.class.Issue,
      collection: 'reports',
      data: {
        value: 3.5,
        description: 'After',
        date: new Date('2026-06-03').getTime(),
        employee: 'employee-1'
      }
    });
    assert.equal(read.hours, 3.5);
    assert.equal(read.description, 'After');
    assert.equal(read.date, '2026-06-03T00:00:00.000Z');
    assert.equal(read.employee, 'Ada Lovelace');
  });

  it('clears employee attribution explicitly', async () => {
    const { client } = harness();
    await client.updateTimeReport('PROJ-1', 'report-1', { employee: '' });
    assert.equal((await client.getTimeReport('PROJ-1', 'report-1')).employee, null);
  });

  it('cannot update or read a report belonging to another issue', async () => {
    const { client, calls } = harness();
    await assert.rejects(
      () => client.updateTimeReport('PROJ-1', 'report-2', { hours: 1 }),
      /Time report not found on PROJ-1/
    );
    await assert.rejects(
      () => client.getTimeReport('PROJ-1', 'report-2'),
      /Time report not found on PROJ-1/
    );
    assert.equal(calls.length, 0);
  });
});
