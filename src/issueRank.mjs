/**
 * Ranks for new and moved issues.
 *
 * Huly orders issues manually by a LexoRank string ("0|i0000n:"). Two clients that read the
 * same last rank at the same time would compute the same next rank, and Huly has no atomic
 * "next rank" operation to prevent it. The issue number is reserved atomically, so it is
 * written into the rank's fractional part as a tiebreaker: racing creates always get distinct
 * ranks, ordered by number.
 */

import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { makeRank } = require('@hcengineering/rank');

// Six base-36 digits cover 2,176,782,335 issue numbers per project with a fixed width,
// so string order matches number order.
const TIEBREAKER_WIDTH = 6;

/**
 * Rank that places issue `number` after `after` (the project's current last rank, if any).
 * @param {string|undefined} after
 * @param {number} number - The issue's reserved number.
 * @returns {string}
 */
export function issueRank(after, number) {
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Issue number must be a positive integer, received ${String(number)}`);
  }
  const next = makeRank(after, undefined);
  const integerPart = next.slice(0, next.indexOf(':') + 1);
  // The trailing "1" keeps the fraction free of trailing zeros, which LexoRank would strip,
  // so the stored string is already in the form Huly itself would write.
  const rank = `${integerPart}${number.toString(36).padStart(TIEBREAKER_WIDTH, '0')}1`;
  // makeRank only returns a fractional rank once the integer range is exhausted; its own
  // value is then the only one guaranteed to sort after `after`.
  return !after || rank > after ? rank : next;
}
