/**
 * Issue field projection for read tools: which base fields and expansions a list or single-issue
 * read returns, nested collection limits, and Markdown description previews.
 */
export const ISSUE_BASE_FIELDS = Object.freeze([
  'id', 'title', 'status', 'priority', 'type', 'assignee', 'component',
  'labels', 'parent', 'childCount', 'milestone', 'dueDate', 'estimation',
  'reportedTime', 'estimationTotal', 'reportedTimeTotal',
  'createdOn', 'modifiedOn', 'completedAt'
]);

export const ISSUE_INCLUDE_FIELDS = Object.freeze([
  'description', 'comments', 'activity', 'timeReports', 'relations', 'blockedBy', 'children'
]);

export const COMPACT_LIST_FIELDS = Object.freeze([
  'id', 'title', 'status', 'priority', 'type', 'assignee', 'labels',
  'milestone', 'modifiedOn'
]);

const DEFAULT_NESTED_LIMIT = 20;
const MAX_NESTED_LIMIT = 100;
const DEFAULT_LIST_PREVIEW_CHARS = 500;

/**
 * Validate an optional array of strings against an allowed list.
 * @param {string[]|undefined} value
 * @param {readonly string[]} allowed
 * @param {string} name - Parameter name used in error messages
 * @returns {Set<string>|null} null when value is undefined
 * @throws {Error} When value is not an array or contains an unsupported entry
 */
function stringSet(value, allowed, name) {
  if (value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      throw new Error(`Unsupported ${name} value: ${String(item)}`);
    }
    result.add(item);
  }
  return result;
}

/**
 * Parse an optional include list into a Set of allowed values; an omitted list is an empty Set.
 * @param {string[]|undefined} value
 * @param {readonly string[]} allowed
 * @param {string} [name='include'] - Parameter name used in error messages
 * @returns {Set<string>}
 * @throws {Error} When value is not an array or contains an unsupported entry
 */
export function normalizeIncludeSet(value, allowed, name = 'include') {
  return stringSet(value, allowed, name) ?? new Set();
}

/**
 * Validate a nested collection limit, using the fallback when none is given.
 * @param {number|null|undefined} value
 * @param {string} name - Parameter name used in error messages
 * @param {number} [fallback=DEFAULT_NESTED_LIMIT] - Limit used when value is null or undefined
 * @returns {number}
 * @throws {Error} When the limit is not an integer from 1 to MAX_NESTED_LIMIT
 */
function nestedLimit(value, name, fallback = DEFAULT_NESTED_LIMIT) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NESTED_LIMIT) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_NESTED_LIMIT}`);
  }
  return limit;
}

/**
 * Normalize issue read options into a projection. Defaults: compact lists return
 * COMPACT_LIST_FIELDS, otherwise ISSUE_BASE_FIELDS; 'id' is always included; single reads
 * include the description; lists preview descriptions at 500 characters, single reads do not.
 * @param {Object} [options]
 * @param {string[]} [options.fields] - Base fields to return
 * @param {string[]} [options.include] - Expansions to return
 * @param {string} [options.responseMode='compact'] - 'compact' or 'raw'
 * @param {number} [options.descriptionPreviewChars] - 0 (no preview) or 100 to 5000
 * @param {number} [options.commentsLimit=20] - 1 to 100, as are the other limits
 * @param {number} [options.activityLimit=20]
 * @param {number} [options.timeReportsLimit=20]
 * @param {number} [options.relationsLimit=20]
 * @param {number} [options.childrenLimit=20]
 * @param {string} [kind='list'] - 'list' or 'single'
 * @returns {Object} {fields, include, responseMode, explicitFields, explicitInclude,
 *   emitExpansionMetadata, descriptionPreviewChars, limits}
 * @throws {Error} When a field, include entry, preview length or limit is invalid
 */
export function normalizeIssueReadOptions(options = {}, kind = 'list') {
  const explicitFields = stringSet(options.fields, ISSUE_BASE_FIELDS, 'fields');
  const explicitInclude = stringSet(options.include, ISSUE_INCLUDE_FIELDS, 'include');
  const responseMode = options.responseMode ?? 'compact';
  const fields = explicitFields ?? new Set(
    kind === 'list' && responseMode === 'compact'
      ? COMPACT_LIST_FIELDS
      : ISSUE_BASE_FIELDS
  );
  fields.add('id');

  let include;
  if (explicitInclude) include = explicitInclude;
  else include = new Set(kind === 'single' ? ['description'] : []);

  let previewChars = options.descriptionPreviewChars;
  if (previewChars === undefined) previewChars = kind === 'list' ? DEFAULT_LIST_PREVIEW_CHARS : 0;
  if (!Number.isInteger(previewChars) || previewChars < 0 || previewChars > 5000 ||
      (previewChars > 0 && previewChars < 100)) {
    throw new Error('description_preview_chars must be 0 or an integer from 100 to 5000');
  }

  return {
    fields,
    include,
    responseMode,
    explicitFields: Boolean(explicitFields),
    explicitInclude: Boolean(explicitInclude),
    emitExpansionMetadata: true,
    descriptionPreviewChars: previewChars,
    limits: {
      comments: nestedLimit(options.commentsLimit, 'comments_limit'),
      activity: nestedLimit(options.activityLimit, 'activity_limit'),
      timeReports: nestedLimit(options.timeReportsLimit, 'time_reports_limit'),
      relations: nestedLimit(options.relationsLimit, 'relations_limit'),
      children: nestedLimit(options.childrenLimit, 'children_limit')
    }
  };
}

/**
 * Keep the projected base fields, plus any present expansion fields and their Count/Truncated
 * metadata and descriptionTruncated. Raw mode without explicit fields returns the value unchanged.
 * @param {Object} value - Formatted issue
 * @param {Object} projection - Result of normalizeIssueReadOptions
 * @returns {Object}
 */
export function projectIssueFields(value, projection) {
  if (!projection.explicitFields && projection.responseMode === 'raw') return value;
  const entries = [];
  for (const key of projection.fields) {
    if (Object.hasOwn(value, key)) entries.push([key, value[key]]);
  }
  for (const key of ISSUE_INCLUDE_FIELDS) {
    if (Object.hasOwn(value, key)) entries.push([key, value[key]]);
    const countKey = `${key}Count`;
    const truncatedKey = `${key}Truncated`;
    if (Object.hasOwn(value, countKey)) entries.push([countKey, value[countKey]]);
    if (Object.hasOwn(value, truncatedKey)) entries.push([truncatedKey, value[truncatedKey]]);
  }
  if (Object.hasOwn(value, 'descriptionTruncated')) {
    entries.push(['descriptionTruncated', value.descriptionTruncated]);
  }
  return Object.fromEntries(entries);
}

/**
 * Cut a collection to a limit, reporting the full count and whether items were dropped.
 * @param {Array} items
 * @param {number} limit
 * @returns {{items: Array, count: number, truncated: boolean}}
 */
export function boundedCollection(items, limit) {
  const bounded = items.slice(0, limit);
  return {
    items: bounded,
    count: items.length,
    truncated: items.length > bounded.length
  };
}

/**
 * Deterministic Markdown preview that backs up to a paragraph, line or word boundary (no earlier
 * than 60% of the maximum) and avoids ending inside inline code or a link label.
 * @param {string} text - Markdown text
 * @param {number} maximum - Maximum length before the ellipsis; 0 disables truncation
 * @returns {{text: string, truncated: boolean}} Truncated text ends with an ellipsis
 */
export function markdownPreview(text, maximum) {
  if (!maximum || typeof text !== 'string' || text.length <= maximum) {
    return { text, truncated: false };
  }
  const minimum = Math.floor(maximum * 0.6);
  let end = text.lastIndexOf('\n\n', maximum);
  if (end < minimum) end = text.lastIndexOf('\n', maximum);
  if (end < minimum) end = text.lastIndexOf(' ', maximum);
  if (end < minimum) end = maximum;
  let preview = text.slice(0, end).trimEnd();

  // Avoid leaving an unmatched inline-code delimiter or link opener.
  if ((preview.match(/`/g)?.length ?? 0) % 2 === 1) {
    const safe = preview.lastIndexOf('`');
    if (safe >= minimum) preview = preview.slice(0, safe).trimEnd();
  }
  const openBracket = preview.lastIndexOf('[');
  const closeBracket = preview.lastIndexOf(']');
  if (openBracket > closeBracket && openBracket >= minimum) {
    preview = preview.slice(0, openBracket).trimEnd();
  }
  return { text: `${preview}…`, truncated: true };
}
