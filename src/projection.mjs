export const ISSUE_BASE_FIELDS = Object.freeze([
  'id', 'title', 'status', 'priority', 'type', 'assignee', 'component',
  'labels', 'parent', 'childCount', 'milestone', 'dueDate', 'estimation',
  'reportedTime', 'createdOn', 'modifiedOn', 'completedAt'
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

function nestedLimit(value, name, fallback = DEFAULT_NESTED_LIMIT) {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_NESTED_LIMIT) {
    throw new Error(`${name} must be an integer from 1 to ${MAX_NESTED_LIMIT}`);
  }
  return limit;
}

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

export function boundedCollection(items, limit) {
  const bounded = items.slice(0, limit);
  return {
    items: bounded,
    count: items.length,
    truncated: items.length > bounded.length
  };
}

/** Deterministic Markdown preview that backs up to a structural/word boundary. */
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
