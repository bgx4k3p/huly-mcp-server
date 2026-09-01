import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { issueTimeFields, toHours } from '../src/helpers.mjs';
import { HulyClient } from '../src/client.mjs';

process.env.HULY_URL ??= 'https://huly.example.test';
const { createMcpServer } = await import('../src/mcpShared.mjs');
const { TOOLS } = createMcpServer();

describe('time numeric normalization', () => {
  it('coerces numeric strings and invalid values to API-safe numbers', () => {
    assert.equal(toHours('1.25'), 1.25);
    assert.equal(toHours(2.5), 2.5);
    assert.equal(toHours('0.51.25'), 0);
    assert.deepEqual(issueTimeFields({ estimation: '4', reportedTime: '1.5' }), {
      estimation: 4,
      reportedTime: 1.5
    });
  });

  it('logTime writes numeric report values and numeric issue totals', async () => {
    let reportPayload;
    let issueUpdate;
    const fakeSdk = {
      addCollection: async (_classRef, _space, _attachedTo, _attachedToClass, _collection, data) => {
        reportPayload = data;
      },
      updateDoc: async (_classRef, _space, _id, data) => {
        issueUpdate = data;
      }
    };
    const client = new HulyClient({
      url: 'https://huly.example.test',
      token: 'test-token',
      workspace: 'test-workspace'
    });
    client._getClient = async () => fakeSdk;
    client._parseAndFindIssue = async () => ({
      project: { _id: 'project-space' },
      issue: { _id: 'issue-id', reportedTime: '0.5' }
    });

    const result = await client.logTime('PROJ-1', '1.25', 'work');

    assert.equal(reportPayload.value, 1.25);
    assert.equal(issueUpdate.reportedTime, 1.75);
    assert.equal(result.reportedTime, 1.75);
  });

  it('rejects hours that are not a number rather than logging zero', async () => {
    const writes = [];
    const client = new HulyClient({
      url: 'https://huly.example.test',
      token: 'test-token',
      workspace: 'test-workspace'
    });
    client._getClient = async () => ({
      addCollection: async (...args) => { writes.push(args); },
      updateDoc: async (...args) => { writes.push(args); }
    });
    client._parseAndFindIssue = async () => ({
      project: { _id: 'project-space' },
      issue: { _id: 'issue-id', reportedTime: 0 }
    });

    // Each of these coerced to 0 before HMCP-67: the tool reported success
    // while the workspace recorded no time at all.
    for (const bad of ['two', '', null, undefined, true, NaN, Infinity, {}]) {
      await assert.rejects(
        () => client.logTime('PROJ-1', bad, 'work'),
        /hours must be a number/,
        `logTime must reject ${JSON.stringify(bad) ?? String(bad)}`
      );
    }

    await assert.rejects(() => client.logTime('PROJ-1', -1, 'work'), /hours cannot be negative/);

    assert.deepEqual(writes, [], 'nothing may reach the SDK for a rejected value');

    // 0 stays legal: it is a real, if unusual, amount of time to log.
    await client.logTime('PROJ-1', 0, 'work');
    assert.equal(writes.length, 2);
  });
});

describe('issue id validation', () => {
  it('rejects missing issue IDs before regex parsing', async () => {
    const client = new HulyClient({
      url: 'https://huly.example.test',
      token: 'test-token',
      workspace: 'test-workspace'
    });

    await assert.rejects(
      () => client._parseAndFindIssue({}, undefined),
      /Issue ID is required/
    );
    await assert.rejects(
      () => client._parseAndFindIssue({}, ''),
      /Issue ID is required/
    );
  });
});

describe('advertised parameter contracts', () => {
  function stubClient(sdk) {
    const client = new HulyClient({
      url: 'https://huly.example.test',
      token: 'test-token',
      workspace: 'test-workspace'
    });
    client._getClient = async () => sdk;
    return client;
  }

  it('rejects an unparseable log_time date instead of storing NaN', async () => {
    let reportPayload;
    const client = stubClient({
      addCollection: async (_c, _s, _a, _ac, _col, data) => { reportPayload = data; },
      updateDoc: async () => {}
    });
    client._parseAndFindIssue = async () => ({
      project: { _id: 'project-space' },
      issue: { _id: 'issue-id', reportedTime: 0 }
    });

    await assert.rejects(
      () => client.logTime('PROJ-1', 1, 'work', 'not-a-date'),
      /Invalid date: not-a-date/
    );
    assert.equal(reportPayload, undefined);

    await client.logTime('PROJ-1', 1, 'work', '2026-04-01');
    assert.equal(reportPayload.date, new Date('2026-04-01').getTime());
  });

  it('rejects an unknown list_statuses task type instead of returning every status', async () => {
    const allStatuses = [
      { _id: 's1', name: 'Todo', category: 'task:statusCategory:ToDo' },
      { _id: 's2', name: 'Done', category: 'task:statusCategory:Won' }
    ];
    const client = stubClient({
      findAll: async (classRef) => {
        const ref = String(classRef);
        if (ref.includes('IssueStatus')) return allStatuses;
        if (ref.includes('ProjectType')) return [{ _id: 'type-id', tasks: ['tt1'] }];
        if (ref.includes('TaskType')) return [{ _id: 'tt1', name: 'Issue', statuses: ['s1'] }];
        return [];
      },
      findOne: async () => ({ _id: 'project-id', type: 'type-id' })
    });

    await assert.rejects(
      () => client.listStatuses('PROJ', 'DoesNotExist'),
      /Task type not found: DoesNotExist/
    );
  });

  it('lets the release template identify issues by version when title is omitted', () => {
    const template = TOOLS.find(tool => tool.name === 'create_issues_from_template');
    assert.ok(!template.inputSchema.required.includes('title'),
      'title must be optional so version can identify the generated issues');
    assert.ok(template.inputSchema.properties.version, 'version must stay advertised');
  });
});

describe('label ownership space', () => {
  it('never creates a label in a built-in model space', async () => {
    const writes = [];
    const client = new HulyClient({
      url: 'https://huly.example.test', token: 't', workspace: 'w'
    });
    client._getClient = async () => ({
      // The title lookup is the "already exists" probe; the _id lookup is the
      // post-write persistence check, which only succeeds if createDoc ran.
      findOne: async (_class, query) => (
        query._id ? writes.find(w => w.id === query._id) ?? null : null
      ),
      findAll: async () => ([
        { _id: 'tracker:project:DefaultProject', identifier: 'START' },
        { _id: '6a95a9c53a1fc1df865c0e44', identifier: 'MCPV' }
      ]),
      createDoc: async (_class, space, data, id) => { writes.push({ space, data, id }); }
    });

    await client.createLabel('probe', 5);

    assert.equal(writes.length, 1);
    assert.equal(writes[0].space, '6a95a9c53a1fc1df865c0e44',
      'a TagElement written to a model-level space is silently discarded by Huly');
  });

  it('fails loudly when no real project can own the label', async () => {
    const client = new HulyClient({
      url: 'https://huly.example.test', token: 't', workspace: 'w'
    });
    client._getClient = async () => ({
      findOne: async () => null,
      findAll: async () => ([{ _id: 'tracker:project:DefaultProject', identifier: 'START' }]),
      createDoc: async () => { throw new Error('must not write'); }
    });

    await assert.rejects(() => client.createLabel('probe', 5), /no project to own it/);
  });
});

describe('label persistence verification', () => {
  it('fails when the server accepts the write but does not persist it', async () => {
    const client = new HulyClient({
      url: 'https://huly.example.test', token: 't', workspace: 'w'
    });
    client._getClient = async () => ({
      findOne: async () => null,                      // nothing ever persists
      findAll: async () => ([{ _id: '6a95a9c53a1fc1df865c0e44', identifier: 'MCPV' }]),
      createDoc: async () => {}                       // resolves, writes nothing
    });

    await assert.rejects(() => client.createLabel('ghost'), /was not persisted by the server/);
  });
});
