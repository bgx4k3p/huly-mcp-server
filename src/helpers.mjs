/**
 * Shared constants and helpers for the Huly MCP server: priority, status and color mappings,
 * hours and date parsing, signed pagination cursors, list envelopes, and conversion between
 * text (Markdown, HTML, plain) and Huly's ProseMirror markup.
 */

import './domPolyfill.mjs';

import { createRequire } from 'module';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url);

const { markdownToMarkup, markupToMarkdown } = require('@hcengineering/text-markdown');
const { htmlToMarkup, markupToHtml } = require('@hcengineering/text-html');
const { jsonToMarkup, markupToJSON, isEmptyMarkup, emptyMarkupNode } = require('@hcengineering/text-core');
const { jsonToPmNode } = require('@hcengineering/text');

// ── Constants ──────────────────────────────────────────────────

export const PRIORITY_MAP = {
  'urgent': 1,
  'high': 2,
  'medium': 3,
  'low': 4,
  'none': 0
};

export const PRIORITY_NAMES = ['No Priority', 'Urgent', 'High', 'Medium', 'Low'];

export const MILESTONE_STATUS_MAP = {
  'planned': 0,
  'in progress': 1,
  'inprogress': 1,
  'completed': 2,
  'canceled': 3,
  'cancelled': 3
};

export const MILESTONE_STATUS_NAMES = ['Planned', 'In Progress', 'Completed', 'Canceled'];

const COLOR_PALETTE = {
  red: 0, salmon: 1, pink: 2, hotpink: 3, magenta: 4,
  purple: 5, indigo: 6, violet: 7, navy: 8, blue: 9,
  sky: 10, cyan: 11, teal: 12, ocean: 13, mint: 14,
  green: 15, olive: 16, lime: 17, gold: 18, orange: 19,
  brown: 20, silver: 21, gray: 22, slate: 23
};

// ── Named constants ──────────────────────────────────────────
export const DONE_CATEGORY = 'task:statusCategory:Won';
export const LOST_CATEGORY = 'task:statusCategory:Lost';
export const STATUS_CATEGORY_NAMES = {
  'task:statusCategory:UnStarted': 'Backlog',
  'task:statusCategory:ToDo': 'Todo',
  'task:statusCategory:Active': 'Active',
  'task:statusCategory:Won': 'Done',
  'task:statusCategory:Lost': 'Cancelled'
};
export const DEFAULT_LABEL_CATEGORY = 'tracker:category:Other';
export const DEFAULT_LABEL_COLOR = 9;
export const PAGE_SIZE = 500;
export const MAX_BATCH_SIZE = 500;
export const AUTH_CACHE_TTL_MS = 600000;
export const DEFAULT_MILESTONE_DAYS = 30;
export const DEFAULT_PAGE_SIZE = 50;
export const DEFAULT_DETAIL_PAGE_SIZE = 20;
export const FILTER_ID_BATCH_SIZE = 100;
export const FILTER_QUERY_CONCURRENCY = 4;
export const MAX_LABEL_FILTER_ISSUES = 5000;
export const LOOKUP_CACHE_TTL_MS = 60000;
export const MAX_PAGE_SIZE = 100;
export const MAX_DETAIL_PAGE_SIZE = 50;
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const processCursorSecret = randomBytes(32);

/**
 * Lenient hours coercion for READ paths. A single malformed stored value must
 * not fail a whole page, so anything unusable reads as 0. Never use this on a
 * caller-supplied value: use parseHours, which refuses instead of discarding.
 * @param {*} value - Stored hours value
 * @returns {number} Finite number, or 0
 */
export function toHours(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

/**
 * Strict hours parsing for WRITE paths. Coercing a caller's value to 0 records
 * nothing while reporting success, so a value that cannot be an hour count is
 * rejected rather than written.
 * @param {*} value - Caller-supplied hours
 * @param {string} [field='hours'] - Field name for the error message
 * @returns {number} Non-negative finite number
 * @throws {Error} When the value is missing, boolean, blank, non-numeric or negative
 */
export function parseHours(value, field = 'hours') {
  if (value === null || value === undefined || typeof value === 'boolean' ||
      (typeof value === 'string' && value.trim() === '')) {
    throw new Error(`${field} must be a number, received ${JSON.stringify(value)}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${field} must be a number, received ${JSON.stringify(value)}`);
  }
  if (number < 0) {
    throw new Error(`${field} cannot be negative, received ${number}`);
  }
  return number;
}

/**
 * Read an issue's own estimation and reported time as hours, coercing bad values to 0.
 * @param {Object} issue - Raw issue document
 * @returns {{estimation: number, reportedTime: number}}
 */
export function issueTimeFields(issue) {
  return {
    estimation: toHours(issue?.estimation),
    reportedTime: toHours(issue?.reportedTime)
  };
}

/**
 * Rolled-up time for an issue that has children, matching what the Huly UI
 * displays. An issue's own `estimation` and `reportedTime` count only time
 * booked directly on it; Huly never rolls descendants into those fields. The
 * per-child totals live in the server-maintained `childInfo` array, and the UI
 * sums one level — a grandchild's time reaches the grandparent only through
 * its own parent's direct total, which is why this is deliberately not
 * recursive.
 * @param {Object} issue - Raw issue document carrying childInfo
 * @returns {{estimationTotal: number, reportedTimeTotal: number}|null} The issue's own time plus each direct
 *   child's childInfo time, or null when the issue has no children
 */
export function issueRollupFields(issue) {
  const children = issue?.childInfo;
  if (!Array.isArray(children) || children.length === 0) return null;
  return {
    estimationTotal: children.reduce((sum, child) => sum + toHours(child?.estimation), toHours(issue?.estimation)),
    reportedTimeTotal: children.reduce((sum, child) => sum + toHours(child?.reportedTime), toHours(issue?.reportedTime))
  };
}

/**
 * Return a copy of a value with object keys sorted recursively, for stable JSON hashing.
 * @param {*} value
 * @returns {*}
 */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

/**
 * Return the HMAC key for pagination cursors: options.secret, then HULY_CURSOR_SECRET, HULY_TOKEN,
 * HULY_PASSWORD (read live from the env), then a random per-process secret.
 * @param {Object} [options]
 * @param {string|Buffer} [options.secret] - Explicit secret
 * @returns {string|Buffer}
 */
function cursorSecret(options = {}) {
  return options.secret ?? process.env.HULY_CURSOR_SECRET ??
    process.env.HULY_TOKEN ?? process.env.HULY_PASSWORD ?? processCursorSecret;
}

/**
 * Hash a query scope (filters and other cursor-binding parameters) to a short stable string.
 * @param {*} scope - JSON-serializable scope; null or undefined hashes as {}
 * @returns {string} First 16 base64url characters of the SHA-256 digest
 */
export function cursorScopeHash(scope) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(scope ?? {})))
    .digest('base64url')
    .slice(0, 16);
}

/**
 * Extract the (createdOn, id) ordering tuple from a raw or formatted record, falling back to
 * modifiedOn and to fields under `extra`.
 * @param {Object} value - Record
 * @returns {{createdOn: number, id: string}}
 * @throws {Error} When the record has no finite timestamp or no id
 */
export function cursorTuple(value) {
  const createdOn = Number(value?.createdOn ?? value?.extra?.createdOn ??
    value?.modifiedOn ?? value?.extra?.modifiedOn ?? 0);
  const id = String(value?._id ?? value?.id ?? value?.extra?._id ?? '');
  if (!Number.isFinite(createdOn) || !id) throw new Error('Result cannot be paginated: missing stable cursor fields');
  return { createdOn, id };
}

/**
 * Compare cursor tuples for newest-first order: createdOn descending, then id descending.
 * @param {{createdOn: number, id: string}} left
 * @param {{createdOn: number, id: string}} right
 * @returns {number} Negative when left sorts first, positive when right does, 0 when equal
 */
export function compareCursorTuple(left, right) {
  if (right.createdOn !== left.createdOn) return right.createdOn - left.createdOn;
  if (right.id === left.id) return 0;
  return right.id < left.id ? -1 : 1;
}

/**
 * Report whether a record sorts strictly after a boundary tuple in newest-first order.
 * @param {Object} value - Record
 * @param {{createdOn: number, id: string}} boundary
 * @returns {boolean}
 * @throws {Error} When the record has no cursor fields
 */
export function isTupleAfter(value, boundary) {
  const tuple = cursorTuple(value);
  return tuple.createdOn < boundary.createdOn ||
    (tuple.createdOn === boundary.createdOn && tuple.id < boundary.id);
}

/**
 * Encode a signed, versioned, scope-bound pagination cursor (base64url payload and truncated HMAC).
 * @param {Object} after - Last record on the current page
 * @param {Object} [options]
 * @param {Object} [options.watermark] - Record marking the newest result at pagination start; defaults to after
 * @param {*} [options.scope] - Query scope the cursor is bound to
 * @param {number} [options.now=Date.now()] - Issue time in milliseconds
 * @param {string|Buffer} [options.secret] - HMAC key; see cursorSecret
 * @returns {string}
 * @throws {Error} When after or the watermark has no cursor fields
 */
export function encodeCursor(after, options = {}) {
  const afterTuple = cursorTuple(after);
  const watermarkTuple = cursorTuple(options.watermark ?? after);
  const issuedAt = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    q: cursorScopeHash(options.scope),
    w: [watermarkTuple.createdOn, watermarkTuple.id],
    a: [afterTuple.createdOn, afterTuple.id],
    i: issuedAt
  })).toString('base64url');
  const signature = createHmac('sha256', cursorSecret(options))
    .update(payload)
    .digest()
    .subarray(0, 16)
    .toString('base64url');
  return `${payload}.${signature}`;
}

/**
 * Decode and validate a signed pagination cursor.
 * @param {string} cursor - Cursor from a previous page
 * @param {Object} [options]
 * @param {*} [options.scope] - Query scope; must match the scope the cursor was issued for
 * @param {number} [options.now=Date.now()] - Current time in milliseconds
 * @param {number} [options.ttlMs=CURSOR_TTL_MS] - Maximum cursor age
 * @param {string|Buffer} [options.secret] - HMAC key; see cursorSecret
 * @returns {{version: number, watermark: {createdOn: number, id: string}, after: {createdOn: number, id: string}}}
 * @throws {Error} When the cursor is malformed, has a bad signature, belongs to another query, is older
 *   than the TTL, or is issued more than five minutes in the future
 */
export function decodeCursor(cursor, options = {}) {
  try {
    if (typeof cursor !== 'string' || cursor.length > 1024) throw new Error();
    const parts = cursor.split('.');
    if (parts.length !== 2) {
      throw new Error('Unsupported pagination cursor format; restart pagination');
    }
    const [payload, suppliedSignature] = parts;
    const encodedPart = /^[A-Za-z0-9_-]+$/;
    if (!encodedPart.test(payload) || !encodedPart.test(suppliedSignature)) {
      throw new Error('Pagination cursor signature is invalid');
    }
    const payloadBytes = Buffer.from(payload, 'base64url');
    const supplied = Buffer.from(suppliedSignature, 'base64url');
    if (payloadBytes.toString('base64url') !== payload ||
        supplied.toString('base64url') !== suppliedSignature) {
      throw new Error('Pagination cursor signature is invalid');
    }
    const expectedSignature = createHmac('sha256', cursorSecret(options))
      .update(payload)
      .digest()
      .subarray(0, 16);
    if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) {
      throw new Error('Pagination cursor signature is invalid');
    }
    const parsed = JSON.parse(payloadBytes.toString());
    if (parsed.v !== 1 || parsed.q !== cursorScopeHash(options.scope) ||
        !Array.isArray(parsed.w) || !Array.isArray(parsed.a) ||
        parsed.w.length !== 2 || parsed.a.length !== 2 ||
        !Number.isFinite(parsed.w[0]) || typeof parsed.w[1] !== 'string' ||
        !Number.isFinite(parsed.a[0]) || typeof parsed.a[1] !== 'string' ||
        !Number.isInteger(parsed.i)) {
      if (parsed.q !== cursorScopeHash(options.scope)) {
        throw new Error('Pagination cursor does not match this query');
      }
      throw new Error('Pagination cursor payload is invalid');
    }
    const now = options.now ?? Date.now();
    const ttl = options.ttlMs ?? CURSOR_TTL_MS;
    if ((parsed.i * 1000) > now + 300000 || now - (parsed.i * 1000) > ttl) {
      throw new Error('Pagination cursor is stale; restart pagination');
    }
    return {
      version: parsed.v,
      watermark: { createdOn: parsed.w[0], id: parsed.w[1] },
      after: { createdOn: parsed.a[0], id: parsed.a[1] }
    };
  } catch (error) {
    if (error?.message?.startsWith('Pagination cursor') ||
        error?.message?.startsWith('Unsupported pagination cursor')) throw error;
    throw new Error('Invalid pagination cursor');
  }
}

/**
 * Build the v3 list envelope. Pagination metadata is stated by the producer,
 * which knows whether a page was cut short, rather than inferred downstream
 * from the shape of the payload.
 * @param {Array} items - Page items
 * @param {string} [nextCursor] - Cursor for the next page, when there is one
 * @returns {{items: Array, count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}}
 */
export function listEnvelope(items, nextCursor) {
  return {
    items,
    count: items.length,
    hasMore: Boolean(nextCursor),
    truncated: Boolean(nextCursor),
    ...(nextCursor ? { nextCursor } : {})
  };
}

/**
 * Format a stored timestamp or date string as an ISO 8601 string for output.
 * Unparseable values become null, so one bad stored value cannot fail a whole read.
 * @param {number|string|null|undefined} value
 * @returns {string|null}
 */
export function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  // A stored NaN or unparseable string must not throw RangeError out of a read
  // path and fail the whole page.
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Parse an optional due date for storage. Blank or missing means no due date.
 * @param {string|number|null|undefined} value - ISO date or timestamp
 * @returns {number|null} Millisecond timestamp, or null to clear
 * @throws {Error} When the value is not a parseable date
 */
export function normalizeDueDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid date: ${value}. Use ISO format, for example 2026-04-01.`);
  }
  return parsed;
}

/**
 * Map a priority name to its numeric code. An unrecognised name fails rather than silently storing
 * "none" while echoing the requested value back.
 * @param {string|null|undefined} value - Priority name (case-insensitive)
 * @param {number} [fallback=0] - Code used when no priority is given
 * @returns {number}
 * @throws {Error} When the name is not a known priority
 */
export function resolvePriority(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const mapped = PRIORITY_MAP[String(value).toLowerCase()];
  if (mapped === undefined) throw new Error(`Priority not found: ${value}`);
  return mapped;
}

/**
 * Resolve a time-report date, rejecting values the SDK would store as NaN.
 * @param {string|number|null|undefined} value - ISO date or timestamp; blank means now
 * @returns {number} Millisecond timestamp
 * @throws {Error} When the value is not a parseable date
 */
export function normalizeReportDate(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid date: ${String(value)}. Use ISO format, for example 2026-04-01.`);
  }
  return parsed;
}

/**
 * Validate a page-size limit, using the fallback when none is given.
 * @param {number|null|undefined} value - Requested limit
 * @param {number} [fallback=DEFAULT_PAGE_SIZE] - Limit used when value is null or undefined
 * @param {number} [maximum=MAX_PAGE_SIZE] - Largest allowed limit
 * @returns {number}
 * @throws {Error} When the limit is not an integer from 1 to maximum
 */
export function normalizePageLimit(value, fallback = DEFAULT_PAGE_SIZE, maximum = MAX_PAGE_SIZE) {
  const limit = value === undefined || value === null ? fallback : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Pagination limit must be an integer from 1 to ${maximum}`);
  }
  return limit;
}

/**
 * Resolve a color value: palette name ("blue", case-insensitive) or a number, which is returned
 * as-is (palette index or RGB such as 0x5E6AD2). Unknown names and other types use the fallback.
 * @param {string|number|null|undefined} value
 * @param {number} [fallback=DEFAULT_LABEL_COLOR] - Color used when value is missing or unrecognised
 * @returns {number} Value for the Huly color field
 */
export function resolveColor(value, fallback = DEFAULT_LABEL_COLOR) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    const idx = COLOR_PALETTE[value.toLowerCase()];
    if (idx !== undefined) return idx;
  }
  if (typeof value === 'number') return value;
  return fallback;
}

// ── Utilities ──────────────────────────────────────────────────

/**
 * Strict map/array/object lookup that throws when the key is missing (value undefined).
 * Use instead of `map.get(key) || fallback` to surface data corruption.
 * @param {Map|Array|Object} mapOrArray - Collection to read
 * @param {*} key - Key or index
 * @param {string} label - Name used in the error message
 * @returns {*}
 * @throws {Error} When the key has no value
 */
export function strictGet(mapOrArray, key, label) {
  const val = mapOrArray instanceof Map ? mapOrArray.get(key) : mapOrArray[key];
  if (val === undefined) {
    throw new Error(`${label} lookup failed for: ${key}`);
  }
  return val;
}

/**
 * Case-insensitive name comparison that also treats "Cancelled" and "Canceled" as equal.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @returns {boolean}
 */
export function nameMatch(a, b) {
  const la = (a || '').toLowerCase();
  const lb = (b || '').toLowerCase();
  if (la === lb) return true;
  // Handle Cancelled/Canceled spelling variants
  if (la.replace('cancelled', 'canceled') === lb.replace('cancelled', 'canceled')) return true;
  return false;
}

/**
 * Build a response object with known fields + raw extras.
 * Known fields are at the top level with resolved/formatted values.
 * Any raw SDK fields not in the known set go into an `extra` object.
 * This future-proofs the API — new SDK fields appear automatically in `extra`.
 * @param {Object} raw - Raw SDK document
 * @param {Object} known - Formatted known fields
 * @returns {Object} known, plus `extra` when raw has keys not in known
 */
export function withExtra(raw, known) {
  const knownKeys = new Set(Object.keys(known));
  const extra = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!knownKeys.has(key)) {
      extra[key] = value;
    }
  }
  return Object.keys(extra).length > 0 ? { ...known, extra } : known;
}

// ── Markup Conversion ──────────────────────────────────────────

let _markupSchema = null;

/**
 * Return the ProseMirror schema Huly's editor validates against, built once and cached.
 * @returns {Object} ProseMirror Schema
 */
function markupSchema() {
  _markupSchema ??= jsonToPmNode({ type: 'doc', content: [{ type: 'paragraph' }] }).type.schema;
  return _markupSchema;
}

/**
 * Drop mark combinations the editor schema forbids.
 *
 * markdownToMarkup happily emits marks the schema excludes — `**`code`**` yields
 * a text node carrying both bold and code, but the code mark declares
 * excludes: "_", so it may not coexist with any other mark. Such a document
 * fails Node.check() and the Huly UI renders the whole description blank.
 *
 * Marks are re-applied through Mark.addToSet, so the schema's own exclusion
 * rules decide which survive rather than a hardcoded precedence list. Marks unknown to the
 * schema are dropped.
 * @param {Object} node - ProseMirror JSON node, mutated in place (recursively)
 * @returns {Object} The same node
 */
function sanitizeMarkupNode(node) {
  if (Array.isArray(node.content)) node.content.forEach(sanitizeMarkupNode);
  if (!Array.isArray(node.marks) || node.marks.length < 2) return node;

  const schema = markupSchema();
  let set = [];
  for (const mark of node.marks) {
    const type = schema.marks[mark.type];
    if (type === undefined) continue;
    set = type.create(mark.attrs ?? null).addToSet(set);
  }
  node.marks = set.map(mark => mark.toJSON());
  return node;
}

/**
 * Re-normalize a stored markup string so it satisfies the editor schema: forbidden mark
 * combinations are removed and an empty document becomes one empty paragraph.
 * @param {string} markup - Markup string
 * @returns {string} Normalized markup string
 */
export function normalizeMarkup(markup) {
  const json = markupToJSON(markup);
  // A doc with no children fails the block+ content expression.
  if (!Array.isArray(json.content) || json.content.length === 0) {
    return jsonToMarkup(emptyMarkupNode());
  }
  return jsonToMarkup(sanitizeMarkupNode(json));
}

/**
 * Convert text to a ProseMirror JSON markup string for the collaborator service.
 *
 * Huly stores issue descriptions and other collaborative rich text in a Yjs-backed
 * collaborator service; the document holds a reference ID and the content lives in
 * the collaborator. Text writes must go through the collaborator client to be visible
 * in the Huly UI. Empty text yields one empty paragraph; forbidden mark combinations
 * are removed.
 * @param {string} text - Source text
 * @param {string} [format='markdown'] - 'markdown', 'html' or 'plain'; other values are treated as Markdown
 * @returns {string} Markup string
 */
export function toCollaboratorMarkup(text, format = 'markdown') {
  // { doc, content: [] } fails the editor schema — doc requires block+ — so an
  // empty description must use Huly's canonical empty node, one empty paragraph.
  if (!text) return jsonToMarkup(emptyMarkupNode());
  let pmJson;
  switch (format) {
    case 'html':
      pmJson = htmlToMarkup(text);
      break;
    case 'plain':
      pmJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
      break;
    case 'markdown':
    default:
      pmJson = markdownToMarkup(text);
      break;
  }
  return jsonToMarkup(sanitizeMarkupNode(pmJson));
}

/**
 * Convert a ProseMirror JSON markup string back to user-readable text.
 * @param {string} markup - Markup string
 * @param {string} [format='markdown'] - 'html' or 'markdown'; other values produce Markdown
 * @returns {string} Converted text; '' for empty markup; the input itself when it cannot be converted
 */
export function fromCollaboratorMarkup(markup, format = 'markdown') {
  if (!markup || isEmptyMarkup(markup)) return '';
  try {
    const pmJson = markupToJSON(markup);
    switch (format) {
      case 'html':
        return markupToHtml(pmJson);
      case 'markdown':
      default:
        return markupToMarkdown(pmJson);
    }
  } catch {
    return typeof markup === 'string' ? markup : String(markup);
  }
}

/**
 * Convert text to inline Markup for milestone and component descriptions.
 *
 * Huly types those fields as `Markup` — a plain string holding a ProseMirror
 * JSON document stored directly on the doc, unlike issue descriptions which
 * hold a collaborator reference.
 *
 * The SDK's MarkupContent wrapper must NOT be used here. It is only unwrapped
 * by PlatformClientImpl.processMarkup, and this server holds a bare
 * TxOperations on both transports (see connect() in client/connection.mjs), so a MarkupContent is
 * persisted verbatim as {"content":..,"kind":..}. The Huly UI then renders an
 * empty description, while fromMarkup() still unwraps it on read — which makes
 * a round-trip through this server look correct.
 * @param {string} text - Source text
 * @param {string} [format='markdown'] - 'markdown', 'html' or 'plain'
 * @returns {string} Markup string
 */
export function toMarkup(text, format = 'markdown') {
  return toCollaboratorMarkup(text, format);
}

/**
 * Extract text from a Huly description/message field.
 * Handles: MarkupContent objects (returns `content`), ProseMirror JSON doc strings
 * (converted to Markdown), collaborator reference strings and plain strings (returned as-is).
 * @param {*} value - Field value
 * @returns {string} Text; '' for empty values
 * @throws {Error} When a string starts with { or [ but is not valid JSON
 */
export function fromMarkup(value) {
  if (!value) return '';
  if (typeof value === 'object' && value.content !== undefined) {
    return value.content;
  }
  if (typeof value === 'string') {
    if (/^[a-f0-9]+-\w+-\d+$/.test(value)) {
      return value;
    }
    try {
      const parsed = JSON.parse(value);
      if (parsed && parsed.type === 'doc') {
        return fromCollaboratorMarkup(value);
      }
    } catch {
      // Not JSON — could be plain text or corrupted markup.
      // Throw if it looks like truncated/malformed JSON, return as-is if plain text.
      if (value.startsWith('{') || value.startsWith('[')) {
        throw new Error(`Corrupted markup (invalid JSON): ${value.slice(0, 100)}`);
      }
    }
    return value;
  }
  return String(value);
}
