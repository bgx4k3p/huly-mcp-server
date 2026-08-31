import { createRequire } from 'node:module';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { HulyClient } from '../src/client.mjs';
import {
  compareCursorTuple,
  cursorScopeHash,
  cursorTuple,
  decodeCursor,
  encodeCursor,
  isTupleAfter,
  listEnvelope,
  normalizePageLimit,
  CURSOR_TTL_MS,
  MAX_PAGE_SIZE,
  PAGE_SIZE
} from '../src/helpers.mjs';

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;

const SECRET = 'pagination-internals-secret';
const NOW = 1_700_000_000_000;

function sign(payload, secret = SECRET) {
  return createHmac('sha256', secret).update(payload).digest().subarray(0, 16).toString('base64url');
}

/** Mint a cursor whose payload we choose, correctly signed. Proves the decoder
 *  validates the envelope itself and not merely the MAC. */
function forge(body, secret = SECRET) {
  const payload = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function newClient(workspace = 'ws-primary') {
  return new HulyClient({ url: 'https://huly.example.test', token: 'unit-token', workspace });
}

const client = newClient();

function docs(count, { tie = 1, prefix = 'a' } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    _id: `${prefix}${String(index).padStart(6, '0')}`,
    createdOn: 900_000 - Math.floor(index / tie),
    seq: index
  }));
}

function descending(items) {
  return [...items].sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));
}

function recordPage(page, ids, pages) {
  assert.equal(page.count, page.items.length, 'count must equal the payload length');
  assert.equal(page.hasMore, page.truncated, 'hasMore and truncated must agree');
  assert.equal(page.hasMore, Object.hasOwn(page, 'nextCursor'), 'hasMore must match cursor presence');
  pages.push({
    count: page.count,
    hasMore: page.hasMore,
    truncated: page.truncated,
    hasCursorKey: Object.hasOwn(page, 'nextCursor')
  });
  ids.push(...page.items.map(item => item._id ?? item.id));
  return page.nextCursor;
}

/** Walk every page and return ids plus the per-page envelope metadata. */
async function traverse(nextPage) {
  const ids = [];
  const pages = [];
  let cursor;
  do {
    cursor = recordPage(await nextPage(cursor), ids, pages);
  } while (cursor);
  return { ids, pages };
}

/** Synchronous sibling of traverse() for the in-memory cursor path. */
function traverseSync(nextPage) {
  const ids = [];
  const pages = [];
  let cursor;
  do {
    cursor = recordPage(nextPage(cursor), ids, pages);
  } while (cursor);
  return { ids, pages };
}

function assertCompleteTraversal(ids, source) {
  const expected = descending(source).map(item => item._id ?? item.id);
  assert.equal(ids.length, expected.length, 'traversal dropped or duplicated records');
  assert.equal(new Set(ids).size, ids.length, 'traversal produced duplicates');
  assert.deepEqual(ids, expected, 'traversal order diverged from the sort contract');
}

/** Minimal SDK stand-in honouring the three query shapes _paginatedFindAll emits. */
function findAllSdk(source, { onCall } = {}) {
  return {
    async findAll(_class, query, options = {}) {
      onCall?.(query, options);
      let items = source;
      if (query._id?.$in) {
        const allowed = new Set(query._id.$in);
        items = items.filter(item => allowed.has(item._id));
      }
      if (typeof query.createdOn === 'number') {
        items = items.filter(item => item.createdOn === query.createdOn);
      } else if (query.createdOn?.$lt !== undefined) {
        items = items.filter(item => item.createdOn < query.createdOn.$lt);
      }
      return descending(items).slice(0, options.limit ?? items.length);
    }
  };
}

describe('cursor integrity', () => {
  it('binds a cursor to the scope value, not to the scope object layout', () => {
    const scope = { workspace: 'w', tool: 'list_issues', filters: { status: 'todo', label: 'bug' } };
    const reordered = { filters: { label: 'bug', status: 'todo' }, tool: 'list_issues', workspace: 'w' };
    assert.equal(cursorScopeHash(scope), cursorScopeHash(reordered));
    // Array order is meaningful — a differently ordered id list is a different query.
    assert.notEqual(cursorScopeHash({ ids: ['a', 'b'] }), cursorScopeHash({ ids: ['b', 'a'] }));

    const cursor = encodeCursor({ id: 'x1', createdOn: 500 }, { scope, secret: SECRET, now: NOW });
    assert.equal(decodeCursor(cursor, { scope: reordered, secret: SECRET, now: NOW }).after.id, 'x1');
    assert.throws(
      () => decodeCursor(cursor, {
        scope: { ...scope, workspace: 'other-workspace' }, secret: SECRET, now: NOW
      }),
      /does not match this query/
    );
  });

  it('rejects a cursor minted under a different secret', () => {
    const scope = { tool: 'list_issues' };
    const foreign = encodeCursor({ id: 'x1', createdOn: 500 }, {
      scope, secret: 'a-different-deployment-secret', now: NOW
    });
    assert.throws(
      () => decodeCursor(foreign, { scope, secret: SECRET, now: NOW }),
      /signature is invalid/
    );
  });

  it('rejects correctly signed payloads that violate the envelope contract', () => {
    const scope = { tool: 'list_issues' };
    const q = cursorScopeHash(scope);
    const issuedAt = Math.floor(NOW / 1000);
    const base = { v: 1, q, w: [600, 'w1'], a: [500, 'x1'], i: issuedAt };
    const decode = body => decodeCursor(forge(body), { scope, secret: SECRET, now: NOW });

    assert.equal(decode(base).after.id, 'x1');
    // Every one of these is MAC-valid; only the structural checks can stop them.
    assert.throws(() => decode({ ...base, v: 2 }), /payload is invalid/);
    assert.throws(() => decode({ ...base, a: [500, 'x1', 'extra'] }), /payload is invalid/);
    assert.throws(() => decode({ ...base, a: [500, 42] }), /payload is invalid/);
    assert.throws(() => decode({ ...base, a: ['500', 'x1'] }), /payload is invalid/);
    assert.throws(() => decode({ ...base, w: 'not-an-array' }), /payload is invalid/);
    assert.throws(() => decode({ ...base, i: issuedAt + 0.5 }), /payload is invalid/);
    assert.throws(() => decode({ ...base, q: cursorScopeHash({ tool: 'list_labels' }) }), /does not match this query/);
  });

  it('rejects a non-canonical base64url payload even when it is correctly signed', () => {
    const scope = { tool: 'list_issues' };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let payload;
    let smuggled;
    // Spare bits only exist when the payload length is not a multiple of 3 bytes.
    for (let pad = 0; pad < 3 && !smuggled; pad += 1) {
      payload = encodeCursor({ id: `x${'y'.repeat(pad)}`, createdOn: 500 }, {
        scope, secret: SECRET, now: NOW
      }).split('.')[0];
      const bytes = Buffer.from(payload, 'base64url');
      smuggled = [...alphabet]
        .map(char => `${payload.slice(0, -1)}${char}`)
        .find(candidate => candidate !== payload && Buffer.from(candidate, 'base64url').equals(bytes));
    }
    assert.ok(smuggled, 'fixture must produce an alternate encoding of the same bytes');
    assert.notEqual(smuggled, payload);
    assert.throws(
      () => decodeCursor(`${smuggled}.${sign(smuggled)}`, { scope, secret: SECRET, now: NOW }),
      /signature is invalid/
    );
  });

  it('enforces the issue-time window at both edges', () => {
    const scope = { tool: 'list_issues' };
    const cursor = encodeCursor({ id: 'x1', createdOn: 500 }, { scope, secret: SECRET, now: NOW });
    const at = now => decodeCursor(cursor, { scope, secret: SECRET, now });

    assert.equal(at(NOW + CURSOR_TTL_MS).after.id, 'x1');
    assert.throws(() => at(NOW + CURSOR_TTL_MS + 1), /stale/);
    // A short backwards clock step is tolerated; a far-future issue time is not.
    assert.equal(at(NOW - 300_000).after.id, 'x1');
    assert.throws(() => at(NOW - 300_001), /stale/);

    const shortTtl = { scope, secret: SECRET, ttlMs: 60_000 };
    assert.equal(decodeCursor(cursor, { ...shortTtl, now: NOW + 60_000 }).after.id, 'x1');
    assert.throws(() => decodeCursor(cursor, { ...shortTtl, now: NOW + 60_001 }), /stale/);
  });

  it('rejects malformed, oversized, and non-string cursors', () => {
    const scope = { tool: 'list_issues' };
    const opts = { scope, secret: SECRET, now: NOW };
    const valid = encodeCursor({ id: 'x1', createdOn: 500 }, opts);

    assert.throws(() => decodeCursor(`${valid}.extra`, opts), /Unsupported pagination cursor format/);
    assert.throws(() => decodeCursor('', opts), /Unsupported pagination cursor format/);
    assert.throws(() => decodeCursor(`${'a'.repeat(1200)}.${'b'.repeat(22)}`, opts), /Invalid pagination cursor/);
    assert.throws(() => decodeCursor({ toString: () => valid }, opts), /Invalid pagination cursor/);
    const [payload, signature] = valid.split('.');
    // '=' padding is outside the accepted alphabet and must not be normalised away.
    assert.throws(() => decodeCursor(`${payload}=.${signature}`, opts), /signature is invalid/);
    assert.throws(() => decodeCursor(`${payload}.${signature.slice(0, -2)}`, opts), /signature is invalid/);
  });

  it('keeps the watermark and the after tuple distinct across a round trip', () => {
    const scope = { tool: 'list_issues' };
    const decoded = decodeCursor(
      encodeCursor({ id: 'after-id', createdOn: 100 }, {
        scope, secret: SECRET, now: NOW, watermark: { id: 'watermark-id', createdOn: 900 }
      }),
      { scope, secret: SECRET, now: NOW }
    );
    assert.deepEqual(decoded.watermark, { createdOn: 900, id: 'watermark-id' });
    assert.deepEqual(decoded.after, { createdOn: 100, id: 'after-id' });
    assert.equal(decoded.version, 1);
  });
});

describe('cursor tuple ordering', () => {
  it('resolves the cursor tuple by field precedence and refuses unpaginatable rows', () => {
    assert.deepEqual(cursorTuple({ _id: 'a', id: 'b', createdOn: 5, modifiedOn: 9 }), { createdOn: 5, id: 'a' });
    assert.deepEqual(cursorTuple({ id: 'b', modifiedOn: 9 }), { createdOn: 9, id: 'b' });
    assert.deepEqual(cursorTuple({ id: 'b', extra: { createdOn: 7, _id: 'z' } }), { createdOn: 7, id: 'b' });
    // Enriched projections carry no timestamp at all; 0 is a real value, not "missing".
    assert.deepEqual(cursorTuple({ id: 'b' }), { createdOn: 0, id: 'b' });
    assert.deepEqual(cursorTuple({ id: 'b', createdOn: 0, modifiedOn: 9 }), { createdOn: 0, id: 'b' });

    assert.throws(() => cursorTuple({ createdOn: 5 }), /missing stable cursor fields/);
    assert.throws(() => cursorTuple({ id: '', createdOn: 5 }), /missing stable cursor fields/);
    assert.throws(() => cursorTuple({ id: 'b', createdOn: 'yesterday' }), /missing stable cursor fields/);
    assert.throws(() => cursorTuple(undefined), /missing stable cursor fields/);
  });

  it('keeps the page comparator and the cursor boundary mutually consistent', () => {
    const source = docs(60, { tie: 4 });
    const sorted = descending(source);

    for (let index = 0; index < sorted.length - 1; index += 1) {
      assert.equal(
        isTupleAfter(sorted[index + 1], cursorTuple(sorted[index])),
        true,
        `sorted neighbour ${sorted[index + 1]._id} must fall after ${sorted[index]._id}`
      );
      assert.equal(
        isTupleAfter(sorted[index], cursorTuple(sorted[index + 1])),
        false,
        'the boundary must be strictly ordered'
      );
    }
    // A record equal to the boundary is already delivered — it must not repeat.
    assert.equal(isTupleAfter(sorted[10], cursorTuple(sorted[10])), false);
    // The comparator must be antisymmetric on ties so page slicing is stable.
    const tied = sorted.filter(item => item.createdOn === sorted[10].createdOn);
    assert.ok(tied.length > 1, 'fixture must contain a timestamp tie');
    assert.deepEqual(descending(tied), descending([...tied].reverse()));
  });
});

describe('page limit normalisation', () => {
  it('accepts only integers inside the inclusive bound', () => {
    assert.equal(normalizePageLimit(null, 25, 100), 25);
    assert.equal(normalizePageLimit(undefined, 25, 100), 25);
    assert.equal(normalizePageLimit(1, 25, 100), 1);
    assert.equal(normalizePageLimit(100, 25, 100), 100);
    assert.equal(normalizePageLimit(MAX_PAGE_SIZE), MAX_PAGE_SIZE);
    // The bound is caller-supplied and must appear verbatim in the rejection.
    assert.throws(() => normalizePageLimit(26, 25, 25), /integer from 1 to 25/);
    for (const invalid of [Infinity, -Infinity, true, -0.5, 2 ** 53, [], {}, 5n]) {
      assert.throws(() => normalizePageLimit(invalid, 25, 100), /integer from 1 to 100/);
    }
  });
});

describe('list envelope metadata', () => {
  it('never contradicts the payload it wraps', () => {
    const empty = listEnvelope([]);
    assert.deepEqual(empty, { items: [], count: 0, hasMore: false, truncated: false });
    assert.equal(Object.hasOwn(empty, 'nextCursor'), false);

    const full = listEnvelope([{ id: 'a' }, { id: 'b' }], 'cursor-token');
    assert.deepEqual(full, {
      items: [{ id: 'a' }, { id: 'b' }],
      count: 2,
      hasMore: true,
      truncated: true,
      nextCursor: 'cursor-token'
    });
    // hasMore is the producer's statement about a next page, never inferred
    // from the payload size — a full page with no cursor is terminal.
    const terminal = listEnvelope(docs(MAX_PAGE_SIZE));
    assert.equal(terminal.count, MAX_PAGE_SIZE);
    assert.equal(terminal.hasMore, false);
    assert.equal(terminal.truncated, false);
  });
});

describe('_cursoredFindAll page boundaries', () => {
  it('emits no cursor when the total is an exact multiple of the limit', () => {
    const source = docs(40, { tie: 3 });
    const scope = { tool: 'exact-multiple' };
    const { ids, pages } = traverseSync(cursor =>
      client._cursoredFindAll(source, { limit: 10, cursor, cursorScope: scope }));

    assertCompleteTraversal(ids, source);
    assert.equal(pages.length, 4, 'an exact multiple must not produce a trailing empty page');
    assert.deepEqual(pages.map(page => page.count), [10, 10, 10, 10]);
    assert.deepEqual(pages.map(page => page.hasMore), [true, true, true, false]);
  });

  it('emits exactly one extra page when a single record remains', () => {
    const source = docs(11, { tie: 5 });
    const scope = { tool: 'off-by-one' };
    const { ids, pages } = traverseSync(cursor =>
      client._cursoredFindAll(source, { limit: 10, cursor, cursorScope: scope }));

    assertCompleteTraversal(ids, source);
    assert.deepEqual(pages.map(page => page.count), [10, 1]);
    assert.deepEqual(pages.map(page => page.hasMore), [true, false]);
    assert.deepEqual(pages.map(page => page.hasCursorKey), [true, false]);

    // A limit at or above the total is terminal on the first page.
    const single = client._cursoredFindAll(source, { limit: 11, cursorScope: scope });
    assert.equal(single.count, 11);
    assert.equal(single.hasMore, false);
    assert.equal(Object.hasOwn(single, 'nextCursor'), false);
  });

  it('refuses a cursor issued for another workspace', () => {
    const source = docs(30);
    const primary = newClient('ws-primary');
    const other = newClient('ws-other');
    const first = primary._cursoredFindAll(source, { limit: 10 });
    assert.ok(first.nextCursor);

    assert.equal(primary._cursoredFindAll(source, { limit: 10, cursor: first.nextCursor }).count, 10);
    assert.throws(
      () => other._cursoredFindAll(source, { limit: 10, cursor: first.nextCursor }),
      /does not match this query/
    );
  });
});

describe('_paginatedFindAll SDK traversal', () => {
  it('reports a terminal page when the collection exactly fills the limit', async () => {
    const source = docs(50, { tie: 7 });
    const queries = [];
    const sdk = findAllSdk(source, { onCall: query => queries.push(query) });

    const page = await client._paginatedFindAll(sdk, 'fixture:class', {}, {
      limit: 50, cursorScope: { tool: 'exact-fill' }
    });

    assert.equal(page.count, 50);
    assert.equal(page.hasMore, false);
    assert.equal(Object.hasOwn(page, 'nextCursor'), false);
    // One SDK round trip is enough; the extra probe row comes from the same page.
    assert.equal(queries.length, 1);
  });

  it('spans several SDK batches inside one page and traverses the set exactly once', async () => {
    const source = docs(1300, { tie: 7 });
    const sdk = findAllSdk(source);
    const scope = { tool: 'multi-batch' };

    const { ids, pages } = await traverse(cursor => client._paginatedFindAll(sdk, 'fixture:class', {}, {
      limit: 600, maxLimit: 1000, cursor, cursorScope: scope
    }));

    assertCompleteTraversal(ids, source);
    assert.deepEqual(pages.map(page => page.count), [600, 600, 100]);
    assert.deepEqual(pages.map(page => page.hasMore), [true, true, false]);
    // The fixture only exercises the internal batch loop if a page exceeds the
    // SDK page window, so guard that the constant has not drifted underneath it.
    assert.ok(600 > PAGE_SIZE, `page limit must exceed the SDK page size of ${PAGE_SIZE}`);
  });

  it('fails loudly when a timestamp group outgrows the SDK page window', async () => {
    // Every row shares one createdOn and the server can only ever return its
    // first PAGE_SIZE rows, so the cursor eventually cannot advance.
    const source = Array.from({ length: 600 }, (_, index) => ({
      _id: `t${String(index).padStart(4, '0')}`,
      createdOn: 5000
    }));
    const sdk = findAllSdk(source);
    const scope = { tool: 'timestamp-overflow' };

    let cursor;
    let delivered = 0;
    let pages = 0;
    let failure = null;
    for (;;) {
      let page;
      try {
        page = await client._paginatedFindAll(sdk, 'fixture:class', {}, { limit: 50, cursor, cursorScope: scope });
      } catch (error) {
        failure = error;
        break;
      }
      pages += 1;
      delivered += page.count;
      cursor = page.nextCursor;
      if (!cursor) break;
    }

    assert.ok(failure, 'an unresolvable timestamp group must surface, not silently truncate');
    assert.match(failure.message, /Pagination timestamp contains more than 500 records; refine the query/);
    assert.equal(pages, 9);
    assert.equal(delivered, 450);
  });

  it('binds the default cursor scope to the query it was issued for', async () => {
    const source = docs(30);
    const sdk = findAllSdk(source);
    const first = await client._paginatedFindAll(sdk, tracker.class.Issue, { space: 'space-a' }, { limit: 10 });
    assert.ok(first.nextCursor);

    await assert.doesNotReject(() => client._paginatedFindAll(
      sdk, tracker.class.Issue, { space: 'space-a' }, { limit: 10, cursor: first.nextCursor }
    ));
    await assert.rejects(
      () => client._paginatedFindAll(sdk, tracker.class.Issue, { space: 'space-b' }, {
        limit: 10, cursor: first.nextCursor
      }),
      /does not match this query/
    );
    await assert.rejects(
      () => client._paginatedFindAll(sdk, tracker.class.Component, { space: 'space-a' }, {
        limit: 10, cursor: first.nextCursor
      }),
      /does not match this query/
    );
  });
});

describe('_paginatedIssuesByIds label merge path', () => {
  it('merges batched id queries into one globally ordered traversal', async () => {
    const source = docs(250, { tie: 6, prefix: 'i' });
    // Interleave the id list so a batch never lines up with a contiguous time range.
    const issueIds = source
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (a.index % 7) - (b.index % 7) || a.index - b.index)
      .map(entry => entry.item._id);
    assert.ok(issueIds.length > 200, 'fixture must span at least three id batches');
    const sdk = findAllSdk(source);

    const { ids, pages } = await traverse(cursor =>
      client._paginatedIssuesByIds(sdk, { space: 'space-a' }, issueIds, { limit: 40, cursor }));

    assertCompleteTraversal(ids, source);
    assert.deepEqual(pages.map(page => page.count), [40, 40, 40, 40, 40, 40, 10]);
    assert.deepEqual(pages.map(page => page.hasMore), [true, true, true, true, true, true, false]);
    assert.equal(pages.at(-1).hasCursorKey, false);
  });

  it('binds the merged cursor to the id set membership but not to its order', async () => {
    const source = docs(150, { tie: 3, prefix: 'i' });
    const issueIds = source.map(item => item._id);
    const sdk = findAllSdk(source);
    const query = { space: 'space-a' };

    const first = await client._paginatedIssuesByIds(sdk, query, issueIds, { limit: 20 });
    assert.ok(first.nextCursor);

    const reordered = [...issueIds].reverse();
    const resumed = await client._paginatedIssuesByIds(sdk, query, reordered, {
      limit: 20, cursor: first.nextCursor
    });
    assert.equal(resumed.count, 20);
    assert.equal(resumed.items[0]._id, descending(source)[20]._id);

    await assert.rejects(
      () => client._paginatedIssuesByIds(sdk, query, issueIds.slice(0, 149), {
        limit: 20, cursor: first.nextCursor
      }),
      /does not match this query/
    );
  });
});

describe('label lookup cache', () => {
  function labelHarness(initial) {
    const state = { elements: [...initial] };
    const counts = { lookups: 0 };
    const sdk = {
      async findOne(_class, query) {
        if (_class !== tags.class.TagElement) return null;
        if (query._id) return state.elements.find(element => element._id === query._id) ?? null;
        return state.elements.find(element => element.title === query.title) ?? null;
      },
      async findAll(_class) {
        if (_class === tags.class.TagElement) {
          counts.lookups += 1;
          return state.elements;
        }
        if (_class === tracker.class.Project) return [{ _id: 'project-real' }];
        return [];
      },
      async createDoc(_class, space, attrs, id) {
        state.elements.push({ _id: id, space, ...attrs });
      },
      async updateDoc(_class, _space, id, ops) {
        Object.assign(state.elements.find(element => element._id === id), ops);
      },
      async removeDoc(_class, _space, id) {
        state.elements = state.elements.filter(element => element._id !== id);
      }
    };
    const instance = newClient();
    instance._getClient = async () => sdk;
    return { client: instance, sdk, state, counts };
  }

  it('serves within the TTL and refetches once an entry expires', async () => {
    const { client: instance, sdk, state, counts } = labelHarness([{ _id: 'tag-1', title: 'Bug', space: 's' }]);

    assert.equal((await instance._findLabelByName(sdk, 'bug'))._id, 'tag-1');
    assert.equal(counts.lookups, 1);
    await instance._findLabelByName(sdk, 'Bug');
    assert.equal(counts.lookups, 1, 'a live entry must not trigger a second query');

    // Server-side rename that no local mutation invalidated: once the entry
    // expires the cache must yield to the server, never serve the stale value.
    state.elements = [{ _id: 'tag-2', title: 'Bug', space: 's' }];
    const stale = instance._labelLookupCache.get('bug');
    instance._labelLookupCache.set('bug', { value: stale.value, expiresAt: Date.now() - 1 });

    assert.equal((await instance._findLabelByName(sdk, 'bug'))._id, 'tag-2');
    assert.equal(counts.lookups, 2);
  });

  it('invalidates the cache on every label mutation', async () => {
    const { client: instance, sdk, counts } = labelHarness([{ _id: 'tag-1', title: 'Bug', space: 'space-real' }]);

    await instance._findLabelByName(sdk, 'bug');
    assert.equal(counts.lookups, 1);

    await instance.createLabel('Urgent');
    assert.equal(instance._labelLookupCache.size, 0, 'createLabel must drop the cache');
    assert.ok(await instance._findLabelByName(sdk, 'urgent'), 'a new label must be visible immediately');
    assert.equal(counts.lookups, 2);

    await instance.updateLabel('Bug', { newName: 'Defect' });
    assert.equal(instance._labelLookupCache.size, 0, 'updateLabel must drop the cache');
    assert.equal(await instance._findLabelByName(sdk, 'bug'), null, 'the old name must stop resolving');
    assert.equal((await instance._findLabelByName(sdk, 'defect'))._id, 'tag-1');

    await instance.deleteLabel('Defect');
    assert.equal(instance._labelLookupCache.size, 0, 'deleteLabel must drop the cache');
    assert.equal(await instance._findLabelByName(sdk, 'defect'), null);
  });
});

describe('connection resilience', () => {
  async function quietly(run) {
    const original = console.error;
    console.error = () => {};
    try {
      return await run();
    } finally {
      console.error = original;
    }
  }

  it('does not re-run an operation that failed for a non-connection reason', async () => {
    const instance = newClient();
    let applied = 0;

    await assert.rejects(
      () => quietly(() => instance.withReconnect(async () => {
        applied += 1;
        throw new Error('Issue not found: PROJ-42');
      })),
      /Issue not found: PROJ-42/
    );
    // A retried mutation would be applied twice; business failures must not retry.
    assert.equal(applied, 1);
  });

  it('bounds reconnect attempts and surfaces the final failure', async () => {
    const instance = newClient();
    let attempts = 0;

    await assert.rejects(
      () => quietly(() => instance.withReconnect(async () => {
        attempts += 1;
        const error = new Error('reset by peer');
        error.code = 'ECONNRESET';
        throw error;
      })),
      /reset by peer/
    );
    assert.equal(attempts, 3, 'one attempt plus two retries, then the error must escape');
  });

  it('drops the cached client before retrying and returns the retried result', async () => {
    const instance = newClient();
    instance._client = { marker: 'stale-socket' };
    const observed = [];
    let attempts = 0;

    const result = await quietly(() => instance.withReconnect(async () => {
      attempts += 1;
      observed.push(instance._client);
      if (attempts === 1) throw new Error('ConnectionClosed');
      return 'reconnected';
    }));

    assert.equal(result, 'reconnected');
    assert.equal(attempts, 2, 'a recovered operation must run exactly once more');
    assert.deepEqual(observed, [{ marker: 'stale-socket' }, null]);
  });

  it('disconnect clears every cached connection field and swallows a failing close', async () => {
    const instance = newClient();
    const closes = [];
    instance._platformClient = {
      close: async () => {
        closes.push('close');
        throw new Error('socket already closed');
      }
    };
    instance._client = { marker: 'live' };
    instance._connectionPromise = Promise.resolve();
    instance._collabClient = { marker: 'collab' };
    instance._workspaceId = 'workspace-uuid';
    instance._serverConfig = { COLLABORATOR_URL: 'https://collab.example.test' };
    instance._wsToken = 'ws-token';

    instance.disconnect();

    assert.deepEqual(closes, ['close']);
    for (const field of ['_platformClient', '_client', '_connectionPromise', '_collabClient',
      '_workspaceId', '_serverConfig', '_wsToken']) {
      assert.equal(instance[field], null, `${field} must be cleared`);
    }
    // A rejecting close must not escape as an unhandled rejection.
    await new Promise(resolve => setImmediate(resolve));
  });
});
