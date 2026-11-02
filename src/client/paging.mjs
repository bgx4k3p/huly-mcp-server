/**
 * Cursor pagination over SDK queries.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  compareCursorTuple,
  cursorTuple,
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  encodeCursor,
  FILTER_ID_BATCH_SIZE,
  FILTER_QUERY_CONCURRENCY,
  isTupleAfter,
  listEnvelope,
  MAX_PAGE_SIZE,
  normalizePageLimit,
  PAGE_SIZE
} from '../helpers.mjs';
import { tracker } from './sdk.mjs';

export class PagingMethods {
  /**
   * Cursor-paginated findAll, newest first (createdOn desc, then id). Fetches from the SDK in PAGE_SIZE batches.
   * @param {Object} client - Huly SDK client
   * @param {string} _class - Document class
   * @param {Object} query - Query filter
   * @param {Object} [options] - Paging options; any other keys are passed to the SDK findAll
   * @param {number} [options.limit=50] - Page size
   * @param {number} [options.maxLimit=100] - Largest accepted page size
   * @param {string} [options.cursor] - Cursor from a previous page
   * @param {Object} [options.cursorScope] - Values the cursor is bound to; defaults to workspace, class and query
   * @param {Object} [options.after] - Internal start position, used when no cursor is given
   * @param {Object} [options.watermark] - Internal watermark, used when no cursor is given
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   * @throws {Error} When the limit or cursor is invalid, or one timestamp holds more than PAGE_SIZE records
   */
  async _paginatedFindAll(client, _class, query, options = {}) {
    const {
      cursor,
      cursorScope = { workspace: this.workspace, class: _class, query },
      maxLimit = MAX_PAGE_SIZE,
      after: internalAfter,
      watermark: internalWatermark,
      limit: requestedLimit,
      ...findAllOptions
    } = options;
    const limit = normalizePageLimit(requestedLimit, DEFAULT_PAGE_SIZE, maxLimit);
    const decoded = cursor ? decodeCursor(cursor, { scope: cursorScope }) : null;
    let after = decoded?.after ?? internalAfter;
    let watermark = decoded?.watermark ?? internalWatermark;

    const allResults = [];
    let remaining = limit + 1; // fetch one extra to detect next page

    while (remaining > 0) {
      const pageLimit = Math.min(remaining, PAGE_SIZE);
      let page;
      if (!after) {
        page = await client.findAll(_class, query, {
          ...findAllOptions,
          // Fetch a full SDK page so a timestamp tie at the caller's smaller
          // page boundary can be ordered deterministically in memory.
          limit: PAGE_SIZE,
          sort: { createdOn: -1 }
        });
      } else {
        const sameTimestamp = await client.findAll(_class, {
          ...query,
          createdOn: after.createdOn
        }, { ...findAllOptions, limit: PAGE_SIZE });
        const sameEligible = sameTimestamp
          .filter(item => isTupleAfter(item, after))
          .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));

        if (sameTimestamp.length === PAGE_SIZE && sameEligible.length < pageLimit) {
          throw new Error(
            `Pagination timestamp contains more than ${PAGE_SIZE} records; refine the query`
          );
        }

        const older = sameEligible.length >= pageLimit
          ? []
          : await client.findAll(_class, {
            ...query,
            createdOn: { $lt: after.createdOn }
          }, {
            ...findAllOptions,
            limit: PAGE_SIZE,
            sort: { createdOn: -1 }
          });
        page = [...sameEligible, ...older]
          .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));
      }

      page = page
        .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)))
        .slice(0, pageLimit);

      if (page.length === 0) break;

      allResults.push(...page);
      remaining -= page.length;
      after = cursorTuple(page[page.length - 1]);
      watermark ??= cursorTuple(page[0]);

      if (page.length < pageLimit) break;
    }

    // If we got more than limit, there are more results
    if (allResults.length > limit) {
      const items = allResults.slice(0, limit);
      return listEnvelope(items, encodeCursor(items[items.length - 1], {
        scope: cursorScope,
        watermark
      }));
    }

    return listEnvelope(allResults);
  }

  /**
   * In-memory cursor pagination for small collections fetched via findAll.
   * Filters by cursor, sorts by createdOn desc, slices to limit.
   * @param {Object[]} allResults - Full result set from findAll
   * @param {Object} [options] - Paging options
   * @param {number} [options.limit=50] - Page size
   * @param {number} [options.maxLimit=100] - Largest accepted page size
   * @param {string} [options.cursor] - Cursor from a previous page
   * @param {Object} [options.cursorScope] - Values the cursor is bound to; defaults to workspace and 'generic'
   * @returns {{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}}
   * @throws {Error} When the limit or cursor is invalid
   */
  _cursoredFindAll(allResults, options = {}) {
    const {
      cursor,
      cursorScope = { workspace: this.workspace, collection: 'generic' },
      maxLimit = MAX_PAGE_SIZE
    } = options;
    const limit = normalizePageLimit(options.limit, DEFAULT_PAGE_SIZE, maxLimit);
    let items = [...allResults];

    if (cursor) {
      const decoded = decodeCursor(cursor, { scope: cursorScope });
      items = items.filter(item => isTupleAfter(item, decoded.after));
    }

    items.sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));

    if (items.length > limit) {
      const page = items.slice(0, limit);
      const decoded = cursor ? decodeCursor(cursor, { scope: cursorScope }) : null;
      return listEnvelope(page, encodeCursor(page[page.length - 1], {
        scope: cursorScope,
        watermark: decoded?.watermark ?? page[0]
      }));
    }

    return listEnvelope(items);
  }

  /**
   * Map items through an async mapper with at most `concurrency` calls in flight, preserving order.
   * @param {Array} items - Input items
   * @param {number} concurrency - Maximum concurrent mapper calls
   * @param {(item: *, index: number) => Promise<*>} mapper - Async mapper
   * @returns {Promise<Array>} Results in input order
   */
  async _mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await mapper(items[index], index);
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  /**
   * Cursor-paginated issue query restricted to a set of issue ids, querying the ids in FILTER_ID_BATCH_SIZE
   * batches and merging the pages newest first.
   * @param {Object} client - Huly SDK client
   * @param {Object} query - Issue query filter
   * @param {string[]} issueIds - Issue ids to restrict to
   * @param {Object} options - Paging options
   * @param {number} options.limit - Page size (already normalized by the caller)
   * @param {string} [options.cursor] - Cursor from a previous page
   * @param {Object} [options.cursorScope] - Values the cursor is bound to; defaults to workspace, class, query
   *   and ids
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   */
  async _paginatedIssuesByIds(client, query, issueIds, options) {
    const cursorScope = options.cursorScope ?? {
      workspace: this.workspace,
      class: tracker.class.Issue,
      query,
      issueIds: [...issueIds].sort()
    };
    const decoded = options.cursor
      ? decodeCursor(options.cursor, { scope: cursorScope })
      : null;
    const batches = [];
    for (let offset = 0; offset < issueIds.length; offset += FILTER_ID_BATCH_SIZE) {
      batches.push(issueIds.slice(offset, offset + FILTER_ID_BATCH_SIZE));
    }
    const perBatch = await this._mapWithConcurrency(
      batches,
      FILTER_QUERY_CONCURRENCY,
      batch => this._paginatedFindAll(client, tracker.class.Issue, {
        ...query,
        _id: { $in: batch }
      }, {
        limit: options.limit + 1,
        maxLimit: MAX_PAGE_SIZE + 1,
        after: decoded?.after,
        watermark: decoded?.watermark,
        cursorScope: { ...cursorScope, batch }
      })
    );
    const merged = perBatch
      .flatMap(page => page.items)
      .sort((a, b) => (b.createdOn - a.createdOn) || compareCursorTuple(
        { createdOn: a.createdOn, id: String(a._id) },
        { createdOn: b.createdOn, id: String(b._id) }
      ));
    if (merged.length > options.limit) {
      const items = merged.slice(0, options.limit);
      return listEnvelope(items, encodeCursor(items[items.length - 1], {
        scope: cursorScope,
        watermark: decoded?.watermark ?? items[0]
      }));
    }
    return listEnvelope(merged);
  }
}
