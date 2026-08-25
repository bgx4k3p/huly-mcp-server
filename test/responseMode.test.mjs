import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  createResponseSerializer,
  normalizeToolError,
  projectCompact,
  serializeToolResult
} from '../src/responseMode.mjs';

const corpus = JSON.parse(readFileSync(
  new URL('./fixtures/response-corpus.json', import.meta.url),
  'utf8'
));

describe('MCP response modes', () => {
  it('rejects the removed legacy response mode', () => {
    assert.throws(
      () => serializeToolResult({ id: 'FIX-1' }, 'legacy'),
      /expected compact or raw/
    );
  });

  it('compact mode is a minified documented projection', () => {
    for (const fixture of corpus) {
      const text = serializeToolResult(fixture.result, 'compact');
      const parsed = JSON.parse(text);
      assert.deepEqual(parsed, projectCompact(fixture.result), fixture.name);
      assert.doesNotMatch(text, /\n/);
      assert.equal(text.includes('"extra"'), false);
    }
  });

  it('raw mode returns full SDK fields without pretty-print whitespace', () => {
    const fixture = corpus.find(item => item.result.extra || item.result.items?.[0]?.extra);
    const text = serializeToolResult(fixture.result, 'raw');
    assert.deepEqual(JSON.parse(text), fixture.result);
    assert.match(text, /"extra"/);
    assert.doesNotMatch(text, /\n/);
  });

  it('preserves documented nulls and empty values in compact mode', () => {
    const value = { nil: null, emptyArray: [], emptyObject: {}, emptyText: '', extra: { _id: 'raw' } };
    assert.deepEqual(JSON.parse(serializeToolResult(value, 'compact')), {
      nil: null,
      emptyArray: [],
      emptyObject: {},
      emptyText: ''
    });
  });

  it('adds explicit continuation metadata and bounds nested collections in compact mode', () => {
    const result = {
      items: [{
        id: 'FIX-1',
        children: Array.from({ length: 105 }, (_, index) => ({ id: `FIX-${index + 2}` }))
      }],
      nextCursor: 'opaque'
    };
    const compact = JSON.parse(serializeToolResult(result, 'compact', { toolName: 'list_issues' }));
    assert.equal(compact.count, 1);
    assert.equal(compact.hasMore, true);
    assert.equal(compact.truncated, true);
    assert.equal(compact.items[0].children.length, 100);
    assert.equal(compact.items[0].childrenCount, 105);
    assert.equal(compact.items[0].childrenTruncated, true);
  });

  it('keeps envelope wire shapes in raw mode for search and assigned-issue calls', () => {
    const result = { items: [{ id: 'FIX-1' }], nextCursor: 'opaque' };
    for (const toolName of ['search_issues', 'get_my_issues']) {
      assert.deepEqual(
        JSON.parse(serializeToolResult(result, 'raw', { toolName })),
        result
      );
    }
  });

  it('bounds top-level array results in compact mode with explicit truncation', () => {
    const result = Array.from({ length: 105 }, (_, index) => ({ id: `FIX-${index}` }));
    const compact = JSON.parse(serializeToolResult(result, 'compact', { toolName: 'list_workspaces' }));
    assert.equal(compact.items.length, 100);
    assert.equal(compact.count, 100);
    assert.equal(compact.totalCount, 105);
    assert.equal(compact.hasMore, false);
    assert.equal(compact.truncated, true);
  });

  it('applies per-call, session, environment, then compact-default precedence', () => {
    const configured = createResponseSerializer({ responseMode: 'raw', environmentMode: 'compact' });
    assert.equal(configured.resolve({}), 'raw');
    assert.equal(configured.resolve({ 'com.huly/responseMode': 'compact' }), 'compact');
    assert.equal(createResponseSerializer({ environmentMode: 'raw' }).defaultMode, 'raw');
    assert.equal(createResponseSerializer({ environmentMode: '' }).defaultMode, 'compact');
  });

  it('isolates concurrent client/session policies', async () => {
    const compactClient = createResponseSerializer({ responseMode: 'compact', environmentMode: 'raw' });
    const rawClient = createResponseSerializer({ responseMode: 'raw', environmentMode: 'compact' });
    const source = { id: 'FIX-1', extra: { _id: 'internal' } };

    const [compact, raw] = await Promise.all([
      Promise.resolve(compactClient.serialize(source, compactClient.resolve({}))),
      Promise.resolve(rawClient.serialize(source, rawClient.resolve({})))
    ]);

    assert.deepEqual(JSON.parse(compact), { id: 'FIX-1' });
    assert.deepEqual(JSON.parse(raw), source);
    assert.doesNotMatch(raw, /\n/);
  });

  it('fails closed on invalid modes', () => {
    assert.throws(() => createResponseSerializer({ responseMode: 'tiny' }), /Invalid session response mode/);
    assert.throws(() => createResponseSerializer({ responseMode: 'legacy' }), /Invalid session response mode/);
  });

  it('rejects legacy mode from every configuration source', () => {
    assert.throws(() => createResponseSerializer({ environmentMode: 'legacy' }), /HULY_RESPONSE_MODE/);
    const serializer = createResponseSerializer();
    assert.throws(
      () => serializer.resolve({ 'com.huly/responseMode': 'legacy' }),
      /com\.huly\/responseMode/
    );
  });

  it('bounds and sanitizes error payloads', () => {
    const normalized = normalizeToolError(new Error(`bad\u0000${'x'.repeat(900)}`));
    assert.equal(normalized.error.length, 500);
    assert.equal(normalized.error.includes('\u0000'), false);
    assert.deepEqual(normalizeToolError({}), { error: 'Tool call failed' });
  });

  it('serializes deterministic randomized values without leaking compact extras', () => {
    let state = 0x52455350;
    const random = () => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 0x100000000;
    };
    const value = depth => {
      if (depth === 0) return random() < 0.5 ? Math.floor(random() * 1000) : `v-${random()}`;
      if (random() < 0.4) return Array.from({ length: Math.floor(random() * 130) }, () => value(depth - 1));
      return {
        id: `id-${random()}`,
        nested: value(depth - 1),
        extra: { _id: `internal-${random()}`, secret: 'not-allowlisted' }
      };
    };

    for (let iteration = 0; iteration < 60; iteration += 1) {
      const source = value(3);
      assert.deepEqual(JSON.parse(serializeToolResult(source, 'raw')), source);
      const compact = serializeToolResult(source, 'compact');
      assert.doesNotMatch(compact, /\"extra\"|not-allowlisted|internal-/);
      assert.deepEqual(JSON.parse(compact), Array.isArray(source)
        ? {
            items: source.slice(0, 100).map(projectCompact),
            count: Math.min(source.length, 100),
            totalCount: source.length,
            hasMore: false,
            truncated: source.length > 100
          }
        : projectCompact(source));
    }
  });

  it('keeps randomized error messages bounded and control-character safe', () => {
    let state = 0x4552524f;
    for (let iteration = 0; iteration < 100; iteration += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const length = state % 1200;
      const source = `${String.fromCharCode(state % 32)}${'e'.repeat(length)}\u007f`;
      const { error } = normalizeToolError(new Error(source));
      assert.ok(error.length <= 500);
      assert.doesNotMatch(error, /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
    }
  });
});
