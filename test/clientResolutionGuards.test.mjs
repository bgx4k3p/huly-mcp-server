/**
 * Resolution guards. Every one of these throws instead of substituting a
 * default, because the failure mode this codebase keeps producing is a lookup
 * that quietly falls back and reports success for work it never did.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HulyClient } from '../src/client.mjs';

function stubClient(sdk) {
  const client = new HulyClient({
    url: 'https://huly.example.test', token: 't', workspace: 'w'
  });
  client._getClient = async () => sdk;
  return client;
}

/** Fake SDK whose findOne/findAll answer from fixture arrays keyed by class. */
function harness({ projects = [], issues = [], milestones = [], components = [], taskTypes = [], projectTypes = [], employees = [] } = {}) {
  const pick = ref => {
    const name = String(ref);
    if (name.includes('Project') && !name.includes('ProjectType')) return projects;
    if (name.includes('ProjectType')) return projectTypes;
    if (name.includes('TaskType')) return taskTypes;
    if (name.includes('Milestone')) return milestones;
    if (name.includes('Component')) return components;
    if (name.includes('Issue')) return issues;
    if (name.includes('Employee')) return employees;
    return [];
  };
  const matches = (doc, query) => Object.entries(query ?? {}).every(([k, v]) => {
    if (v && typeof v === 'object' && Array.isArray(v.$in)) return v.$in.includes(doc[k]);
    return doc[k] === v;
  });
  return {
    findOne: async (ref, query) => pick(ref).find(d => matches(d, query)) ?? null,
    findAll: async (ref, query) => pick(ref).filter(d => matches(d, query))
  };
}

describe('issue identifier resolution', () => {
  it('rejects a malformed identifier before touching the SDK', async () => {
    let queried = 0;
    const sdk = { findOne: async () => { queried += 1; return null; } };
    const client = stubClient(sdk);
    for (const bad of ['PROJ', 'PROJ-', '-42', 'PROJ 42', 'PROJ--42']) {
      await assert.rejects(
        () => client._parseAndFindIssue(sdk, bad),
        /Invalid issue ID format/,
        `expected ${bad} to be rejected`
      );
    }
    assert.equal(queried, 0, 'a malformed id must not reach the database');
  });

  it('distinguishes an unknown project from an unknown issue number', async () => {
    const sdk = harness({ projects: [{ _id: 'p1', identifier: 'PROJ' }], issues: [] });
    const client = stubClient(sdk);
    await assert.rejects(() => client._parseAndFindIssue(sdk, 'NOPE-1'), /Project not found: NOPE/);
    await assert.rejects(() => client._parseAndFindIssue(sdk, 'PROJ-9'), /Issue not found: PROJ-9/);
  });

  it('accepts a lowercase identifier and resolves it case-insensitively', async () => {
    const sdk = harness({
      projects: [{ _id: 'p1', identifier: 'PROJ' }],
      issues: [{ _id: 'i1', space: 'p1', number: 42 }]
    });
    const { issue, project } = await stubClient(sdk)._parseAndFindIssue(sdk, 'proj-42');
    assert.equal(issue._id, 'i1');
    assert.equal(project._id, 'p1');
  });
});

describe('name resolution guards', () => {
  it('reports the missing milestone and component by name', async () => {
    const sdk = harness({ milestones: [], components: [] });
    const client = stubClient(sdk);
    await assert.rejects(() => client._findMilestoneByName(sdk, 'p1', 'v9'), /Milestone not found: v9/);
    await assert.rejects(() => client._findComponentByName(sdk, 'p1', 'API'), /Component not found: API/);
  });

  it('scopes milestone and component lookups to the requested project', async () => {
    const sdk = harness({
      milestones: [{ _id: 'm-other', space: 'other', label: 'v1' }],
      components: [{ _id: 'c-other', space: 'other', label: 'API' }]
    });
    const client = stubClient(sdk);
    // Same names exist, but in a different project — they must not resolve.
    await assert.rejects(() => client._findMilestoneByName(sdk, 'p1', 'v1'), /Milestone not found/);
    await assert.rejects(() => client._findComponentByName(sdk, 'p1', 'API'), /Component not found/);
  });
});

describe('task type resolution', () => {
  const project = { _id: 'p1', identifier: 'PROJ', type: 'pt1' };

  it('lists the available types when the requested one does not exist', async () => {
    const sdk = harness({
      projects: [project],
      projectTypes: [{ _id: 'pt1', tasks: ['tt-issue', 'tt-bug'] }],
      taskTypes: [
        { _id: 'tt-issue', name: 'Issue', statuses: [] },
        { _id: 'tt-bug', name: 'Bug', statuses: [] }
      ]
    });
    await assert.rejects(
      () => stubClient(sdk)._findTaskTypeByName(sdk, 'PROJ', 'Epic'),
      /Task type "Epic" not found\. Available types: Issue, Bug/
    );
  });

  it('rejects an unknown project rather than searching every task type', async () => {
    const sdk = harness({ projects: [], projectTypes: [], taskTypes: [] });
    await assert.rejects(
      () => stubClient(sdk)._findTaskTypeByName(sdk, 'NOPE', 'Issue'),
      /Project not found: NOPE/
    );
  });

  it('explains itself when the project type configures no task types', async () => {
    const sdk = harness({
      projects: [project],
      projectTypes: [{ _id: 'pt1', tasks: [] }],
      taskTypes: []
    });
    await assert.rejects(
      () => stubClient(sdk)._getDefaultTaskType(sdk, project),
      /No task types configured for project "PROJ"/
    );
  });
});
