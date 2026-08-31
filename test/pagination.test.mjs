import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.HULY_URL = 'https://huly.example.test';
process.env.HULY_TOKEN = 'cursor-test-secret';

const { HulyClient } = await import('../src/client.mjs');
const { decodeCursor, encodeCursor, normalizePageLimit } = await import('../src/helpers.mjs');

const client = new HulyClient({
  url: 'https://huly.example.test',
  token: 'cursor-test-secret',
  workspace: 'cursor-workspace'
});

function fixtures(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `id-${String(index).padStart(4, '0')}`,
    createdOn: 1000 - Math.floor(index / 9),
    value: index
  }));
}

function traverseInMemory(source, limit, scope) {
  const seen = [];
  let cursor;
  do {
    const page = client._cursoredFindAll(source, { limit, cursor, cursorScope: scope });
    seen.push(...page.items.map(item => item.id));
    cursor = page.nextCursor;
  } while (cursor);
  return seen;
}

describe('stable cursor pagination', () => {
  it('traverses equal timestamps completely without gaps or duplicates', () => {
    const source = fixtures(257);
    const expected = traverseInMemory(source, 100, { tool: 'fixture' });
    assert.equal(expected.length, source.length);
    assert.equal(new Set(expected).size, source.length);

    for (const limit of [1, 7, 32, 100]) {
      assert.deepEqual(traverseInMemory(source, limit, { tool: 'fixture' }), expected);
    }
  });

  it('keeps a watermark boundary when a newer record is inserted', () => {
    const source = fixtures(25);
    const scope = { tool: 'snapshot' };
    const first = client._cursoredFindAll(source, { limit: 5, cursorScope: scope });
    const inserted = { id: 'newer-id', createdOn: 999999, value: -1 };
    const rest = [];
    let cursor = first.nextCursor;
    do {
      const page = client._cursoredFindAll([inserted, ...source], { limit: 5, cursor, cursorScope: scope });
      rest.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    const traversed = [...first.items.map(item => item.id), ...rest];
    assert.equal(traversed.includes(inserted.id), false);
    assert.deepEqual(traversed, traverseInMemory(source, 5, scope));
  });

  it('rejects query mismatch, tampering, malformed, stale, and unsupported cursors', () => {
    const scope = { tool: 'issues', status: 'todo' };
    const cursor = encodeCursor({ id: 'id-1', createdOn: 100 }, {
      scope,
      watermark: { id: 'id-9', createdOn: 200 },
      secret: 'test-secret',
      now: 1_000_000
    });
    assert.equal(decodeCursor(cursor, { scope, secret: 'test-secret', now: 1_000_000 }).after.id, 'id-1');
    assert.throws(
      () => decodeCursor(cursor, { scope: { tool: 'issues', status: 'done' }, secret: 'test-secret', now: 1_000_000 }),
      /does not match this query/
    );
    assert.throws(
      () => decodeCursor(`${cursor.slice(0, -1)}x`, { scope, secret: 'test-secret', now: 1_000_000 }),
      /signature is invalid/
    );
    const [payload, signature] = cursor.split('.');
    const lastIndex = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      .indexOf(signature.at(-1));
    const nonCanonicalLast = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
      [(lastIndex ^ 1) % 64];
    const nonCanonicalSignature = `${signature.slice(0, -1)}${nonCanonicalLast}`;
    assert.deepEqual(
      Buffer.from(nonCanonicalSignature, 'base64url'),
      Buffer.from(signature, 'base64url'),
      'fixture must exercise equivalent non-canonical padding bits'
    );
    assert.throws(
      () => decodeCursor(`${payload}.${nonCanonicalSignature}`, {
        scope, secret: 'test-secret', now: 1_000_000
      }),
      /signature is invalid/
    );
    assert.throws(
      () => decodeCursor('not-a-cursor', { scope, secret: 'test-secret' }),
      /Unsupported pagination cursor/
    );
    assert.throws(
      () => decodeCursor(cursor, { scope, secret: 'test-secret', now: 1_000_000 + 86_400_001 }),
      /stale/
    );
  });

  it('enforces bounded integer limits', () => {
    assert.equal(normalizePageLimit(undefined, 50, 100), 50);
    for (const invalid of [0, -1, 1.5, 101, '10', NaN]) {
      assert.throws(() => normalizePageLimit(invalid, 50, 100), /integer from 1 to 100/);
    }
  });

  it('applies the same tuple contract to paginated SDK queries', async () => {
    const source = fixtures(225);
    const sdk = {
      async findAll(_class, query, options) {
        let items = [...source];
        if (typeof query.createdOn === 'number') {
          items = items.filter(item => item.createdOn === query.createdOn);
        } else if (query.createdOn?.$lt !== undefined) {
          items = items.filter(item => item.createdOn < query.createdOn.$lt);
        }
        items.sort((a, b) => (b.createdOn - a.createdOn) || b.id.localeCompare(a.id));
        return items.slice(0, options.limit).map(item => ({ ...item, _id: item.id }));
      }
    };
    const scope = { tool: 'sdk-fixture' };
    const ids = [];
    let cursor;
    do {
      const page = await client._paginatedFindAll(sdk, 'fixture:class', {}, {
        limit: 37,
        cursor,
        cursorScope: scope
      });
      ids.push(...page.items.map(item => item.id));
      cursor = page.nextCursor;
    } while (cursor);

    assert.equal(ids.length, source.length);
    assert.equal(new Set(ids).size, source.length);
    assert.deepEqual(ids, traverseInMemory(source, 37, scope));
  });
});
