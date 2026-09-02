import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { HulyClient } from '../src/client.mjs';
import {
  fromCollaboratorMarkup, fromMarkup, normalizeMarkup, toCollaboratorMarkup, toMarkup
} from '../src/helpers.mjs';
import { markdownPreview } from '../src/projection.mjs';

const ISSUE_CLASS = 'tracker:class:Issue';
const PROJECT_CLASS = 'tracker:class:Project';
const CHAT_MESSAGE_CLASS = 'chunter:class:ChatMessage';
const TIME_REPORT_CLASS = 'tracker:class:TimeSpendReport';

function stubClient(sdk) {
  const client = new HulyClient({
    url: 'https://huly.example.test',
    token: 't',
    workspace: 'w'
  });
  client._getClient = async () => sdk;
  return client;
}

/** Multi-issue stand-in for _parseAndFindIssue so relation sides stay distinguishable. */
function issueLookup(fixtures) {
  return async (_client, issueId) => {
    const found = fixtures[String(issueId).toUpperCase()];
    if (!found) throw new Error(`Issue not found: ${issueId}`);
    return found;
  };
}

function singleIssue(client, { space = 'project-space', issue = {} } = {}) {
  client._parseAndFindIssue = async () => ({
    project: { _id: space, identifier: 'PROJ' },
    issue: { _id: 'issue-id', _class: ISSUE_CLASS, reportedTime: 0, ...issue }
  });
  return client;
}

function nodeTypes(markup) {
  return JSON.parse(markup).content.map(node => node.type);
}

describe('comment writes', () => {
  it('stores the comment in the issue comments collection and honours the format', async () => {
    const calls = [];
    const client = singleIssue(stubClient({
      addCollection: async (...args) => { calls.push(args); }
    }));

    const result = await client.addComment('PROJ-1', '# Title', 'markdown');
    const [classRef, space, attachedTo, attachedToClass, collection, data, id] = calls[0];

    assert.equal(classRef, CHAT_MESSAGE_CLASS);
    assert.equal(space, 'project-space');
    assert.equal(attachedTo, 'issue-id');
    assert.equal(attachedToClass, ISSUE_CLASS);
    assert.equal(collection, 'comments');
    assert.equal(data.attachments, 0);
    assert.equal(id, result.id, 'the reported id must be the id actually written');
    assert.deepEqual(nodeTypes(data.message), ['heading']);

    // A dropped format argument would silently re-parse plain text as markdown.
    await client.addComment('PROJ-1', '# Title', 'plain');
    assert.deepEqual(nodeTypes(calls[1][5].message), ['paragraph']);
    assert.equal(fromCollaboratorMarkup(calls[1][5].message), '# Title');
  });

  it('updates the comment document itself and keeps the requested format', async () => {
    const updates = [];
    const client = singleIssue(stubClient({
      findOne: async (_class, query) => (
        query._id === 'comment-id'
          ? { _id: 'comment-id', space: 'project-space', attachedTo: 'issue-id' }
          : null
      ),
      updateDoc: async (...args) => { updates.push(args); }
    }));

    await client.updateComment('PROJ-1', 'comment-id', '# Ship it', 'html');
    const [classRef, space, objectId, data] = updates[0];

    assert.equal(classRef, CHAT_MESSAGE_CLASS);
    assert.equal(space, 'project-space');
    assert.equal(objectId, 'comment-id', 'writing to the issue id would corrupt the issue');
    // html input must not reach the markdown parser, which would build a heading.
    assert.deepEqual(nodeTypes(data.message), ['paragraph']);

    await assert.rejects(
      () => client.updateComment('PROJ-1', 'ghost', 'text'),
      /Comment not found: ghost/
    );
    assert.equal(updates.length, 1, 'an unknown comment must not produce a write');
  });

  it('deletes a comment through its own attachment metadata', async () => {
    const removals = [];
    const comment = {
      _id: 'comment-id',
      space: 'comment-space',
      attachedTo: 'issue-id',
      attachedToClass: ISSUE_CLASS,
      collection: 'comments'
    };
    const client = singleIssue(stubClient({
      findOne: async (_class, query) => (query._id === 'comment-id' ? comment : null),
      removeCollection: async (...args) => { removals.push(args); }
    }));

    await client.deleteComment('PROJ-1', 'comment-id');
    assert.deepEqual(removals[0], [
      CHAT_MESSAGE_CLASS, 'comment-space', 'comment-id', 'issue-id', ISSUE_CLASS, 'comments'
    ]);

    await assert.rejects(
      () => client.deleteComment('PROJ-1', 'ghost'),
      /Comment not found: ghost/
    );
    assert.equal(removals.length, 1);
  });
});

describe('comment reads', () => {
  it('queries by internal issue id and renders markup back to text', async () => {
    const queries = [];
    const comments = [
      {
        _id: 'c-old', space: 'project-space', message: toCollaboratorMarkup('**bold** text'),
        createdBy: 'acc-1', createdOn: 100, modifiedOn: 100
      },
      {
        _id: 'c-new', space: 'project-space', message: toCollaboratorMarkup('second'),
        createdBy: 'acc-2', createdOn: 200, modifiedOn: 250
      }
    ];
    const client = singleIssue(stubClient({
      findAll: async (_class, query) => { queries.push(query); return comments; }
    }));

    const page = await client.listComments('PROJ-1');

    // Querying by the "PROJ-1" identifier instead of the internal id returns nothing.
    assert.deepEqual(queries[0], { attachedTo: 'issue-id' });
    assert.equal(page.count, 2);
    assert.equal(page.hasMore, false);
    assert.deepEqual(page.items.map(item => item.id), ['c-new', 'c-old']);
    assert.equal(page.items[1].text, '**bold** text', 'raw ProseMirror JSON must not leak');
    assert.equal(page.items[0].createdBy, 'acc-2');
  });

  it('renders a single comment and rejects an unknown id', async () => {
    const client = singleIssue(stubClient({
      findOne: async (_class, query) => (
        query._id === 'comment-id'
          ? {
            _id: 'comment-id', space: 'project-space',
            message: toCollaboratorMarkup('# Heading\n\nbody'),
            createdBy: 'acc-1', createdOn: 100, modifiedOn: 150, editedOn: 150
          }
          : null
      )
    }));

    const comment = await client.getComment('PROJ-1', 'comment-id');
    assert.equal(comment.id, 'comment-id');
    assert.equal(comment.text, '# Heading\n\nbody');
    assert.equal(comment.editedOn, 150);

    await assert.rejects(() => client.getComment('PROJ-1', 'ghost'), /Comment not found: ghost/);
  });
});

describe('time report writes', () => {
  it('attaches the report to the issue reports collection', async () => {
    const calls = [];
    const updates = [];
    const client = singleIssue(stubClient({
      addCollection: async (...args) => { calls.push(args); },
      updateDoc: async (...args) => { updates.push(args); }
    }), { issue: { reportedTime: 2 } });

    const result = await client.logTime('PROJ-1', 1.5, 'work');
    const [classRef, space, attachedTo, attachedToClass, collection, data, id] = calls[0];

    assert.equal(classRef, TIME_REPORT_CLASS);
    assert.equal(space, 'project-space');
    assert.equal(attachedTo, 'issue-id');
    assert.equal(attachedToClass, ISSUE_CLASS);
    assert.equal(collection, 'reports', 'the wrong collection name hides the report from the UI');
    assert.equal(data.description, 'work');
    assert.equal(id, result.id);
    assert.deepEqual(updates[0].slice(0, 3), [ISSUE_CLASS, 'project-space', 'issue-id']);
    assert.equal(updates[0][3].reportedTime, 3.5);
  });

  it('resolves the employee or refuses to write an unattributed report', async () => {
    const calls = [];
    const client = singleIssue(stubClient({
      findAll: async () => [{ _id: 'emp-1', name: 'Ada Lovelace', active: true }],
      addCollection: async (...args) => { calls.push(args); },
      updateDoc: async () => {}
    }));

    await client.logTime('PROJ-1', 1, 'work', undefined, 'ada lovelace');
    assert.equal(calls[0][5].employee, 'emp-1');

    await assert.rejects(
      () => client.logTime('PROJ-1', 1, 'work', undefined, 'Nobody'),
      /Employee not found: Nobody/
    );
    assert.equal(calls.length, 1, 'an unresolved employee must not fall back to an unattributed report');

    await client.logTime('PROJ-1', 1, 'work');
    assert.equal(calls[1][5].employee, null, 'an omitted employee must be an explicit null');
  });

  it('defaults a missing date to now and preserves an explicit timestamp', async () => {
    const calls = [];
    const client = singleIssue(stubClient({
      addCollection: async (...args) => { calls.push(args); },
      updateDoc: async () => {}
    }));

    const before = Date.now();
    for (const date of [undefined, null, '']) {
      await client.logTime('PROJ-1', 1, 'work', date);
    }
    for (const [index, call] of calls.entries()) {
      const stored = call[5].date;
      assert.ok(Number.isFinite(stored), `date ${index} must be a finite timestamp`);
      assert.ok(stored >= before, `date ${index} must default to now`);
    }

    await client.logTime('PROJ-1', 1, 'work', 1700000000000);
    assert.equal(calls[3][5].date, 1700000000000);
    await client.logTime('PROJ-1', 1, 'work', new Date(1700000000000));
    assert.equal(calls[4][5].date, 1700000000000);
  });

  it('deletes a report without touching reportedTime itself', async () => {
    const removals = [];
    const updates = [];
    const report = {
      _id: 'report-id',
      space: 'report-space',
      attachedTo: 'issue-id',
      attachedToClass: ISSUE_CLASS,
      collection: 'reports',
      value: '1.5'
    };
    const client = stubClient({
      findOne: async (_class, query) => (query._id === 'report-id' ? report : null),
      removeCollection: async (...args) => { removals.push(args); },
      updateDoc: async (...args) => { updates.push(args); }
    });

    const result = await client.deleteTimeReport('report-id');
    assert.deepEqual(removals[0], [
      TIME_REPORT_CLASS, 'report-space', 'report-id', 'issue-id', ISSUE_CLASS, 'reports'
    ]);
    // The transactor already decrements reportedTime; a manual update double-counts.
    assert.equal(updates.length, 0);
    assert.equal(result.hours, 1.5);

    await assert.rejects(() => client.deleteTimeReport('ghost'), /Time report not found: ghost/);
  });

  it('normalizes hours and dates on both report read paths', async () => {
    const queries = [];
    const reports = [
      { _id: 'r-old', value: '2.5', date: 1700000000000, description: 'a', createdOn: 100 },
      { _id: 'r-new', value: undefined, date: null, description: '', createdOn: 200 }
    ];
    const client = singleIssue(stubClient({
      findAll: async (_class, query) => { queries.push(query); return reports; },
      findOne: async (_class, query) => reports.find(r => r._id === query._id) ?? null
    }));

    const page = await client.listTimeReports('PROJ-1');
    assert.deepEqual(queries[0], { attachedTo: 'issue-id' });
    assert.deepEqual(page.items.map(item => item.id), ['r-new', 'r-old']);
    assert.equal(page.items[1].hours, 2.5, 'a string value would reach the API uncoerced');
    assert.equal(page.items[1].date, new Date(1700000000000).toISOString());
    assert.equal(page.items[0].hours, 0);
    assert.equal(page.items[0].date, null);

    const single = await client.getTimeReport('PROJ-1', 'r-old');
    assert.equal(single.hours, 2.5);
    assert.equal(single.date, new Date(1700000000000).toISOString());
    await assert.rejects(() => client.getTimeReport('PROJ-1', 'ghost'), /Time report not found: ghost/);
  });
});

describe('issue relations', () => {
  const relationFixtures = () => ({
    'PROJ-1': {
      project: { _id: 'space-a', identifier: 'PROJ' },
      issue: { _id: 'issue-a', _class: ISSUE_CLASS, number: 1, relations: [], blockedBy: [] }
    },
    'OTHER-9': {
      project: { _id: 'space-b', identifier: 'OTHER' },
      issue: { _id: 'issue-b', _class: ISSUE_CLASS, number: 9, relations: [], blockedBy: [] }
    }
  });

  it('writes both sides of a relation into their own project spaces', async () => {
    const updates = [];
    const client = stubClient({ updateDoc: async (...args) => { updates.push(args); } });
    client._parseAndFindIssue = issueLookup(relationFixtures());

    await client.addRelation('PROJ-1', 'OTHER-9');

    assert.equal(updates.length, 2);
    assert.deepEqual(updates[0], [ISSUE_CLASS, 'space-a', 'issue-a', {
      relations: [{ _id: 'issue-b', _class: ISSUE_CLASS }]
    }]);
    // The reverse write must land in the target issue's space, not the source's.
    assert.deepEqual(updates[1], [ISSUE_CLASS, 'space-b', 'issue-b', {
      relations: [{ _id: 'issue-a', _class: ISSUE_CLASS }]
    }]);
  });

  it('is idempotent when the relation already exists', async () => {
    const updates = [];
    const fixtures = relationFixtures();
    fixtures['PROJ-1'].issue.relations = [{ _id: 'issue-b', _class: ISSUE_CLASS }];
    fixtures['OTHER-9'].issue.relations = [{ _id: 'issue-a', _class: ISSUE_CLASS }];
    const client = stubClient({ updateDoc: async (...args) => { updates.push(args); } });
    client._parseAndFindIssue = issueLookup(fixtures);

    const result = await client.addRelation('PROJ-1', 'OTHER-9');
    assert.match(result.message, /already related/);
    assert.equal(updates.length, 0);
  });

  it('records the blocker on the blocked issue only, preserving existing entries', async () => {
    const updates = [];
    const fixtures = relationFixtures();
    fixtures['PROJ-1'].issue.blockedBy = [{ _id: 'issue-c', _class: ISSUE_CLASS }];
    const client = stubClient({ updateDoc: async (...args) => { updates.push(args); } });
    client._parseAndFindIssue = issueLookup(fixtures);

    await client.addBlockedBy('PROJ-1', 'OTHER-9');

    assert.equal(updates.length, 1, 'the blocker must not be modified');
    assert.deepEqual(updates[0], [ISSUE_CLASS, 'space-a', 'issue-a', {
      blockedBy: [
        { _id: 'issue-c', _class: ISSUE_CLASS },
        { _id: 'issue-b', _class: ISSUE_CLASS }
      ]
    }]);

    fixtures['PROJ-1'].issue.blockedBy = [{ _id: 'issue-b', _class: ISSUE_CLASS }];
    await client.addBlockedBy('PROJ-1', 'OTHER-9');
    assert.equal(updates.length, 1, 'an existing dependency must not be re-written');
  });
});

describe('parent linking', () => {
  function parentHarness({ child = {}, parentChildInfo = [], oldParent = null } = {}) {
    const calls = { collections: [], updates: [] };
    const parentIssue = {
      _id: 'parent-id', _class: ISSUE_CLASS, number: 7, title: 'Epic',
      parents: [{ parentId: 'gp-id', identifier: 'OTHER-3', parentTitle: 'Root', space: 'space-b' }],
      childInfo: parentChildInfo
    };
    const client = stubClient({
      findOne: async (classRef, query) => {
        if (classRef === PROJECT_CLASS) {
          return query._id === 'space-c' ? { _id: 'space-c', identifier: 'OLD' } : null;
        }
        return query._id === 'old-parent-id' ? oldParent : null;
      },
      updateCollection: async (...args) => { calls.collections.push(args); },
      updateDoc: async (...args) => { calls.updates.push(args); }
    });
    client._parseAndFindIssue = issueLookup({
      'PROJ-2': {
        project: { _id: 'space-a', identifier: 'PROJ' },
        issue: {
          _id: 'child-id', _class: ISSUE_CLASS, number: 2,
          estimation: '3', reportedTime: 1.5, ...child
        }
      },
      'OTHER-7': { project: { _id: 'space-b', identifier: 'OTHER' }, issue: parentIssue }
    });
    return { client, calls };
  }

  it('attaches the child to subIssues and rebuilds the ancestor chain', async () => {
    const { client, calls } = parentHarness();
    const result = await client.setParent('PROJ-2', 'OTHER-7');

    assert.deepEqual(calls.collections[0], [
      ISSUE_CLASS, 'space-a', 'child-id', 'parent-id', ISSUE_CLASS, 'subIssues',
      {
        parents: [
          { parentId: 'gp-id', identifier: 'OTHER-3', parentTitle: 'Root', space: 'space-b' },
          { parentId: 'parent-id', identifier: 'OTHER-7', parentTitle: 'Epic', space: 'space-b' }
        ],
        attachedTo: 'parent-id',
        attachedToClass: ISSUE_CLASS,
        collection: 'subIssues'
      }
    ]);
    // childInfo is written on the parent, in the parent's own space.
    assert.deepEqual(calls.updates[0], [ISSUE_CLASS, 'space-b', 'parent-id', {
      childInfo: [{ childId: 'child-id', estimation: 3, reportedTime: 1.5 }],
      subIssues: 1
    }]);
    assert.equal(result.parentChildCount, 1);
  });

  it('replaces a stale child entry instead of duplicating it', async () => {
    const { client, calls } = parentHarness({
      parentChildInfo: [
        { childId: 'sibling-id', estimation: 1, reportedTime: 0 },
        { childId: 'child-id', estimation: 0, reportedTime: 0 }
      ]
    });

    await client.setParent('PROJ-2', 'OTHER-7');
    assert.deepEqual(calls.updates[0][3], {
      childInfo: [
        { childId: 'sibling-id', estimation: 1, reportedTime: 0 },
        { childId: 'child-id', estimation: 3, reportedTime: 1.5 }
      ],
      subIssues: 2
    });
  });

  it('detaches the child from its previous parent in that parent own space', async () => {
    const { client, calls } = parentHarness({
      child: { attachedTo: 'old-parent-id', attachedToClass: ISSUE_CLASS },
      oldParent: {
        _id: 'old-parent-id',
        space: 'space-c',
        childInfo: [{ childId: 'child-id' }, { childId: 'other-child' }]
      }
    });

    await client.setParent('PROJ-2', 'OTHER-7');

    assert.deepEqual(calls.updates[0], [ISSUE_CLASS, 'space-c', 'old-parent-id', {
      childInfo: [{ childId: 'other-child' }],
      subIssues: 1
    }]);
    assert.equal(calls.updates[1][2], 'parent-id', 'the new parent is still linked');
  });
});

describe('issue templates', () => {
  function templateHarness({ taskTypes = [], failParentLink = false } = {}) {
    const created = [];
    const links = [];
    const client = stubClient({ findAll: async () => taskTypes });
    client.createIssue = async (project, title, description, priority, status, labels, type) => {
      created.push({ project, title, description, priority, status, labels, type });
      return { id: `PROJ-${created.length}`, title };
    };
    client.setParent = async (issueId, parentId) => {
      if (failParentLink) throw new Error('parent link rejected');
      links.push([issueId, parentId]);
    };
    return { client, created, links };
  }

  it('lists the available templates without creating anything', async () => {
    const { client, created } = templateHarness();
    const result = await client.createIssuesFromTemplate('PROJ', 'epicc');

    assert.match(result.error, /Unknown template: "epicc"/);
    assert.deepEqual(result.availableTemplates.map(t => t.name),
      ['feature', 'bug', 'sprint', 'release']);
    assert.equal(created.length, 0);
  });

  it('uses version only when title is omitted, and only for the release template', async () => {
    const both = templateHarness();
    await both.client.createIssuesFromTemplate('PROJ', 'release', { title: 'Ship It', version: '2.0' });
    assert.equal(both.created[0].title, '[Release] Ship It');

    const versionOnly = templateHarness();
    await versionOnly.client.createIssuesFromTemplate('PROJ', 'release', { version: '2.0' });
    assert.equal(versionOnly.created[0].title, '[Release] 2.0');
    assert.equal(versionOnly.created[1].title, 'Feature freeze: 2.0');

    const neither = templateHarness();
    await neither.client.createIssuesFromTemplate('PROJ', 'release', {});
    assert.equal(neither.created[0].title, '[Release] Release');

    // version is advertised for the release template only; it must not leak elsewhere.
    const feature = templateHarness();
    await feature.client.createIssuesFromTemplate('PROJ', 'feature', { version: '2.0' });
    assert.equal(feature.created[0].title, '[Feature] New Feature');
  });

  it('requests a task type only when the workspace defines it', async () => {
    const missing = templateHarness();
    await missing.client.createIssuesFromTemplate('PROJ', 'feature', { title: 'Search' });
    assert.equal(missing.created[0].type, undefined, 'an unknown task type would fail the create');
    assert.equal(missing.created[0].priority, 'medium');
    assert.deepEqual(missing.created[1].labels, ['design']);

    const present = templateHarness({ taskTypes: [{ name: 'Epic' }] });
    await present.client.createIssuesFromTemplate('PROJ', 'feature', { title: 'Search' });
    assert.equal(present.created[0].type, 'Epic');
    assert.equal(present.created[1].type, undefined, 'children declare no type');
  });

  it('links children to the parent and records link failures without aborting', async () => {
    const linked = templateHarness();
    const ok = await linked.client.createIssuesFromTemplate('PROJ', 'bug', { title: 'Crash' });
    assert.equal(ok.total, 5);
    assert.deepEqual(linked.links, [
      ['PROJ-2', 'PROJ-1'], ['PROJ-3', 'PROJ-1'], ['PROJ-4', 'PROJ-1'], ['PROJ-5', 'PROJ-1']
    ]);
    assert.deepEqual(ok.errors, []);

    const broken = templateHarness({ failParentLink: true });
    const result = await broken.client.createIssuesFromTemplate('PROJ', 'bug', { title: 'Crash' });
    assert.equal(result.total, 5, 'every issue is still created');
    assert.equal(result.errors.length, 4);
    assert.deepEqual(result.errors[0], {
      childId: 'PROJ-2', parentId: 'PROJ-1', error: 'parent link rejected'
    });
  });
});

// Every construct this server can emit is validated against Huly's real editor
// schema. jsonToPmNode resolves node types and attrs, and Node.check() validates
// content expressions — a doc that fails either renders blank in the Huly UI.
// This replaces eyeballing descriptions in a browser.
const { jsonToPmNode, markupToJSON } = createRequire(import.meta.url)('@hcengineering/text');

describe('editor schema conformance', () => {

  const CONSTRUCTS = [
    ['inline marks', 'markdown', 'Some **bold**, *italic* and `code`.'],
    ['heading', 'markdown', '# Heading one'],
    ['bullet list', 'markdown', '- one\n- two'],
    ['nested bullet list', 'markdown', '- one\n- two\n  - nested'],
    ['ordered list', 'markdown', '1. first\n2. second'],
    ['blockquote', 'markdown', '> a blockquote'],
    ['code block', 'markdown', '```js\nconst a = 1;\n```'],
    ['link', 'markdown', 'A [link](https://example.test/d)'],
    ['strikethrough', 'markdown', '~~strike~~'],
    ['task list', 'markdown', '- [ ] no\n- [x] yes'],
    ['table', 'markdown', '| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['image', 'markdown', '![alt](https://x.test/i.png)'],
    ['horizontal rule', 'markdown', 'a\n\n---\n\nb'],
    ['html input', 'html', '<h1>T</h1><p>body <b>b</b></p>'],
    ['plain text', 'plain', 'one line'],
    ['plain multiline', 'plain', 'line one\nline two\n\nline four'],
    ['empty description', 'markdown', '']
  ];

  for (const [label, format, source] of CONSTRUCTS) {
    it(`emits a schema-valid document for ${label}`, () => {
      for (const encode of [toMarkup, toCollaboratorMarkup]) {
        const node = jsonToPmNode(markupToJSON(encode(source, format)));
        node.check();
      }
    });
  }

  it('drops mark combinations the schema excludes', () => {
    // markdownToMarkup emits bold+code for **`x`**, but the code mark declares
    // excludes: "_", so the document fails check() and the UI renders nothing.
    const stored = toMarkup('Step 3: **`FAIR`** inputs', 'markdown');
    jsonToPmNode(markupToJSON(stored)).check();
    const marks = JSON.parse(stored).content[0].content.flatMap(n => (n.marks ?? []).map(m => m.type));
    assert.deepEqual(marks, ['code'], 'code excludes bold');
    // marks that do not exclude each other are left alone
    const kept = JSON.parse(toMarkup('***both***', 'markdown')).content[0].content[0].marks.map(m => m.type);
    assert.deepEqual(kept.sort(), ['bold', 'italic']);
  });

  it('re-normalizes an already-stored document that violates the schema', () => {
    const broken = JSON.stringify({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'code' }] }] }]
    });
    assert.throws(() => jsonToPmNode(markupToJSON(broken)).check());
    jsonToPmNode(markupToJSON(normalizeMarkup(broken))).check();

    // the other stored-invalid shape: a doc with no children
    const childless = JSON.stringify({ type: 'doc', content: [] });
    assert.throws(() => jsonToPmNode(markupToJSON(childless)).check());
    jsonToPmNode(markupToJSON(normalizeMarkup(childless))).check();
  });

  it('encodes an empty description as Huly\'s canonical empty node', () => {
    // { doc, content: [] } passes isEmptyMarkup but fails the doc's block+
    // content expression, which blanks the description in the Huly UI.
    assert.deepEqual(JSON.parse(toMarkup('')), {
      type: 'doc', content: [{ type: 'paragraph', content: [] }]
    });
    assert.equal(fromMarkup(toMarkup('')), '');
  });
});

describe('markup conversion', () => {
  // Milestone/component descriptions are `Markup` fields: a STRING holding a
  // ProseMirror JSON doc. Handing the SDK's MarkupContent wrapper to
  // TxOperations persists {"content":..,"kind":..} and the Huly UI renders
  // nothing, while fromMarkup() still reads it back — so a round-trip through
  // this server cannot catch the regression. Assert the wire shape directly.
  it('encodes inline markup as a ProseMirror JSON string, not MarkupContent', () => {
    for (const format of ['markdown', 'html', 'plain', undefined]) {
      const stored = toMarkup('# Hi', format);
      assert.equal(typeof stored, 'string', `${format} must produce a string`);
      assert.equal(JSON.parse(stored).type, 'doc');
    }
    assert.deepEqual(JSON.parse(toMarkup('')), {
      type: 'doc', content: [{ type: 'paragraph', content: [] }]
    });
  });

  it('routes each inline-markup format to its own parser', () => {
    assert.deepEqual(nodeTypes(toMarkup('# Title', 'markdown')), ['heading']);
    assert.deepEqual(nodeTypes(toMarkup('# Title', 'html')), ['paragraph']);
    assert.deepEqual(nodeTypes(toMarkup('# Title', 'plain')), ['paragraph']);
    assert.deepEqual(nodeTypes(toMarkup('<h1>Title</h1>', 'html')), ['heading']);
  });

  it('round-trips inline markup through fromMarkup', () => {
    const text = 'Updated **description** with `code`';
    assert.equal(fromMarkup(toMarkup(text, 'markdown')), text);
    assert.equal(fromMarkup(toMarkup('', 'markdown')), '');
    // legacy docs written before the fix must still read back
    assert.equal(fromMarkup({ content: 'legacy value', kind: 'markdown' }), 'legacy value');
  });

  it('routes each collaborator format to its own parser', () => {
    assert.deepEqual(nodeTypes(toCollaboratorMarkup('# Title', 'markdown')), ['heading']);
    assert.deepEqual(nodeTypes(toCollaboratorMarkup('# Title', 'html')), ['paragraph']);
    assert.deepEqual(nodeTypes(toCollaboratorMarkup('# Title', 'plain')), ['paragraph']);
    assert.deepEqual(nodeTypes(toCollaboratorMarkup('<h1>Title</h1>', 'html')), ['heading']);
    // empty must be one empty paragraph — a doc with no children fails block+
    assert.deepEqual(JSON.parse(toCollaboratorMarkup('', 'markdown')).content, [{ type: 'paragraph', content: [] }]);
  });

  it('round-trips markdown structure without losing content', () => {
    const markdown = '# Heading\n\nSome **bold** and `code`.\n\n- a\n- b';
    assert.equal(fromCollaboratorMarkup(toCollaboratorMarkup(markdown, 'markdown')), markdown);

    const fenced = 'Intro\n\n```js\nconst a = 1;\n```';
    assert.equal(fromCollaboratorMarkup(toCollaboratorMarkup(fenced, 'markdown')), fenced);

    const links = 'See [docs](https://example.test/a_b) and ![img](https://x.test/i.png)';
    assert.equal(fromCollaboratorMarkup(toCollaboratorMarkup(links, 'markdown')), links);

    assert.equal(
      fromCollaboratorMarkup(toCollaboratorMarkup('<h1>Title</h1><p>body</p>', 'html')),
      '# Title\n\nbody'
    );
    assert.equal(
      fromCollaboratorMarkup(toCollaboratorMarkup('<p>Hello <strong>world</strong></p>', 'html'), 'html'),
      '<p>Hello <strong>world</strong></p>'
    );
    // plain text must survive verbatim, markup characters included.
    assert.equal(
      fromCollaboratorMarkup(toCollaboratorMarkup('# Not a heading *literal*', 'plain')),
      '# Not a heading *literal*'
    );
    assert.equal(fromCollaboratorMarkup(toCollaboratorMarkup('', 'markdown')), '');
  });

  it('reads every shape a Huly text field can hold', () => {
    assert.equal(fromMarkup(toMarkup('hello', 'plain')), 'hello');
    assert.equal(fromMarkup(toCollaboratorMarkup('**bold** text')), '**bold** text');
    // A collaborator reference must be returned untouched, not parsed.
    assert.equal(fromMarkup('68f1c2-description-1700000000000'), '68f1c2-description-1700000000000');
    assert.equal(fromMarkup('just a plain sentence'), 'just a plain sentence');
    assert.equal(fromMarkup(null), '');
    assert.equal(fromMarkup(undefined), '');
    assert.throws(() => fromMarkup('{"type":"doc"'), /Corrupted markup/);
  });
});

describe('markdown preview truncation', () => {
  it('cuts only past the limit and flags exactly what it cut', () => {
    const text = 'x'.repeat(50);
    assert.deepEqual(markdownPreview(text, 50), { text, truncated: false });
    assert.deepEqual(markdownPreview(text, 0), { text, truncated: false });
    assert.deepEqual(markdownPreview(undefined, 500), { text: undefined, truncated: false });

    const preview = markdownPreview(`${text}y`, 50);
    assert.equal(preview.truncated, true);
    assert.ok(preview.text.endsWith('…'));
    assert.equal(preview.text.length, 51);
  });

  it('never leaves a dangling inline-code or link delimiter', () => {
    const words = 'word '.repeat(30);

    const code = markdownPreview(`${words}\`inline code that runs past the limit\` tail`, 160);
    assert.equal(code.truncated, true);
    assert.equal((code.text.match(/`/g) ?? []).length % 2, 0);
    assert.ok(!code.text.includes('`'));

    const link = markdownPreview(`${words}[link text that keeps going](https://example.test)`, 160);
    assert.ok(!link.text.includes('['));

    // The preview must stay a verbatim prefix of the source.
    for (const [source, result] of [
      [`${words}\`inline code that runs past the limit\` tail`, code],
      [`${words}[link text that keeps going](https://example.test)`, link]
    ]) {
      assert.ok(source.startsWith(result.text.slice(0, -1)), 'preview mangled the source text');
    }
  });

  it('accepts a break point only at or beyond the 60% floor', () => {
    // maximum 40 puts the floor at 24 characters.
    const lateBreak = 'First paragraph is long here.\n\nSecond paragraph runs past the limit.';
    assert.equal(markdownPreview(lateBreak, 40).text, 'First paragraph is long here.…');

    // The paragraph break sits at 6, well under the floor, so a later word
    // boundary wins — honouring it would throw away most of the budget.
    const earlyBreak = 'Short.\n\nSecond paragraph continues past the limit here.';
    assert.equal(markdownPreview(earlyBreak, 40).text, 'Short.\n\nSecond paragraph continues past…');

    const newline = 'First line that is fairly long\nsecond line runs past the limit.';
    assert.equal(markdownPreview(newline, 40).text, 'First line that is fairly long…');

    // No qualifying boundary at all: cut at the limit rather than collapse.
    const unbroken = 'a'.repeat(200);
    const hard = markdownPreview(unbroken, 100);
    assert.equal(hard.text, `${'a'.repeat(100)}…`);
    assert.equal(hard.truncated, true);

    for (const [source, maximum] of [
      [lateBreak, 40], [earlyBreak, 40], [newline, 40], [unbroken, 100]
    ]) {
      const result = markdownPreview(source, maximum);
      assert.ok(result.text.length <= maximum + 1, 'preview must fit the budget plus the ellipsis');
      assert.equal(result.truncated, source.length > maximum);
    }
  });
});
