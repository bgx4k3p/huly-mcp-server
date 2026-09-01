import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;

const ACCOUNT_UUID = 'account-uuid';
const SPACE_ID = 'core:space:Space';

const CLASSIC_TYPE = { _id: 'classic-project-type', name: 'Classic project', targetClass: 'classic-project-mixin' };

// A workspace with HR or CRM modules enabled carries project types that cannot
// hold issues. They own task types of another class, which is how they are told
// apart from the tracker's.
const ISSUE_TASK_TYPE = { _id: 'tt-issue', name: 'Issue', ofClass: tracker.class.Issue };
const VACANCY_TASK_TYPE = { _id: 'tt-applicant', name: 'Applicant', ofClass: 'recruit:class:Applicant' };
const FUNNEL_TASK_TYPE = { _id: 'tt-lead', name: 'Lead', ofClass: 'lead:class:Lead' };

function createHarness({
  readable = true,
  rollbackFails = false,
  projectTypes = [CLASSIC_TYPE],
  taskTypes = []
} = {}) {
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
        return projectTypes;
      }
      if (String(classRef).includes('TaskType')) {
        return taskTypes;
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

describe('project type resolution', () => {
  const SCRUM_TYPE = { _id: 'scrum-project-type', name: 'Scrum project', targetClass: 'scrum-project-mixin' };
  const multiple = [CLASSIC_TYPE, SCRUM_TYPE];

  it('uses the only project type when the workspace has exactly one', async () => {
    const { client, calls } = createHarness();

    await client.createProject('solo', 'Solo', '');

    assert.equal(calls.createDoc[0].data.type, CLASSIC_TYPE._id);
  });

  it('creates against the named type when the workspace has several', async () => {
    const { client, calls } = createHarness({ projectTypes: multiple });

    await client.createProject('scrum', 'Scrum', '', false, 'Scrum project');

    assert.equal(calls.createDoc[0].data.type, SCRUM_TYPE._id);
    assert.equal(calls.createMixin[0][3], SCRUM_TYPE.targetClass);
  });

  it('matches a project type name case-insensitively, and by id', async () => {
    const byCase = createHarness({ projectTypes: multiple });
    await byCase.client.createProject('lower', 'Lower', '', false, 'scrum PROJECT');
    assert.equal(byCase.calls.createDoc[0].data.type, SCRUM_TYPE._id);

    const byId = createHarness({ projectTypes: multiple });
    await byId.client.createProject('byid', 'By id', '', false, SCRUM_TYPE._id);
    assert.equal(byId.calls.createDoc[0].data.type, SCRUM_TYPE._id);
  });

  it('refuses to guess when several issue-capable types exist and none was named', async () => {
    const { client, calls } = createHarness({
      projectTypes: [
        { ...CLASSIC_TYPE, tasks: ['tt-issue'] },
        { ...SCRUM_TYPE, tasks: ['tt-issue'] }
      ],
      taskTypes: [ISSUE_TASK_TYPE]
    });

    await assert.rejects(
      () => client.createProject('ambig', 'Ambiguous', ''),
      /Multiple project types found: Classic project, Scrum project\. Specify projectType explicitly\./
    );

    assert.equal(calls.createDoc.length, 0);
  });

  it('ignores HR and CRM types so their presence alone does not force the argument', async () => {
    // The HMCP-33 report: a workspace with recruit and lead modules could not
    // create a project at all without naming a type explicitly.
    const { client, calls } = createHarness({
      projectTypes: [
        { _id: 'recruit:template:DefaultVacancy', name: 'Default vacancy', tasks: ['tt-applicant'] },
        { _id: 'lead:template:DefaultFunnel', name: 'Default funnel', tasks: ['tt-lead'] },
        { ...CLASSIC_TYPE, tasks: ['tt-issue'] }
      ],
      taskTypes: [ISSUE_TASK_TYPE, VACANCY_TASK_TYPE, FUNNEL_TASK_TYPE]
    });

    await client.createProject('hrcrm', 'Tracker project', '');

    assert.equal(calls.createDoc[0].data.type, CLASSIC_TYPE._id);
  });

  it('lists only the issue-capable types when several of them remain', async () => {
    const { client } = createHarness({
      projectTypes: [
        { _id: 'recruit:template:DefaultVacancy', name: 'Default vacancy', tasks: ['tt-applicant'] },
        { ...CLASSIC_TYPE, tasks: ['tt-issue'] },
        { ...SCRUM_TYPE, tasks: ['tt-issue'] }
      ],
      taskTypes: [ISSUE_TASK_TYPE, VACANCY_TASK_TYPE]
    });

    // Naming a type the caller cannot usefully pick would be worse than useless.
    await assert.rejects(
      () => client.createProject('ambig', 'Ambiguous', ''),
      /Multiple project types found: Classic project, Scrum project\. Specify projectType explicitly\./
    );
  });

  it('falls back to listing every type when none owns a tracker task type', async () => {
    const { client } = createHarness({
      projectTypes: [
        { _id: 'recruit:template:DefaultVacancy', name: 'Default vacancy', tasks: ['tt-applicant'] },
        { _id: 'lead:template:DefaultFunnel', name: 'Default funnel', tasks: ['tt-lead'] }
      ],
      taskTypes: [VACANCY_TASK_TYPE, FUNNEL_TASK_TYPE]
    });

    await assert.rejects(
      () => client.createProject('none', 'None', ''),
      /Multiple project types found: Default vacancy, Default funnel\. Specify projectType explicitly\./
    );
  });

  it('lists the available types when the named one does not exist', async () => {
    const { client, calls } = createHarness({ projectTypes: multiple });

    await assert.rejects(
      () => client.createProject('typo', 'Typo', '', false, 'Kanban project'),
      /Project type "Kanban project" not found\. Available: Classic project, Scrum project/
    );

    assert.equal(calls.createDoc.length, 0);
  });

  it('reports a workspace with no project types instead of writing', async () => {
    const { client, calls } = createHarness({ projectTypes: [] });

    await assert.rejects(
      () => client.createProject('empty', 'Empty', ''),
      /No project types found in workspace/
    );

    assert.equal(calls.createDoc.length, 0);
  });
});
