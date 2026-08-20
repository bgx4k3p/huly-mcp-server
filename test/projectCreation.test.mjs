import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const ACCOUNT_UUID = 'account-uuid';
const SPACE_ID = 'core:space:Space';

function createHarness({ readable = true, rollbackFails = false } = {}) {
  const calls = {
    createDoc: [],
    createMixin: [],
    removeDoc: []
  };
  let created;
  let findOneCount = 0;

  const fakeSdk = {
    findOne: async () => {
      findOneCount += 1;
      if (findOneCount === 1 || !readable) return undefined;
      return { _id: created.id, ...created.data };
    },
    findAll: async (classRef) => {
      if (String(classRef).includes('ProjectType')) {
        return [{ _id: 'classic-project-type', name: 'Classic project', targetClass: 'classic-project-mixin' }];
      }
      return [{ _id: 'todo-status', name: 'Todo' }];
    },
    createDoc: async (classRef, space, data, id) => {
      created = { classRef, space, data, id };
      calls.createDoc.push(created);
    },
    createMixin: async (...args) => {
      calls.createMixin.push(args);
    },
    removeDoc: async (...args) => {
      calls.removeDoc.push(args);
      if (rollbackFails) throw new Error('cleanup denied');
    }
  };

  const client = new HulyClient({
    url: 'https://huly.example.test',
    token: 'test-token',
    workspace: 'test-workspace'
  });
  client._accountUuid = ACCOUNT_UUID;
  client._getClient = async () => fakeSdk;

  return { client, calls };
}

describe('private project creation', () => {
  it('creates the project in the canonical space with creator access and verifies the write', async () => {
    const { client, calls } = createHarness();

    const result = await client.createProject('priv', 'Private project', 'Secret', true, 'Classic project');

    assert.equal(result.identifier, 'PRIV');
    assert.equal(result.private, true);
    assert.equal(calls.createDoc.length, 1);
    assert.equal(calls.createDoc[0].space, SPACE_ID);
    assert.deepEqual(calls.createDoc[0].data.members, [ACCOUNT_UUID]);
    assert.deepEqual(calls.createDoc[0].data.owners, [ACCOUNT_UUID]);
    assert.equal(calls.createDoc[0].data.autoJoin, false);
    assert.deepEqual(calls.createMixin[0], [
      result.id,
      calls.createDoc[0].classRef,
      SPACE_ID,
      'classic-project-mixin',
      {}
    ]);
    assert.equal(calls.removeDoc.length, 0);
  });

  it('rolls back instead of reporting success when the project is unreadable', async () => {
    const { client, calls } = createHarness({ readable: false });

    await assert.rejects(
      () => client.createProject('priv', 'Private project', '', true, 'Classic project'),
      /partial project was rolled back/
    );

    assert.equal(calls.removeDoc.length, 1);
    assert.equal(calls.removeDoc[0][1], SPACE_ID);
    assert.equal(calls.removeDoc[0][2], calls.createDoc[0].id);
  });

  it('reports the internal ID when verification and rollback both fail', async () => {
    const { client, calls } = createHarness({ readable: false, rollbackFails: true });

    await assert.rejects(
      () => client.createProject('priv', 'Private project', '', true, 'Classic project'),
      (error) => {
        assert.match(error.message, /automatic rollback failed \(cleanup denied\)/);
        assert.match(error.message, new RegExp(calls.createDoc[0].id));
        return true;
      }
    );
  });
});
