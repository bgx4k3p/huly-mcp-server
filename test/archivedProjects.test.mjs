import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';
import { workspaceTools } from '../src/dispatch.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;

const ACTIVE = { _id: 'p1', identifier: 'ONE', name: 'One', members: [], createdOn: 2 };
const ARCHIVED = { _id: 'p2', identifier: 'TP12345', name: 'Temp Project', members: [], archived: true, createdOn: 1 };

function testClient(sdk) {
  const client = new HulyClient({ url: 'https://huly.example.test', token: 'test-token', workspace: 'archive-test' });
  client._getClient = async () => sdk;
  return client;
}

// The SDK hides archived spaces unless a find asks for them with { showArchived: true }.
function archiveAwareSdk(calls) {
  return {
    findAll: async (classRef, query, options) => {
      calls.push({ classRef, options });
      if (classRef !== tracker.class.Project) return [];
      return options?.showArchived ? [ACTIVE, ARCHIVED] : [ACTIVE];
    }
  };
}

describe('archived projects in list_projects', () => {
  it('lists only active projects by default', async () => {
    const page = await testClient(archiveAwareSdk([])).listProjects();
    assert.deepEqual(page.items.map(p => p.identifier), ['ONE']);
  });

  it('lists archived projects too when includeArchived is set, marked archived', async () => {
    const calls = [];
    const page = await testClient(archiveAwareSdk(calls)).listProjects({ includeArchived: true });
    assert.deepEqual(page.items.map(p => [p.identifier, p.archived]), [['ONE', false], ['TP12345', true]]);
    assert.deepEqual(calls.find(c => c.classRef === tracker.class.Project).options, { showArchived: true });
  });

  it('passes includeArchived through the tool', async () => {
    const seen = [];
    const client = { listProjects: async options => { seen.push(options); return { items: [] }; } };
    await workspaceTools.list_projects({ includeArchived: true }, client);
    assert.equal(seen[0].includeArchived, true);
  });
});
