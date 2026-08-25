import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  boundedCollection,
  COMPACT_LIST_FIELDS,
  ISSUE_BASE_FIELDS,
  ISSUE_INCLUDE_FIELDS,
  markdownPreview,
  normalizeIssueReadOptions,
  projectIssueFields
} from '../src/projection.mjs';

describe('issue field and include projections', () => {
  it('uses compact list fields and complete raw fields', () => {
    assert.deepEqual(
      [...normalizeIssueReadOptions({ responseMode: 'compact' }, 'list').fields],
      COMPACT_LIST_FIELDS
    );
    assert.deepEqual(
      [...normalizeIssueReadOptions({ responseMode: 'raw' }, 'list').fields],
      ISSUE_BASE_FIELDS
    );
  });

  it('gives explicit fields and include precedence over response defaults', () => {
    const options = normalizeIssueReadOptions({
      responseMode: 'raw',
      fields: ['title'],
      include: ['comments'],
      commentsLimit: 7
    }, 'list');
    assert.deepEqual([...options.fields], ['title', 'id']);
    assert.deepEqual([...options.include], ['comments']);
    assert.equal(options.limits.comments, 7);
  });

  it('covers every supported field/include cross-product', () => {
    for (const field of ISSUE_BASE_FIELDS) {
      for (const include of ISSUE_INCLUDE_FIELDS) {
        const options = normalizeIssueReadOptions({
          responseMode: 'compact',
          fields: [field],
          include: [include]
        }, 'list');
        assert.equal(options.fields.has(field), true, field);
        assert.equal(options.fields.has('id'), true, 'id is always retained');
        assert.deepEqual([...options.include], [include]);
      }
    }
  });

  it('implements compact, raw, explicit include, and full-content precedence', () => {
    const cases = [
      [{ responseMode: 'compact' }, 'list', COMPACT_LIST_FIELDS, [], 500],
      [{ responseMode: 'raw' }, 'list', ISSUE_BASE_FIELDS, [], 500],
      [{ responseMode: 'compact', include: ISSUE_INCLUDE_FIELDS }, 'list', COMPACT_LIST_FIELDS, ISSUE_INCLUDE_FIELDS, 500],
      [{ responseMode: 'compact', include: [] }, 'list', COMPACT_LIST_FIELDS, [], 500],
      [{ responseMode: 'compact', include: ['description'], descriptionPreviewChars: 0 }, 'list', COMPACT_LIST_FIELDS, ['description'], 0],
      [{ responseMode: 'compact' }, 'single', ISSUE_BASE_FIELDS, ['description'], 0]
    ];
    for (const [input, kind, fields, include, preview] of cases) {
      const normalized = normalizeIssueReadOptions(input, kind);
      assert.deepEqual([...normalized.fields], fields);
      assert.deepEqual([...normalized.include], include);
      assert.equal(normalized.descriptionPreviewChars, preview);
    }
  });

  it('bounds granular reads and always emits expansion metadata', () => {
    const granular = normalizeIssueReadOptions({
      responseMode: 'raw', include: ['comments'], commentsLimit: 4
    }, 'list');
    assert.equal(granular.limits.comments, 4);
    assert.equal(granular.emitExpansionMetadata, true);
  });

  it('keeps full single-issue descriptions by default', () => {
    const options = normalizeIssueReadOptions({ responseMode: 'compact' }, 'single');
    assert.equal(options.include.has('description'), true);
    assert.equal(options.descriptionPreviewChars, 0);
  });

  it('rejects every unsupported field, include, preview, and nested limit', () => {
    assert.throws(() => normalizeIssueReadOptions({ fields: ['secret'] }), /Unsupported fields/);
    assert.throws(() => normalizeIssueReadOptions({ include: ['transactions'] }), /Unsupported include/);
    assert.throws(() => normalizeIssueReadOptions({ descriptionPreviewChars: 99 }), /100 to 5000/);
    assert.throws(() => normalizeIssueReadOptions({ childrenLimit: 101 }), /1 to 100/);
    assert.deepEqual(ISSUE_INCLUDE_FIELDS, [
      'description', 'comments', 'activity', 'timeReports', 'relations', 'blockedBy', 'children'
    ]);
  });

  it('projects selected fields while retaining requested include metadata', () => {
    const options = normalizeIssueReadOptions({
      responseMode: 'compact', fields: ['title'], include: ['children']
    }, 'list');
    assert.deepEqual(projectIssueFields({
      id: 'P-1', title: 'Title', status: 'Todo', children: [{ id: 'P-2' }],
      childrenCount: 2, childrenTruncated: true, extra: { _id: 'raw' }
    }, options), {
      title: 'Title', id: 'P-1', children: [{ id: 'P-2' }],
      childrenCount: 2, childrenTruncated: true
    });
  });

  it('creates deterministic markup-safe previews and explicit collection bounds', () => {
    const markdown = `${'word '.repeat(30)}[unfinished link text that continues](https://example.test)`;
    const first = markdownPreview(markdown, 100);
    const second = markdownPreview(markdown, 100);
    assert.deepEqual(first, second);
    assert.equal(first.truncated, true);
    assert.ok(first.text.endsWith('…'));
    assert.equal((first.text.match(/`/g)?.length ?? 0) % 2, 0);

    assert.deepEqual(boundedCollection([1, 2, 3], 2), {
      items: [1, 2], count: 3, truncated: true
    });
  });
});
