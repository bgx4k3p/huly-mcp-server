/**
 * Support-module edge cases: the SDK shims and strict-failure helpers whose
 * whole purpose is to behave correctly when something is missing or malformed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeDueDate, normalizeReportDate, resolveColor, strictGet,
  toMarkup, fromMarkup, listEnvelope
} from '../src/helpers.mjs';
import {
  createResponseSerializer, projectCompact, serializeToolResult, normalizeToolError
} from '../src/responseMode.mjs';

describe('indexedDB shim', () => {
  // The Huly SDK's client-resources caches its model in IndexedDB and awaits
  // the request callbacks. If any of them stops firing, the WebSocket
  // transport hangs at startup instead of failing, so the shim is load-bearing.
  it('fires onupgradeneeded then onsuccess so the model load resolves', async () => {
    const request = globalThis.indexedDB.open('model-cache');
    const order = [];
    await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => order.push('upgrade');
      request.onsuccess = event => { order.push('success'); resolve(event); };
      request.onerror = reject;
      setTimeout(() => reject(new Error('indexedDB.open never fired its callbacks')), 1000);
    });
    assert.deepEqual(order, ['upgrade', 'success']);
    assert.ok(request.result, 'a fake database must be handed to the SDK');
  });

  it('resolves reads and writes rather than leaving the SDK waiting', async () => {
    const request = globalThis.indexedDB.open('model-cache');
    const db = request.result;
    assert.equal(db.objectStoreNames.contains('anything'), true);
    assert.ok(db.createObjectStore('anything'));

    const store = db.transaction().objectStore();
    const read = await new Promise((resolve, reject) => {
      const r = store.get('missing-key');
      r.onsuccess = event => resolve(event.target.result);
      setTimeout(() => reject(new Error('get never fired onsuccess')), 1000);
    });
    assert.equal(read, undefined, 'a cache miss must resolve, not hang');

    await new Promise((resolve, reject) => {
      const w = store.put({ any: 'value' });
      w.onsuccess = () => resolve();
      setTimeout(() => reject(new Error('put never fired onsuccess')), 1000);
    });
  });
});

describe('strict lookup and coercion helpers', () => {
  it('strictGet surfaces a missing key instead of substituting a fallback', () => {
    const map = new Map([['known', 'value']]);
    assert.equal(strictGet(map, 'known', 'Status'), 'value');
    assert.throws(() => strictGet(map, 'absent', 'Status'), /Status lookup failed for: absent/);
    // Arrays take the same path, and a present-but-falsy value must survive.
    assert.equal(strictGet(['zero'], 0, 'Item'), 'zero');
    assert.throws(() => strictGet([], 3, 'Item'), /Item lookup failed for: 3/);
  });

  it('resolveColor falls back only for values it cannot interpret', () => {
    assert.equal(resolveColor('blue'), 9);
    assert.equal(resolveColor('BLUE'), 9);
    assert.equal(resolveColor(0xBB83FC), 0xBB83FC);
    assert.equal(resolveColor(0), 0, 'palette index 0 is a real colour, not absent');
    // Unknown name, wrong type, and nullish all reach the fallback.
    assert.equal(resolveColor('chartreuse'), 9);
    assert.equal(resolveColor(['blue']), 9);
    assert.equal(resolveColor(null), 9);
    assert.equal(resolveColor(undefined, 3), 3);
  });

  it('rejects dates the SDK would store as NaN and passes through valid ones', () => {
    assert.equal(normalizeDueDate(''), null);
    assert.equal(normalizeDueDate('   '), null);
    assert.equal(normalizeDueDate(null), null);
    assert.equal(normalizeDueDate(undefined), null);
    assert.equal(normalizeDueDate('2026-04-01'), new Date('2026-04-01').getTime());
    assert.throws(() => normalizeDueDate('tomorrow'), /Invalid date: tomorrow/);
    assert.throws(() => normalizeDueDate('2026-13-45'), /Invalid date/);
    assert.throws(() => normalizeDueDate({}), /Invalid date/);

    // The report-date sibling defaults to now rather than null.
    assert.ok(Number.isFinite(normalizeReportDate(undefined)));
    assert.throws(() => normalizeReportDate('not-a-date'), /Invalid date: not-a-date/);
  });
});

describe('markup conversion fallbacks', () => {
  it('returns the original text when markup cannot be parsed', () => {
    // Corrupt markup must degrade to something displayable rather than throw
    // out of a read path and fail the whole page.
    assert.equal(fromMarkup('plain sentence'), 'plain sentence');
    assert.equal(fromMarkup(''), '');
    assert.equal(fromMarkup(null), '');
    assert.equal(fromMarkup(undefined), '');
  });

  it('throws only for text that claims to be JSON markup and is not', () => {
    assert.throws(() => fromMarkup('{"type":"doc"'), /Corrupted markup \(invalid JSON\)/);
    assert.throws(() => fromMarkup('[{"broken"'), /Corrupted markup \(invalid JSON\)/);
  });

  it('coerces a non-string, non-markup value rather than returning an object', () => {
    assert.equal(fromMarkup(42), '42');
    assert.equal(fromMarkup(true), 'true');
  });

  it('round-trips each supported description format', () => {
    assert.equal(fromMarkup(toMarkup('# Heading', 'markdown')).trim(), '# Heading');
    assert.match(fromMarkup(toMarkup('<h1>Heading</h1>', 'html')), /Heading/);
    assert.match(fromMarkup(toMarkup('# not a heading', 'plain')), /# not a heading/);
  });
});

describe('response serializer policy', () => {
  it('exposes a serialize bound to the resolved mode', () => {
    const serializer = createResponseSerializer({ responseMode: 'raw' });
    const source = { id: 'FIX-1', extra: { _id: 'internal' } };
    // serialize is reachable off the frozen policy object, not only as an import.
    assert.deepEqual(JSON.parse(serializer.serialize(source, serializer.resolve({}))), source);
    assert.deepEqual(
      JSON.parse(serializer.serialize(source, serializer.resolve({ 'com.huly/responseMode': 'compact' }))),
      { id: 'FIX-1' }
    );
  });

  it('keeps producer-stated envelope metadata intact through compact projection', () => {
    const envelope = listEnvelope([{ id: 'A', extra: { _id: 'x' } }], 'opaque');
    const compact = JSON.parse(serializeToolResult(envelope, 'compact'));
    assert.deepEqual(compact, {
      items: [{ id: 'A' }], count: 1, hasMore: true, truncated: true, nextCursor: 'opaque'
    });
  });

  it('leaves a non-envelope object without invented pagination fields', () => {
    // A payload that merely contains an `items` array is not a page.
    assert.deepEqual(projectCompact({ name: 'checklist', items: ['a', 'b'] }),
      { name: 'checklist', items: ['a', 'b'] });
  });

  it('normalizes a non-Error rejection into a bounded error payload', () => {
    assert.deepEqual(normalizeToolError('a bare string'), { error: 'Tool call failed' });
    assert.deepEqual(normalizeToolError({ message: '   ' }), { error: 'Tool call failed' });
    assert.deepEqual(normalizeToolError(undefined), { error: 'Tool call failed' });
  });
});

describe('date rendering never throws out of a read path', () => {
  it('returns null for a stored value that cannot be represented', async () => {
    const { toIsoDate } = await import('../src/helpers.mjs');
    // A legacy NaN or string date used to reach new Date(...).toISOString()
    // and throw RangeError, failing an entire list_time_reports page.
    assert.equal(toIsoDate(NaN), null);
    assert.equal(toIsoDate('not-a-date'), null);
    assert.equal(toIsoDate({}), null);
    assert.equal(toIsoDate(null), null);
    assert.equal(toIsoDate(undefined), null);
    assert.equal(toIsoDate(''), null);
    assert.equal(toIsoDate(Date.UTC(2026, 3, 1)), '2026-04-01T00:00:00.000Z');
    assert.equal(toIsoDate('2026-04-01'), '2026-04-01T00:00:00.000Z');
  });

  it('keeps the pool TTL usable when the override is not a number', async () => {
    const original = process.env.HULY_POOL_TTL_MS;
    try {
      process.env.HULY_POOL_TTL_MS = 'thirty-minutes';
      const config = await import(`../src/config.mjs?ttl=${Date.now()}`);
      // NaN would make every `now - lastUsed > TTL` comparison false and
      // disable eviction entirely for the process lifetime.
      assert.ok(Number.isFinite(config.POOL_TTL_MS));
      assert.ok(config.POOL_TTL_MS > 0);
    } finally {
      if (original === undefined) delete process.env.HULY_POOL_TTL_MS;
      else process.env.HULY_POOL_TTL_MS = original;
    }
  });
});
