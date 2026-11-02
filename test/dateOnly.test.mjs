import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { toIsoDay } from '../src/helpers.mjs';

describe('toIsoDay', () => {
  it('formats timestamps and date strings as YYYY-MM-DD', () => {
    assert.equal(toIsoDay(Date.UTC(2026, 3, 1, 15)), '2026-04-01');
    assert.equal(toIsoDay('2026-12-31'), '2026-12-31');
  });

  it('returns null for missing or corrupt values instead of throwing', () => {
    // One bad stored date must not fail a whole page of results.
    for (const value of [undefined, null, '', 0, Number.NaN, 'not a date']) {
      assert.equal(toIsoDay(value), null, String(value));
    }
  });
});
