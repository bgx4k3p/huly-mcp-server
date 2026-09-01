/**
 * Methods that had no offline coverage at all. Each assertion targets the
 * value reaching the SDK or the exact thrown message, so a guard that quietly
 * loosens fails here rather than in production.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HulyClient } from '../src/client.mjs';

function stubClient(sdk, overrides = {}) {
  const client = new HulyClient({
    url: 'https://huly.example.test', token: 't', workspace: 'w'
  });
  client._getClient = async () => sdk;
  client._parseAndFindIssue = overrides.parseIssue ?? (async () => ({
    project: { _id: 'p1', identifier: 'PROJ' },
    issue: { _id: 'i1', number: 42, reportedTime: 0, estimation: 0 }
  }));
  return client;
}

function recorder(fixtures = {}) {
  const calls = [];
  const pick = ref => {
    const name = String(ref);
    if (name.includes('ChatMessage')) return fixtures.comments ?? [];
    if (name.includes('TimeSpendReport')) return fixtures.reports ?? [];
    if (name.includes('Employee')) return fixtures.employees ?? [];
    if (name.includes('TagElement')) return fixtures.labels ?? [];
    if (name.includes('Issue')) return fixtures.issues ?? [];
    return [];
  };
  return {
    calls,
    findAll: async (ref, query, options) => { calls.push({ op: 'findAll', ref: String(ref), query, options }); return pick(ref); },
    findOne: async (ref, query) => { calls.push({ op: 'findOne', ref: String(ref), query }); return pick(ref)[0] ?? null; },
    updateDoc: async (ref, space, id, data) => { calls.push({ op: 'updateDoc', ref: String(ref), space, id, data }); }
  };
}

describe('setDueDate', () => {
  it('writes a parsed timestamp and reports the value it stored', async () => {
    const sdk = recorder();
    const result = await stubClient(sdk).setDueDate('PROJ-42', '2026-04-01');
    const write = sdk.calls.find(c => c.op === 'updateDoc');
    assert.equal(write.data.dueDate, new Date('2026-04-01').getTime());
    assert.equal(write.space, 'p1');
    assert.equal(write.id, 'i1');
    assert.match(result.message, /Due date set to 2026-04-01/);
  });

  it('clears the date with an explicit null rather than omitting the field', async () => {
    const sdk = recorder();
    const result = await stubClient(sdk).setDueDate('PROJ-42', '');
    const write = sdk.calls.find(c => c.op === 'updateDoc');
    assert.ok('dueDate' in write.data, 'omitting the key would leave the old date in place');
    assert.equal(write.data.dueDate, null);
    assert.match(result.message, /cleared/);
  });

  it('rejects an unparseable date without writing', async () => {
    const sdk = recorder();
    await assert.rejects(() => stubClient(sdk).setDueDate('PROJ-42', 'next friday'), /Invalid date/);
    assert.equal(sdk.calls.filter(c => c.op === 'updateDoc').length, 0);
  });
});

describe('setEstimation', () => {
  it('coerces the estimate to a number before it reaches the SDK', async () => {
    const sdk = recorder();
    await stubClient(sdk).setEstimation('PROJ-42', '2.5');
    const write = sdk.calls.find(c => c.op === 'updateDoc');
    assert.equal(write.data.estimation, 2.5);
    assert.equal(typeof write.data.estimation, 'number');
  });

  it('rejects a non-numeric estimate instead of silently storing zero', async () => {
    const sdk = recorder();

    await assert.rejects(
      () => stubClient(sdk).setEstimation('PROJ-42', 'abc'),
      /estimation must be a number, received "abc"/
    );

    // Coercing to 0 would report success while discarding the caller's intent,
    // storing an estimate they never asked for.
    assert.equal(sdk.calls.find(c => c.op === 'updateDoc'), undefined);
  });

  it('rejects a negative estimate', async () => {
    const sdk = recorder();

    await assert.rejects(
      () => stubClient(sdk).setEstimation('PROJ-42', -3),
      /estimation cannot be negative, received -3/
    );

    assert.equal(sdk.calls.find(c => c.op === 'updateDoc'), undefined);
  });
});

describe('listMembers', () => {
  it('queries only active employees and projects the documented shape', async () => {
    const sdk = recorder({
      employees: [
        { _id: 'e1', name: 'Ada', role: 'OWNER', position: 'Lead', channels: [{ value: 'ada@example.test' }], createdOn: 2 },
        { _id: 'e2', name: 'Bo', createdOn: 1 }
      ]
    });
    const page = await stubClient(sdk).listMembers();
    const query = sdk.calls.find(c => c.op === 'findAll').query;
    assert.deepEqual(query, { active: true }, 'inactive members must not be listed');
    assert.equal(page.count, 2);
    const ada = page.items.find(m => m.id === 'e1');
    assert.equal(ada.email, 'ada@example.test');
    assert.equal(ada.role, 'OWNER');
    const bo = page.items.find(m => m.id === 'e2');
    assert.equal(bo.email, null, 'a member with no channel must report null, not undefined');
    assert.equal(bo.role, 'USER', 'role defaults to USER');
    assert.equal(bo.position, null);
  });
});

describe('getMember and getLabel', () => {
  it('lists the available names when a member does not match', async () => {
    const sdk = recorder({ employees: [{ _id: 'e1', name: 'Ada' }, { _id: 'e2', name: 'Bo' }] });
    await assert.rejects(
      () => stubClient(sdk).getMember('Zoe'),
      /Member not found: "Zoe"\. Available: Ada, Bo/
    );
  });

  it('matches a member on a case-insensitive substring', async () => {
    const sdk = recorder({ employees: [{ _id: 'e1', name: 'Ada Lovelace', role: 'OWNER' }] });
    const member = await stubClient(sdk).getMember('lovelace');
    assert.equal(member.id, 'e1');
    assert.equal(member.role, 'OWNER');
  });

  it('reports a missing label and preserves palette index zero', async () => {
    const empty = recorder({ labels: [] });
    await assert.rejects(() => stubClient(empty).getLabel('bug'), /Label not found: bug/);

    const sdk = recorder({ labels: [{ _id: 't1', title: 'bug', color: 0, description: '' }] });
    const label = await stubClient(sdk).getLabel('bug');
    assert.equal(label.color, 0, 'index 0 is a real colour and must not become null');
    assert.equal(label.name, 'bug');
  });
});

describe('getIssueHistory', () => {
  it('assembles comments, time reports and sub-issues in chronological order', async () => {
    const sdk = recorder({
      comments: [{ _id: 'c1', attachedTo: 'i1', message: 'first', createdOn: 10, createdBy: 'u1' }],
      reports: [{ _id: 'r1', attachedTo: 'i1', value: 2, date: 20, description: 'work' }],
      issues: [{ _id: 'i2', space: 'p1', number: 43, title: 'child', createdOn: 30 }]
    });
    const history = await stubClient(sdk).getIssueHistory('PROJ-42');

    const sorts = sdk.calls.filter(c => c.op === 'findAll').map(c => c.options?.sort);
    assert.ok(sorts.some(s => s && s.createdOn === 1), 'comments must be requested oldest-first');
    assert.ok(sorts.some(s => s && s.date === 1), 'time reports must be requested oldest-first');
    assert.ok(history, 'history must be returned');
  });
});
