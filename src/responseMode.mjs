const RESPONSE_MODES = new Set(['compact', 'raw']);
const RESPONSE_MODE_META_KEY = 'com.huly/responseMode';
const MAX_ERROR_MESSAGE_LENGTH = 500;
const MAX_COMPACT_ARRAY_ITEMS = 100;

// Deliberately empty for now. Add a key only after reviewing its stability,
// sensitivity, and usefulness to MCP clients.
export const COMPACT_EXTRA_ALLOWLIST = new Set();
export const DEFAULT_RESPONSE_MODE = 'compact';
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
 * Remove unreviewed SDK passthrough fields without dropping documented nulls,
 * empty arrays, empty objects, or other contract values.
 */
export function projectCompact(value) {
  if (Array.isArray(value)) return value.map(projectCompact);
  if (!isPlainObject(value)) return value;

  const entries = [];
  const collectionMetadata = [];
  for (const [key, child] of Object.entries(value)) {
    if (key === 'extra') {
      if (isPlainObject(child)) {
        const allowed = Object.entries(child)
          .filter(([extraKey]) => COMPACT_EXTRA_ALLOWLIST.has(extraKey))
          .map(([extraKey, extraValue]) => [extraKey, projectCompact(extraValue)]);
        if (allowed.length > 0) entries.push(['extra', Object.fromEntries(allowed)]);
      }
      continue;
    }
    if (Array.isArray(child) && child.length > MAX_COMPACT_ARRAY_ITEMS) {
      entries.push([key, child.slice(0, MAX_COMPACT_ARRAY_ITEMS).map(projectCompact)]);
      collectionMetadata.push([`${key}Count`, child.length]);
      collectionMetadata.push([`${key}Truncated`, true]);
    } else {
      entries.push([key, projectCompact(child)]);
    }
  }
  if (Array.isArray(value.items)) {
    collectionMetadata.push(['count', Math.min(value.items.length, MAX_COMPACT_ARRAY_ITEMS)]);
    collectionMetadata.push(['hasMore', Boolean(value.nextCursor)]);
    collectionMetadata.push(['truncated', Boolean(value.nextCursor)]);
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
    return JSON.stringify({
      items,
      count: items.length,
      totalCount: result.length,
      hasMore: false,
      truncated: result.length > items.length
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
