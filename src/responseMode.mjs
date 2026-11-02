const RESPONSE_MODES = new Set(['compact', 'raw']);
const RESPONSE_MODE_META_KEY = 'com.huly/responseMode';
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_COMPACT_ARRAY_ITEMS = 100;
const DEFAULT_RESPONSE_MODE = 'compact';
export const SUPPORTED_RESPONSE_MODES = Object.freeze([...RESPONSE_MODES]);

function parseMode(value, source) {
  if (value === undefined || value === null || value === '') return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (!RESPONSE_MODES.has(normalized)) {
    throw new Error(`Invalid ${source}: expected compact or raw`);
  }
  return normalized;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Compact projection: drop the unreviewed SDK passthrough (`extra`) and cap long arrays, without dropping
 * documented nulls, empty arrays, empty objects or other contract values.
 * @param {*} value - Tool result or any nested value
 * @returns {*}
 */
export function projectCompact(value) {
  if (Array.isArray(value)) return value.map(projectCompact);
  if (!isPlainObject(value)) return value;

  const entries = [];
  const collectionMetadata = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'extra') continue;
    if (Array.isArray(child) && child.length > MAX_COMPACT_ARRAY_ITEMS) {
      entries.push([key, child.slice(0, MAX_COMPACT_ARRAY_ITEMS).map(projectCompact)]);
      collectionMetadata.push([`${key}Count`, child.length]);
      collectionMetadata.push([`${key}Truncated`, true]);
    } else {
      entries.push([key, projectCompact(child)]);
    }
  }
  for (const [key, metadataValue] of collectionMetadata) {
    if (!entries.some(([entryKey]) => entryKey === key)) entries.push([key, metadataValue]);
  }
  return Object.fromEntries(entries);
}

export function serializeToolResult(result, mode = DEFAULT_RESPONSE_MODE) {
  const parsedMode = parseMode(mode, 'response mode') ?? DEFAULT_RESPONSE_MODE;
  if (parsedMode === 'raw') return JSON.stringify(result);
  if (Array.isArray(result)) {
    const items = result.slice(0, MAX_COMPACT_ARRAY_ITEMS).map(projectCompact);
    const dropped = result.length > items.length;
    return JSON.stringify({
      items,
      count: items.length,
      totalCount: result.length,
      // A bare array carries no cursor, so dropped records are unreachable from
      // this result. Report that rather than implying the page is complete.
      hasMore: dropped,
      truncated: dropped
    });
  }
  return JSON.stringify(projectCompact(result));
}

export function normalizeToolError(error) {
  const raw = typeof error?.message === 'string' && error.message.trim()
    ? error.message
    : 'Tool call failed';
  const safe = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ');
  return { error: safe.slice(0, MAX_ERROR_MESSAGE_LENGTH) };
}

/**
 * Create an immutable response policy for one MCP server/session.
 * Per-call mode wins over the captured session option, which wins over the
 * environment value. No request can mutate another client's mode.
 */
export function createResponseSerializer(options = {}) {
  const sessionMode = parseMode(options.responseMode, 'session response mode');
  const environmentMode = parseMode(
    options.environmentMode ?? process.env.HULY_RESPONSE_MODE,
    'HULY_RESPONSE_MODE'
  );
  const fallbackMode = sessionMode ?? environmentMode ?? DEFAULT_RESPONSE_MODE;
  function resolve(meta) {
    const metadataMode = parseMode(meta?.[RESPONSE_MODE_META_KEY], RESPONSE_MODE_META_KEY);
    return metadataMode ?? fallbackMode;
  }

  return Object.freeze({
    defaultMode: fallbackMode,
    resolve,
    serialize: serializeToolResult
  });
}

export const RESPONSE_MODE_USAGE =
  `Set per-call _meta["${RESPONSE_MODE_META_KEY}"] to compact or raw; ` +
  'compact returns the reviewed projection and raw opts into minified SDK extra fields.';
