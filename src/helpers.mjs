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

// Stub indexedDB (Huly SDK checks for it but doesn't require it for API operations)
if (typeof globalThis.indexedDB === 'undefined') {
  globalThis.indexedDB = { open: () => ({ result: null, onerror: null, onsuccess: null }) };
}

import { createRequire } from 'module';
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
 * Convert text to MarkupContent for non-collaborator fields
 * (milestones, comments, components, projects).
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
