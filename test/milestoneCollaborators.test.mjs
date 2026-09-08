import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const core = require('@hcengineering/core').default;
const contact = require('@hcengineering/contact').default;
const tracker = require('@hcengineering/tracker').default;

function matches(doc, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value && typeof value === 'object' && Array.isArray(value.$in)) {
      return value.$in.includes(doc[key]);
    }
    return doc[key] === value;
  });
}

function harness(seed = {}) {
  const store = new Map([
    [tracker.class.Project, seed.projects ?? [{ _id: 'p1', identifier: 'PROJ' }]],
    [tracker.class.Milestone, seed.milestones ?? []],
    [tracker.class.Issue, seed.issues ?? []],
    [core.class.Collaborator, seed.collaborators ?? []],
    [contact.mixin.Employee, seed.employees ?? [
      { _id: 'e1', name: 'Ada Lovelace', active: true, personUuid: 'account-ada' },
      { _id: 'e2', name: 'Grace Hopper', active: true, personUuid: 'account-grace' }
    ]]
  ]);
  const calls = [];
  let collectionSequence = 0;
  const docs = ref => {
    if (!store.has(ref)) store.set(ref, []);
    return store.get(ref);
  };
  const sdk = {
    findAll: async (ref, query = {}) => docs(ref).filter(doc => matches(doc, query)),
    findOne: async (ref, query = {}) => docs(ref).find(doc => matches(doc, query)) ?? null,
    createDoc: async (ref, space, data, id) => {
      calls.push({ op: 'createDoc', ref, space, data, id });
      docs(ref).push({ _id: id, _class: ref, space, ...data });
    },
    updateDoc: async (ref, space, id, data) => {
      calls.push({ op: 'updateDoc', ref, space, id, data });
      Object.assign(docs(ref).find(doc => doc._id === id), data);
    },
    removeDoc: async (ref, space, id) => {
      calls.push({ op: 'removeDoc', ref, space, id });
      const index = docs(ref).findIndex(doc => doc._id === id);
      if (index >= 0) docs(ref).splice(index, 1);
    },
    addCollection: async (ref, space, attachedTo, attachedToClass, collection, data) => {
      calls.push({ op: 'addCollection', ref, space, attachedTo, attachedToClass, collection, data });
      docs(ref).push({
        _id: `collection-${++collectionSequence}`,
        _class: ref,
        space,
        attachedTo,
        attachedToClass,
        collection,
        ...data
      });
    },
    removeCollection: async (ref, space, id, attachedTo, attachedToClass, collection) => {
      calls.push({ op: 'removeCollection', ref, space, id, attachedTo, attachedToClass, collection });
      const index = docs(ref).findIndex(doc => doc._id === id);
      if (index >= 0) docs(ref).splice(index, 1);
    }
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'w' });
  client._getClient = async () => sdk;
  return { client, calls, store };
}

describe('milestone collaborator round trip', () => {
  it('creates attached Collaborator documents and reads resolved members back', async () => {
    const { client, calls } = harness();

    await client.createMilestone(
      'PROJ', 'v1', 'First', '2026-06-01', 'planned', 'plain',
      ['Ada Lovelace', 'account-grace']
    );
    const read = await client.getMilestone('PROJ', 'v1');

    assert.deepEqual(read.collaborators, [
      { account: 'account-ada', name: 'Ada Lovelace' },
      { account: 'account-grace', name: 'Grace Hopper' }
    ]);
    assert.deepEqual(
      calls.filter(call => call.op === 'addCollection').map(call => ({
        ref: call.ref,
        attachedToClass: call.attachedToClass,
        collection: call.collection,
        data: call.data
      })),
      [
        { ref: core.class.Collaborator, attachedToClass: tracker.class.Milestone, collection: 'collaborators', data: { collaborator: 'account-ada' } },
        { ref: core.class.Collaborator, attachedToClass: tracker.class.Milestone, collection: 'collaborators', data: { collaborator: 'account-grace' } }
      ]
    );
  });

  it('replaces and clears the complete collaborator set without duplicate records', async () => {
    const { client, store, calls } = harness({
      milestones: [{ _id: 'm1', _class: tracker.class.Milestone, space: 'p1', label: 'v1', status: 0 }],
      collaborators: [{
        _id: 'c1', _class: core.class.Collaborator, space: 'p1', attachedTo: 'm1',
        attachedToClass: tracker.class.Milestone, collection: 'collaborators', collaborator: 'account-ada'
      }]
    });

    await client.updateMilestone('PROJ', 'v1', { collaborators: ['Grace Hopper', 'Grace Hopper'] });
    assert.deepEqual((await client.getMilestone('PROJ', 'v1')).collaborators,
      [{ account: 'account-grace', name: 'Grace Hopper' }]);
    assert.equal(calls.filter(call => call.op === 'addCollection').length, 1);
    assert.equal(calls.filter(call => call.op === 'removeCollection').length, 1);

    await client.updateMilestone('PROJ', 'v1', { collaborators: [] });
    assert.deepEqual(store.get(core.class.Collaborator), []);
  });

  it('rejects an unknown collaborator before changing ordinary milestone fields', async () => {
    const { client, calls } = harness({
      milestones: [{ _id: 'm1', _class: tracker.class.Milestone, space: 'p1', label: 'v1', status: 0 }]
    });

    await assert.rejects(
      () => client.updateMilestone('PROJ', 'v1', { status: 'completed', collaborators: ['Nobody'] }),
      /Collaborator not found: Nobody/
    );
    assert.equal(calls.filter(call => call.op === 'updateDoc').length, 0);
  });
});

describe('milestone deletion referential integrity', () => {
  it('moves assigned issues to the requested milestone before deleting', async () => {
    const { client, store } = harness({
      milestones: [
        { _id: 'm1', _class: tracker.class.Milestone, space: 'p1', label: 'v1', status: 0 },
        { _id: 'm2', _class: tracker.class.Milestone, space: 'p1', label: 'v2', status: 0 }
      ],
      issues: [{ _id: 'i1', _class: tracker.class.Issue, space: 'p1', milestone: 'm1' }]
    });

    const result = await client.deleteMilestone('PROJ', 'v1', 'v2');
    assert.equal(store.get(tracker.class.Issue)[0].milestone, 'm2');
    assert.equal(result.issuesMoved, 1);
    assert.equal(result.movedTo, 'v2');
  });

  it('clears assigned issues when no replacement is supplied', async () => {
    const { client, store } = harness({
      milestones: [{ _id: 'm1', _class: tracker.class.Milestone, space: 'p1', label: 'v1', status: 0 }],
      issues: [{ _id: 'i1', _class: tracker.class.Issue, space: 'p1', milestone: 'm1' }]
    });

    await client.deleteMilestone('PROJ', 'v1');
    assert.equal(store.get(tracker.class.Issue)[0].milestone, null);
  });
});
