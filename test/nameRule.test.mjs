/**
 * One naming rule for labels, components and milestones: names match ignoring case, and two items may never
 * differ only by case.
 */
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;

function harness(seed) {
  const state = { projects: [], components: [], milestones: [], labels: [], references: [], issues: [], ...seed };
  const writes = [];
  const collectionFor = classRef => ({
    [tracker.class.Project]: state.projects,
    [tracker.class.Component]: state.components,
    [tracker.class.Milestone]: state.milestones,
    [tags.class.TagElement]: state.labels,
    [tags.class.TagReference]: state.references,
    [tracker.class.Issue]: state.issues
  })[classRef] ?? [];
  const matches = (doc, query) => Object.entries(query).every(([key, value]) => doc[key] === value);
  const sdk = {
    findAll: async (classRef, query = {}) => collectionFor(classRef).filter(doc => matches(doc, query)),
    findOne: async (classRef, query = {}) => collectionFor(classRef).find(doc => matches(doc, query)) ?? null,
    createDoc: async (classRef, space, data, id) => { writes.push(['create', classRef, data]); collectionFor(classRef).push({ _id: id, space, ...data }); },
    updateDoc: async (classRef, space, id, data) => { writes.push(['update', classRef, id, data]); },
    addCollection: async (classRef, space, attachedTo, attachedToClass, collection, data) => {
      writes.push(['attach', classRef, attachedTo, data]);
    }
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'w' });
  client._getClient = async () => sdk;
  return { client, sdk, state, writes };
}

const project = { _id: 'proj', space: 'core:space:Space', identifier: 'PROJ', type: 'pt' };

describe('labels', () => {
  it('attaches the existing label when the name differs only by case', async () => {
    const { client, sdk, writes } = harness({ labels: [{ _id: 'tag-bug', title: 'Bug', space: 'proj', targetClass: tracker.class.Issue }] });

    await client._addLabelToIssue(sdk, 'issue-1', 'proj', 'bug');

    assert.deepEqual(writes.filter(write => write[0] === 'create'), [], 'no second label');
    assert.equal(writes.find(write => write[0] === 'attach')[3].tag, 'tag-bug');
  });

  it('reports the existing label instead of creating one that differs only by case', async () => {
    const { client, writes } = harness({
      projects: [project],
      labels: [{ _id: 'tag-bug', title: 'Bug', space: 'proj', targetClass: tracker.class.Issue }]
    });

    const result = await client.createLabel('bug');

    assert.equal(result.id, 'tag-bug');
    assert.deepEqual(writes, []);
  });

  it("refuses to rename a label onto another label's name", async () => {
    const { client, writes } = harness({
      labels: [
        { _id: 'tag-bug', title: 'Bug', space: 'proj', targetClass: tracker.class.Issue },
        { _id: 'tag-defect', title: 'Defect', space: 'proj', targetClass: tracker.class.Issue }
      ]
    });

    await assert.rejects(() => client.updateLabel('Defect', { newName: 'BUG' }), /Label "Bug" already exists/);
    assert.deepEqual(writes, []);
  });
});

describe('components', () => {
  it('reports the existing component instead of creating one that differs only by case', async () => {
    const { client, writes } = harness({ projects: [project], components: [{ _id: 'c-api', space: 'proj', label: 'API' }] });

    const result = await client.createComponent('PROJ', 'api');

    assert.equal(result.id, 'c-api');
    assert.deepEqual(writes, []);
  });

  it("refuses to rename a component onto another component's name", async () => {
    const { client, writes } = harness({
      projects: [project],
      components: [{ _id: 'c-api', space: 'proj', label: 'API' }, { _id: 'c-web', space: 'proj', label: 'Web' }]
    });

    await assert.rejects(() => client.updateComponent('PROJ', 'Web', { name: 'api' }), /Component "API" already exists/);
    assert.deepEqual(writes, []);
  });

  it('resolves a component for an issue ignoring case', async () => {
    const { client, sdk } = harness({ components: [{ _id: 'c-api', space: 'proj', label: 'API' }] });

    assert.equal((await client._findComponent(sdk, 'proj', 'api'))._id, 'c-api');
  });
});

describe('milestones', () => {
  it('resolves a milestone for an issue ignoring case', async () => {
    const { client, sdk } = harness({ milestones: [{ _id: 'm-1', space: 'proj', label: 'Release 1' }] });

    assert.equal((await client._findMilestone(sdk, 'proj', 'release 1'))._id, 'm-1');
  });

  it("refuses to rename a milestone onto another milestone's name", async () => {
    const { client, writes } = harness({
      projects: [project],
      milestones: [{ _id: 'm-1', space: 'proj', label: 'Release 1' }, { _id: 'm-2', space: 'proj', label: 'Release 2' }]
    });

    await assert.rejects(() => client.updateMilestone('PROJ', 'Release 2', { name: 'RELEASE 1' }), /Milestone "Release 1" already exists/);
    assert.deepEqual(writes, []);
  });
});
