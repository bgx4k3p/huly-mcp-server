import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { issueTimeFields, toHours } from '../src/helpers.mjs';
import { HulyClient } from '../src/client.mjs';

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
