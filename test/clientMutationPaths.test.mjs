/**
 * Taxonomy mutation paths and their newly tightened validation. These reject
 * rather than substituting a default, which is the behaviour that several
 * shipped defects violated.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HulyClient } from '../src/client.mjs';

function harness({ projects = [], milestones = [], taskTypes = [], projectTypes = [], statuses = [], employees = [] } = {}) {
  const calls = [];
  const pick = ref => {
    const name = String(ref);
    if (name.includes('ProjectType')) return projectTypes;
    if (name.includes('TaskType')) return taskTypes;
    if (name.includes('Project')) return projects;
    if (name.includes('Milestone')) return milestones;
    if (name.includes('IssueStatus')) return statuses;
    if (name.includes('Employee')) return employees;
    return [];
  };
  const matches = (doc, query) => Object.entries(query ?? {}).every(([k, v]) => doc[k] === v);
  const sdk = {
    calls,
    findOne: async (ref, query) => pick(ref).find(d => matches(d, query)) ?? null,
    findAll: async (ref, query) => pick(ref).filter(d => matches(d, query)),
    createDoc: async (ref, space, data, id) => { calls.push({ op: 'createDoc', ref: String(ref), space, data, id }); return id; },
    updateDoc: async (ref, space, id, data) => { calls.push({ op: 'updateDoc', ref: String(ref), space, id, data }); }
  };
  const client = new HulyClient({ url: 'https://huly.example.test', token: 't', workspace: 'w' });
  client._getClient = async () => sdk;
  return { client, sdk, calls };
}

const PROJECT = { _id: 'p1', identifier: 'PROJ', type: 'pt1' };

describe('updateMilestone validation', () => {
  const milestones = [{ _id: 'm1', space: 'p1', label: 'v1', status: 0 }];

  it('rejects an unknown status instead of reporting success with no write', async () => {
    const { client, calls } = harness({ projects: [PROJECT], milestones });
    await assert.rejects(
      () => client.updateMilestone('PROJ', 'v1', { status: 'finished' }),
      /Milestone status not found: finished/
    );
    assert.equal(calls.filter(c => c.op === 'updateDoc').length, 0);
  });

  it('rejects an unparseable target date instead of silently dropping it', async () => {
    const { client, calls } = harness({ projects: [PROJECT], milestones });
    await assert.rejects(
      () => client.updateMilestone('PROJ', 'v1', { targetDate: 'next friday' }),
      /Invalid date/
    );
    assert.equal(calls.filter(c => c.op === 'updateDoc').length, 0);
  });

  it('maps a valid status name to its numeric code and writes once', async () => {
    const { client, calls } = harness({ projects: [PROJECT], milestones });
    const result = await client.updateMilestone('PROJ', 'v1', {
      status: 'completed', targetDate: '2026-06-01'
    });
    const write = calls.find(c => c.op === 'updateDoc');
    assert.equal(write.data.status, 2, 'completed maps to 2');
    assert.equal(write.data.targetDate, new Date('2026-06-01').getTime());
    assert.equal(write.space, 'p1');
    assert.deepEqual(result.updated.sort(), ['status', 'targetDate']);
  });

  it('reports the missing project and milestone distinctly', async () => {
    const { client } = harness({ projects: [PROJECT], milestones });
    await assert.rejects(() => client.updateMilestone('NOPE', 'v1', {}), /Project not found: NOPE/);
    await assert.rejects(() => client.updateMilestone('PROJ', 'v9', {}), /Milestone not found: v9/);
  });
});

describe('createMilestone validation', () => {
  it('rejects an unparseable target date rather than substituting a default', async () => {
    const { client, calls } = harness({ projects: [PROJECT], milestones: [] });
    await assert.rejects(
      () => client.createMilestone('PROJ', 'v2', 'desc', 'not-a-date'),
      /Invalid date/
    );
    assert.equal(calls.filter(c => c.op === 'createDoc').length, 0);
  });

  it('returns the existing milestone rather than creating a duplicate', async () => {
    const { client, calls } = harness({
      projects: [PROJECT],
      milestones: [{ _id: 'm1', space: 'p1', label: 'v1' }]
    });
    const result = await client.createMilestone('PROJ', 'v1', 'desc');
    assert.match(result.message, /already exists/);
    assert.equal(result.id, 'm1');
    assert.equal(calls.filter(c => c.op === 'createDoc').length, 0);
  });

  it('rejects an unknown project', async () => {
    const { client } = harness({ projects: [], milestones: [] });
    await assert.rejects(() => client.createMilestone('NOPE', 'v1'), /Project not found: NOPE/);
  });
});

describe('project and task-type lookups', () => {
  it('refuses to create a project whose identifier is taken', async () => {
    const { client, calls } = harness({ projects: [PROJECT] });
    await assert.rejects(
      () => client.createProject('proj', 'Duplicate', 'desc'),
      /Project with identifier "PROJ" already exists/
    );
    assert.equal(calls.filter(c => c.op === 'createDoc').length, 0);
  });

  it('fails clearly when the workspace defines no project types', async () => {
    const { client } = harness({ projects: [], projectTypes: [] });
    await assert.rejects(() => client.createProject('NEW', 'New', 'desc'), /project type/i);
  });

  it('scopes listTaskTypes to the project and rejects an unknown one', async () => {
    const { client } = harness({
      projects: [PROJECT],
      projectTypes: [{ _id: 'pt1', tasks: ['tt-issue'] }],
      taskTypes: [
        { _id: 'tt-issue', name: 'Issue', statuses: [] },
        { _id: 'tt-other', name: 'Other', statuses: [] }
      ]
    });
    const page = await client.listTaskTypes('PROJ');
    assert.deepEqual(page.items.map(t => t.name), ['Issue'],
      'a task type belonging to another project type must not be listed');
    await assert.rejects(() => client.listTaskTypes('NOPE'), /Project not found: NOPE/);
  });

  it('reports a task type that exists only under a different project type', async () => {
    const { client } = harness({
      projects: [PROJECT],
      projectTypes: [{ _id: 'pt1', tasks: ['tt-issue'] }],
      taskTypes: [
        { _id: 'tt-issue', name: 'Issue', statuses: [] },
        { _id: 'tt-epic', name: 'Epic', statuses: [] }
      ]
    });
    await assert.rejects(() => client.getTaskType('PROJ', 'Epic'), /not found/i);
    await assert.rejects(() => client.getTaskType('NOPE', 'Issue'), /Project not found: NOPE/);
  });
});
