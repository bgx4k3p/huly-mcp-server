/**
 * Pure builders for issue output rows and their expansions, shared by the issue read methods.
 */
import {
  fromMarkup,
  issueRollupFields,
  issueTimeFields,
  PRIORITY_NAMES,
  strictGet,
  toIsoDate
} from '../helpers.mjs';
import { boundedCollection, markdownPreview } from '../projection.mjs';
import { tracker } from './sdk.mjs';

// Collaborator document reference stored in Issue.description once the body lives in the collaborator service.
export const COLLABORATOR_REF = /^[a-f0-9]+-\w+-\d+$/;

/** Fixed field sets of the read tools that do not take a field projection. */
export const SEARCH_ISSUE_FIELDS = new Set([
  'title', 'status', 'priority', 'type', 'assignee', 'component', 'milestone', 'parent', 'childCount',
  'dueDate', 'createdOn', 'modifiedOn', 'completedAt'
]);
export const MY_ISSUE_FIELDS = new Set([...SEARCH_ISSUE_FIELDS, 'labels', 'estimation', 'reportedTime']);

export const isSubIssue = issue => Boolean(issue.attachedTo) && issue.attachedToClass === tracker.class.Issue;
export const unique = values => [...new Set(values)];

/**
 * Group documents by the issue they are attached to.
 * @param {Object[]} values - Documents with an `attachedTo` field
 * @returns {Map<string, Object[]>} Issue id → attached documents
 */
export function groupByAttachedTo(values) {
  const grouped = new Map();
  for (const value of values) {
    if (!grouped.has(value.attachedTo)) grouped.set(value.attachedTo, []);
    grouped.get(value.attachedTo).push(value);
  }
  return grouped;
}

/**
 * Store a bounded collection on an issue entry, adding count/truncated metadata when the projection asks
 * for it or the collection was cut.
 * @param {Object} entry - Row being built
 * @param {string} key - Property name for the collection
 * @param {Object[]} values - Full collection
 * @param {number} maximum - Maximum items to keep
 * @param {Object} projection - Normalized read options
 */
function assignBounded(entry, key, values, maximum, projection) {
  const bounded = boundedCollection(values, maximum);
  entry[key] = bounded.items;
  if (projection.emitExpansionMetadata || bounded.truncated) {
    entry[`${key}Count`] = bounded.count;
    entry[`${key}Truncated`] = bounded.truncated;
  }
}

/**
 * Build one issue's output row from loaded lookups, including only the requested fields.
 * @param {Object} issue - Issue document
 * @param {Object} lookups - Result of `_issueLookups`
 * @param {(name: string) => boolean} field - Whether a field was requested
 * @returns {Object}
 */
export function issueRow(issue, lookups, field) {
  const row = { id: `${lookups.identifierOf(issue)}-${issue.number}` };
  if (field('title')) row.title = issue.title;
  if (field('status')) row.status = strictGet(lookups.statusMap, issue.status, 'Status');
  if (field('priority')) row.priority = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
  if (field('type')) row.type = strictGet(lookups.taskTypeMap, issue.kind, 'Task type');
  if (field('assignee')) row.assignee = issue.assignee ? lookups.employeeMap.get(issue.assignee) ?? null : null;
  if (field('component')) row.component = issue.component ? lookups.componentMap.get(issue.component) ?? null : null;
  if (field('labels')) row.labels = (lookups.labelsByIssue.get(issue._id) || []).map(item => item.title);
  if (field('parent')) row.parent = isSubIssue(issue) ? lookups.parentMap.get(issue.attachedTo) ?? null : null;
  if (field('childCount')) row.childCount = issue.subIssues || 0;
  if (field('milestone')) row.milestone = issue.milestone ? lookups.milestoneMap.get(issue.milestone) ?? null : null;
  if (field('dueDate')) row.dueDate = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
  const times = issueTimeFields(issue);
  if (field('estimation')) row.estimation = times.estimation;
  if (field('reportedTime')) row.reportedTime = times.reportedTime;
  // Only an issue with children carries a rollup, so a leaf costs no bytes.
  const rollup = issueRollupFields(issue);
  if (rollup) {
    if (field('estimationTotal')) row.estimationTotal = rollup.estimationTotal;
    if (field('reportedTimeTotal')) row.reportedTimeTotal = rollup.reportedTimeTotal;
  }
  if (field('createdOn')) row.createdOn = issue.createdOn;
  if (field('modifiedOn')) row.modifiedOn = issue.modifiedOn;
  if (field('completedAt')) row.completedAt = lookups.doneStatuses.has(issue.status) ? issue.modifiedOn : null;
  return row;
}

/**
 * Add the requested expansions (description, comments, activity, time reports, relations, children) to
 * an issue entry.
 * @param {Object} entry - Row being built
 * @param {Object} issue - Issue document
 * @param {Object} expansions - Result of `_issueExpansions`
 * @param {Object} lookups - Result of `_issueLookups`
 * @param {Object} projection - Normalized read options
 * @param {Function} projectRelations - Relation projector bound to the client
 */
export function applyIssueExpansions(entry, issue, expansions, lookups, projection, projectRelations) {
  const included = name => projection.include.has(name);
  const comments = expansions.commentsByIssue.get(issue._id) || [];
  const timeReports = expansions.timeReportsByIssue.get(issue._id) || [];
  if (included('description')) {
    const preview = markdownPreview(expansions.descriptionByIssue.get(issue._id) ?? '', projection.descriptionPreviewChars);
    entry.description = preview.text;
    if (projection.emitExpansionMetadata || preview.truncated) {
      entry.descriptionTruncated = preview.truncated;
    }
  }
  if (included('comments')) {
    assignBounded(entry, 'comments', comments.map(comment => ({
      id: comment._id,
      text: fromMarkup(comment.message),
      createdBy: comment.createdBy || null,
      createdOn: comment.createdOn,
      modifiedOn: comment.modifiedOn
    })), projection.limits.comments, projection);
  }
  if (included('activity')) {
    const activity = [
      ...comments.map(comment => ({
        type: 'comment',
        text: fromMarkup(comment.message),
        date: comment.createdOn,
        dateFormatted: comment.createdOn ? new Date(comment.createdOn).toISOString() : null
      })),
      ...timeReports.map(report => ({
        type: 'time_logged',
        hours: report.value,
        description: fromMarkup(report.description),
        date: report.date,
        dateFormatted: toIsoDate(report.date)
      }))
    ].sort((a, b) => (a.date || 0) - (b.date || 0));
    assignBounded(entry, 'activity', activity, projection.limits.activity, projection);
  }
  if (included('timeReports')) {
    assignBounded(entry, 'timeReports', timeReports.map(report => ({
      id: report._id,
      hours: report.value,
      description: fromMarkup(report.description),
      date: toIsoDate(report.date)
    })), projection.limits.timeReports, projection);
  }
  if (included('relations') || included('blockedBy')) {
    const relationData = projectRelations(issue, expansions.relatedIssueMap, projection.limits.relations);
    for (const key of ['relations', 'blockedBy']) {
      if (!included(key)) continue;
      entry[key] = relationData[key];
      if (projection.emitExpansionMetadata || relationData[`${key}Truncated`]) {
        entry[`${key}Count`] = relationData[`${key}Count`];
        entry[`${key}Truncated`] = relationData[`${key}Truncated`];
      }
    }
  }
  if (included('children')) {
    const identifier = lookups.identifierOf(issue);
    assignBounded(entry, 'children', (expansions.childrenByIssue.get(issue._id) || []).map(child => ({
      id: `${identifier}-${child.number}`,
      title: child.title,
      status: strictGet(lookups.statusMap, child.status, 'Status'),
      type: strictGet(lookups.taskTypeMap, child.kind, 'Task type')
    })), projection.limits.children, projection);
  }
}
