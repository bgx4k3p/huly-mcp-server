import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { issueRank } from '../src/issueRank.mjs';

const require = createRequire(import.meta.url);
const { makeRank } = require('@hcengineering/rank');
// lexorank is Huly's rank dependency, not ours; resolve it from there.
const { LexoRank } = createRequire(require.resolve('@hcengineering/rank'))('lexorank');

// The single rank every issue received before ranks were computed per issue.
const LEGACY_RANK = '0|hzzzzz:';

describe('issueRank', () => {
  it('sorts after every kind of existing rank', () => {
    const tiebroken = issueRank(LEGACY_RANK, 5);
    const dragged = makeRank(tiebroken, issueRank(tiebroken, 6));
    for (const after of [undefined, '', LEGACY_RANK, tiebroken, dragged]) {
      const rank = issueRank(after, 7);
      assert.ok(!after || rank > after, `${rank} must sort after ${after}`);
    }
  });

  it('gives racing creates that read the same last rank distinct ranks in number order', () => {
    const first = issueRank(LEGACY_RANK, 10);
    const second = issueRank(LEGACY_RANK, 11);
    assert.notEqual(first, second);
    assert.ok(first < second);
  });

  it('keeps string order equal to number order across digit boundaries', () => {
    const numbers = [1, 9, 10, 35, 36, 37, 1295, 1296, 46655, 46656, 2_176_782_335];
    const ranks = numbers.map(number => issueRank(LEGACY_RANK, number));
    assert.deepEqual([...ranks].sort(), ranks);
    assert.equal(new Set(ranks).size, ranks.length);
  });

  it('stores ranks already in the canonical form Huly writes', () => {
    for (const number of [1, 36, 1296, 46656, 2_176_782_335]) {
      const rank = issueRank(LEGACY_RANK, number);
      assert.equal(LexoRank.parse(rank).toString(), rank);
    }
  });

  it('orders a batch that shares one position by number, and ranks the next create after it', () => {
    const batch = [40, 41, 42, 43].map(number => issueRank(LEGACY_RANK, number));
    assert.deepEqual([...batch].sort(), batch);
    assert.ok(batch[0] > LEGACY_RANK);
    assert.ok(issueRank(batch.at(-1), 44) > batch.at(-1));
  });

  it('leaves room for Huly to place a dragged issue between two of these ranks', () => {
    const left = issueRank(LEGACY_RANK, 12);
    const right = issueRank(LEGACY_RANK, 13);
    const between = makeRank(left, right);
    assert.ok(left < between && between < right);
    assert.ok(makeRank(right, undefined) > right);
    assert.ok(makeRank(undefined, left) < left);
  });

  it('falls back to the plain next rank once the integer range is exhausted', () => {
    // Near the top of the range makeRank returns a fractional rank inside the same integer,
    // where a tiebreaker could sort before the existing rank.
    const after = '0|zzzzzy:z';
    const rank = issueRank(after, 3);
    assert.ok(rank > after);
    assert.equal(rank, makeRank(after, undefined));
  });

  it('rejects numbers that cannot have been reserved', () => {
    for (const number of [0, -1, 1.5, Number.NaN, undefined]) {
      assert.throws(() => issueRank(LEGACY_RANK, number), /positive integer/);
    }
  });
});
