/**
 * Shared helpers, constants, and markup utilities for the Huly MCP server.
 *
 * JSDOM polyfills MUST be at the very top before any Huly SDK imports.
 */

// Provide full browser DOM via jsdom for @hcengineering/api-client and prosemirror
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { value: dom.window, writable: true });
Object.defineProperty(globalThis, 'document', { value: dom.window.document, writable: true });
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, writable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Node = dom.window.Node;
globalThis.MutationObserver = dom.window.MutationObserver;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.CustomEvent = dom.window.CustomEvent;

// Stub indexedDB — the Huly SDK's client-resources caches the model in IndexedDB.
// The WebSocket transport needs onsuccess to fire with a fake DB so the model
// loading promise resolves. REST transport doesn't use this but it's harmless.
if (typeof globalThis.indexedDB === 'undefined') {
  globalThis.indexedDB = {
    open: () => {
      const fakeDb = {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => ({}),
        onclose: null,
        transaction: () => ({
          objectStore: () => ({
            get: () => { const r = { onsuccess: null, result: undefined }; setTimeout(() => r.onsuccess?.({ target: r }), 0); return r; },
            put: () => { const r = { onsuccess: null }; setTimeout(() => r.onsuccess?.({ target: r }), 0); return r; },
          }),
        }),
      };
      const req = { result: fakeDb, error: null, onerror: null, onsuccess: null, onupgradeneeded: null };
      setTimeout(() => {
        if (req.onupgradeneeded) req.onupgradeneeded();
        if (req.onsuccess) req.onsuccess({ target: req });
      }, 0);
      return req;
    }
  };
}

import { createRequire } from 'module';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const require = createRequire(import.meta.url);

const { markdown: markdownMarkup, html: htmlMarkup, MarkupContent } = require('@hcengineering/api-client');
const { markdownToMarkup, markupToMarkdown } = require('@hcengineering/text-markdown');
const { htmlToMarkup, markupToHtml } = require('@hcengineering/text-html');
const { jsonToMarkup, markupToJSON, isEmptyMarkup } = require('@hcengineering/text-core');

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

export const COLOR_PALETTE = {
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
export const MAX_COMPACT_ARRAY_ITEMS = 100;
export const CURSOR_TTL_MS = 24 * 60 * 60 * 1000;

const processCursorSecret = randomBytes(32);

/**
 * Lenient hours coercion for READ paths. A single malformed stored value must
 * not fail a whole page, so anything unusable reads as 0. Never use this on a
 * caller-supplied value: use parseHours, which refuses instead of discarding.
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
 * @param {string} [field] - Field name for the error message
 * @returns {number}
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
 * @returns {{estimationTotal: number, reportedTimeTotal: number}|null} null when the issue has no children
 */
export function issueRollupFields(issue) {
  const children = issue?.childInfo;
  if (!Array.isArray(children) || children.length === 0) return null;
  return {
    estimationTotal: children.reduce((sum, child) => sum + toHours(child?.estimation), toHours(issue?.estimation)),
    reportedTimeTotal: children.reduce((sum, child) => sum + toHours(child?.reportedTime), toHours(issue?.reportedTime))
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
}

function cursorSecret(options = {}) {
  return options.secret ?? process.env.HULY_CURSOR_SECRET ??
    process.env.HULY_TOKEN ?? process.env.HULY_PASSWORD ?? processCursorSecret;
}

export function cursorScopeHash(scope) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(scope ?? {})))
    .digest('base64url')
    .slice(0, 16);
}

export function cursorTuple(value) {
  const createdOn = Number(value?.createdOn ?? value?.extra?.createdOn ??
    value?.modifiedOn ?? value?.extra?.modifiedOn ?? 0);
  const id = String(value?._id ?? value?.id ?? value?.extra?._id ?? '');
  if (!Number.isFinite(createdOn) || !id) throw new Error('Result cannot be paginated: missing stable cursor fields');
  return { createdOn, id };
}

export function compareCursorTuple(left, right) {
  if (right.createdOn !== left.createdOn) return right.createdOn - left.createdOn;
  if (right.id === left.id) return 0;
  return right.id < left.id ? -1 : 1;
}

export function isTupleAfter(value, boundary) {
  const tuple = cursorTuple(value);
  return tuple.createdOn < boundary.createdOn ||
    (tuple.createdOn === boundary.createdOn && tuple.id < boundary.id);
}

/** Encode a signed, versioned, filter-bound pagination cursor. */
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

/** Decode and validate a signed pagination cursor. */
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
 * Resolve an optional due date. setDueDate already validated; createIssue,
 * updateIssue, and batchCreateIssues did not, and stored NaN instead.
 */
export function toIsoDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  // A stored NaN or unparseable string must not throw RangeError out of a read
  // path and fail the whole page.
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function normalizeDueDate(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid date: ${value}. Use ISO format, for example 2026-04-01.`);
  }
  return parsed;
}

/**
 * Map a priority name to its numeric code. An unrecognised name must fail:
 * silently storing "none" while echoing the requested value back misreports
 * the write. listIssues already rejects; the write paths did not.
 */
export function resolvePriority(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const mapped = PRIORITY_MAP[String(value).toLowerCase()];
  if (mapped === undefined) throw new Error(`Priority not found: ${value}`);
  return mapped;
}

/** Resolve a time-report date, rejecting values the SDK would store as NaN. */
export function normalizeReportDate(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid date: ${String(value)}. Use ISO format, for example 2026-04-01.`);
  }
  return parsed;
}

export function normalizePageLimit(value, fallback = DEFAULT_PAGE_SIZE, maximum = MAX_PAGE_SIZE) {
  const limit = value === undefined || value === null ? fallback : value;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new Error(`Pagination limit must be an integer from 1 to ${maximum}`);
  }
  return limit;
}

/**
 * Resolve a color value: name ("blue"), palette index (9), or RGB (0x5E6AD2).
 * Returns a number suitable for the Huly color field.
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
 * Strict map/array lookup — throws if key is missing.
 * Use instead of `map.get(key) || fallback` to surface data corruption.
 */
export function strictGet(mapOrArray, key, label) {
  const val = mapOrArray instanceof Map ? mapOrArray.get(key) : mapOrArray[key];
  if (val === undefined) {
    throw new Error(`${label} lookup failed for: ${key}`);
  }
  return val;
}

/**
 * Case-insensitive name comparison.
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

/**
 * Convert text to ProseMirror JSON markup string for the collaborator service.
 *
 * Huly stores rich text as ProseMirror JSON documents in a collaborator service
 * (Yjs-backed). The issue/milestone/comment document holds a reference ID;
 * the actual content lives in the collaborator. All text writes must go through
 * the collaborator client to be visible in the Huly UI.
 *
 * Flow: user text -> ProseMirror JSON -> jsonToMarkup() -> collaborator.updateMarkup()
 */
export function toCollaboratorMarkup(text, format = 'markdown') {
  if (!text) return jsonToMarkup({ type: 'doc', content: [] });
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
  return jsonToMarkup(pmJson);
}

/**
 * Convert ProseMirror JSON markup string back to user-readable text.
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
 * Convert text to MarkupContent for SDK fields that expect MarkupContent
 * instead of serialized ProseMirror markup strings.
 */
export function toMarkup(text, format = 'markdown') {
  if (!text) return new MarkupContent('');
  switch (format) {
    case 'html': return htmlMarkup(text);
    case 'plain': return new MarkupContent(text);
    case 'markdown':
    default: return markdownMarkup(text);
  }
}

/**
 * Extract text from a Huly description/message field.
 * Handles: MarkupContent objects, ProseMirror JSON strings, plain strings,
 * and collaborator reference strings.
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
