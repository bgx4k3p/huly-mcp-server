/**
 * Issue queries: list, get, search, my issues, history and project summary.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  DEFAULT_DETAIL_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  DONE_CATEGORY,
  fromMarkup,
  issueRollupFields,
  issueTimeFields,
  listEnvelope,
  LOST_CATEGORY,
  MAX_DETAIL_PAGE_SIZE,
  MAX_LABEL_FILTER_ISSUES,
  MAX_PAGE_SIZE,
  MILESTONE_STATUS_NAMES,
  nameMatch,
  normalizePageLimit,
  PRIORITY_MAP,
  PRIORITY_NAMES,
  strictGet,
  toHours,
  toIsoDate,
  withExtra
} from '../helpers.mjs';
import {
  boundedCollection,
  markdownPreview,
  normalizeIssueReadOptions,
  projectIssueFields
} from '../projection.mjs';
import { chunter, tags, tracker } from './sdk.mjs';

// Collaborator document reference stored in Issue.description once the body lives in the collaborator service.
const COLLABORATOR_REF = /^[a-f0-9]+-\w+-\d+$/;

/** Fixed field sets of the read tools that do not take a field projection. */
const SEARCH_ISSUE_FIELDS = new Set([
  'title', 'status', 'priority', 'type', 'assignee', 'component', 'milestone', 'parent', 'childCount',
  'dueDate', 'createdOn', 'modifiedOn', 'completedAt'
]);
const MY_ISSUE_FIELDS = new Set([...SEARCH_ISSUE_FIELDS, 'labels', 'estimation', 'reportedTime']);

const isSubIssue = issue => Boolean(issue.attachedTo) && issue.attachedToClass === tracker.class.Issue;
const unique = values => [...new Set(values)];

/**
 * Group documents by the issue they are attached to.
 * @param {Object[]} values - Documents with an `attachedTo` field
 * @returns {Map<string, Object[]>} Issue id → attached documents
 */
function groupByAttachedTo(values) {
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
function issueRow(issue, lookups, field) {
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
function applyIssueExpansions(entry, issue, expansions, lookups, projection, projectRelations) {
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

export class IssueReadMethods {
  /**
   * Load the lookup tables needed to build rows for a batch of issues. Only tables required by the
   * requested fields and expansions are fetched.
   * @param {Object} client - Huly SDK client
   * @param {Object[]} issues - Issue documents (may span projects)
   * @param {Object} options
   * @param {Set<string>} options.fields - Requested row fields
   * @param {Set<string>} [options.include] - Requested expansions
   * @param {Object} [options.statusData] - Status maps the caller already loaded
   * @param {Map} [options.milestoneMap] - Milestone id → output value the caller already loaded
   * @param {Map} [options.employeeMap] - Employee id → name the caller already loaded
   * @param {Object} [options.project] - The one project all issues belong to, when the caller knows it
   * @returns {Promise<Object>} identifierOf, statusMap, doneStatuses, taskTypeMap, employeeMap,
   *   componentMap, milestoneMap, labelsByIssue, parentMap
   */
  async _issueLookups(client, issues, {
    fields, include = new Set(), statusData, milestoneMap, employeeMap, project
  }) {
    const has = name => fields.has(name);
    const issueIds = issues.map(issue => issue._id);
    const spaceIds = unique(issues.map(issue => issue.space));
    const needsStatus = !statusData && (has('status') || has('completedAt') || include.has('children'));
    const needsType = has('type') || include.has('children');
    const needsMilestones = !milestoneMap && has('milestone');
    const parentIds = has('parent') ? unique(issues.filter(isSubIssue).map(issue => issue.attachedTo)) : [];

    const [loadedStatus, taskTypeMap, employeeData, components, milestones, labels, parentIssues] = await Promise.all([
      needsStatus ? this._buildStatusMaps(client) : Promise.resolve(statusData),
      needsType ? this._buildTaskTypeMap(client) : Promise.resolve(new Map()),
      has('assignee') && !employeeMap ? this._buildEmployeeMap(client) : Promise.resolve({ employeeMap: employeeMap ?? new Map() }),
      has('component') && spaceIds.length > 0
        ? client.findAll(tracker.class.Component, { space: { $in: spaceIds } })
        : Promise.resolve([]),
      needsMilestones && spaceIds.length > 0
        ? client.findAll(tracker.class.Milestone, { space: { $in: spaceIds } })
        : Promise.resolve([]),
      has('labels') && issueIds.length > 0
        ? client.findAll(tags.class.TagReference, { attachedTo: { $in: issueIds } })
        : Promise.resolve([]),
      parentIds.length > 0
        ? client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
        : Promise.resolve([])
    ]);

    // Identifiers for the issues' projects and their parents' projects, fetching only unknown ones.
    const identifiers = new Map(project ? [[project._id, project.identifier]] : []);
    const unknownSpaces = unique([...(project ? [] : spaceIds), ...parentIssues.map(parent => parent.space)])
      .filter(space => !identifiers.has(space));
    if (unknownSpaces.length > 0) {
      for (const found of await client.findAll(tracker.class.Project, { _id: { $in: unknownSpaces } })) {
        identifiers.set(found._id, found.identifier);
      }
    }

    const status = loadedStatus ?? { statusMap: new Map(), doneStatuses: new Set() };
    return {
      identifierOf: project
        ? () => project.identifier
        : issue => strictGet(identifiers, issue.space, 'Issue project'),
      statusMap: status.statusMap,
      doneStatuses: status.doneStatuses,
      taskTypeMap,
      employeeMap: employeeData.employeeMap,
      componentMap: new Map(components.map(component => [component._id, component.label])),
      milestoneMap: milestoneMap ?? new Map(milestones.map(milestone => [milestone._id, milestone.label])),
      labelsByIssue: this._groupLabelsByIssue(labels),
      parentMap: new Map(parentIssues.map(parent => [
        parent._id,
        `${identifiers.get(parent.space) ?? '?'}-${parent.number}`
      ]))
    };
  }

  /**
   * Load the expansions requested by a read projection for a batch of issues in one project.
   * @param {Object} client - Huly SDK client
   * @param {Object[]} issues - Issue documents
   * @param {Object} project - Project the issues belong to
   * @param {Object} projection - Normalized read options
   * @returns {Promise<Object>} commentsByIssue, timeReportsByIssue, childrenByIssue, relatedIssueMap,
   *   descriptionByIssue
   */
  async _issueExpansions(client, issues, project, projection) {
    const included = name => projection.include.has(name);
    const issueIds = issues.map(issue => issue._id);
    const [comments, timeReports, children, relatedIssueMap, descriptions] = await Promise.all([
      included('comments') || included('activity')
        ? client.findAll(chunter.class.ChatMessage, { attachedTo: { $in: issueIds } }, { sort: { createdOn: 1 } })
        : Promise.resolve([]),
      included('timeReports') || included('activity')
        ? client.findAll(tracker.class.TimeSpendReport, { attachedTo: { $in: issueIds } }, { sort: { date: -1 } })
        : Promise.resolve([]),
      included('children')
        ? client.findAll(tracker.class.Issue, {
          attachedTo: { $in: issueIds },
          attachedToClass: tracker.class.Issue,
          space: project._id
        })
        : Promise.resolve([]),
      included('relations') || included('blockedBy')
        ? this._buildRelatedIssueMap(client, issues)
        : Promise.resolve(new Map()),
      included('description')
        ? Promise.all(issues.map(async issue => [issue._id, await this._readIssueDescription(issue)]))
        : Promise.resolve([])
    ]);
    return {
      commentsByIssue: groupByAttachedTo(comments),
      timeReportsByIssue: groupByAttachedTo(timeReports),
      childrenByIssue: groupByAttachedTo(children),
      relatedIssueMap,
      descriptionByIssue: new Map(descriptions)
    };
  }

  /**
   * Issue description as markdown, read from the collaborator service when the body lives there.
   * @param {Object} issue - Issue document
   * @returns {Promise<string>}
   */
  async _readIssueDescription(issue) {
    const rawDesc = issue.description;
    return typeof rawDesc === 'string' && COLLABORATOR_REF.test(rawDesc)
      ? await this._readCollaboratorField(issue._id, issue._class, 'description', rawDesc)
      : fromMarkup(rawDesc);
  }

  /**
   * Estimation and reported time of an issue, in hours.
   * @param {Object} issue - Issue document
   * @returns {Object} Output of `issueTimeFields`
   */
  _issueTimeFields(issue) {
    return issueTimeFields(issue);
  }

  /**
   * Group tag references by the issue they are attached to.
   * @param {Object[]} allLabels - TagReference documents
   * @returns {Map<string, Object[]>} Issue id → tag references
   */
  _groupLabelsByIssue(allLabels) {
    const labelsByIssue = new Map();
    for (const label of allLabels) {
      if (!labelsByIssue.has(label.attachedTo)) {
        labelsByIssue.set(label.attachedTo, []);
      }
      labelsByIssue.get(label.attachedTo).push(label);
    }
    return labelsByIssue;
  }

  /**
   * Ids of all issues carrying a label.
   * @param {Object} client - Huly SDK client
   * @param {string} tagId - TagElement id
   * @returns {Promise<string[]>} Unique issue ids
   * @throws {Error} When the label is on more than MAX_LABEL_FILTER_ISSUES (5000) issues
   */
  async _findIssueIdsForLabel(client, tagId) {
    const references = await this._paginatedFindAll(
      client,
      tags.class.TagReference,
      { tag: tagId },
      {
        limit: MAX_LABEL_FILTER_ISSUES + 1,
        maxLimit: MAX_LABEL_FILTER_ISSUES + 1,
        cursorScope: { workspace: this.workspace, internal: 'label_references', tagId }
      }
    );
    if (references.nextCursor || references.items.length > MAX_LABEL_FILTER_ISSUES) {
      throw new Error(
        `Label matches more than ${MAX_LABEL_FILTER_ISSUES} issues; add another filter or use search`
      );
    }
    return [...new Set(references.items
      .map(reference => reference.attachedTo)
      .filter(Boolean))];
  }

  /**
   * Resolve every issue referenced by the relations and blockers of a batch of issues.
   * @param {Object} client - Huly SDK client
   * @param {Object[]} issues - Issue documents
   * @returns {Promise<Map<string, {id: string, title: string}>>} Related issue id → identifier and title
   */
  async _buildRelatedIssueMap(client, issues) {
    const allRelIds = [...new Set(issues.flatMap(issue => [
      ...(issue.relations || []).map(r => r._id),
      ...(issue.blockedBy || []).map(r => r._id)
    ]))];
    if (allRelIds.length === 0) return new Map();
    const relIssues = await client.findAll(tracker.class.Issue, { _id: { $in: allRelIds } });
    const relSpaceIds = [...new Set(relIssues.map(i => i.space))];
    const relProjects = await client.findAll(tracker.class.Project, { _id: { $in: relSpaceIds } });
    const relProjectMap = new Map(relProjects.map(p => [p._id, p.identifier]));
    return new Map(relIssues.map(i => [i._id, {
      id: `${relProjectMap.get(i.space) ?? '?'}-${i.number}`,
      title: i.title
    }]));
  }

  /**
   * Bounded relations and blockers of one issue, with count/truncated metadata for each.
   * @param {Object} issue - Issue document
   * @param {Map} relIssueMap - Result of `_buildRelatedIssueMap`
   * @param {number} limit - Maximum items per collection
   * @returns {Object} relations, relationsCount, relationsTruncated, blockedBy, blockedByCount, blockedByTruncated
   */
  _projectRelations(issue, relIssueMap, limit) {
    const relationRefs = issue.relations || [];
    const blockedByRefs = issue.blockedBy || [];
    const relationValues = relationRefs.map(r => relIssueMap.get(r._id)).filter(Boolean);
    const blockedByValues = blockedByRefs.map(r => relIssueMap.get(r._id)).filter(Boolean);
    const relations = boundedCollection(relationValues, limit);
    const blockedBy = boundedCollection(blockedByValues, limit);
    return {
      relations: relations.items,
      relationsCount: relations.count,
      relationsTruncated: relations.truncated,
      blockedBy: blockedBy.items,
      blockedByCount: blockedBy.count,
      blockedByTruncated: blockedBy.truncated
    };
  }

  /**
   * List issues in a project with optional filtering. Status, label and milestone match names case-insensitively.
   * @param {string} project - Project identifier
   * @param {string} [status] - Filter by status name
   * @param {string} [priority] - Filter by priority level
   * @param {string} [label] - Filter by label name
   * @param {string} [milestone] - Filter by milestone name
   * @param {number} [limit] - Page size; defaults to 50 (max 100), or 20 (max 50) when expansions are requested
   * @param {string} [cursor] - Pagination cursor from a previous page
   * @param {Object} [readOptions] - Field projection and expansions
   * @param {string[]} [readOptions.fields] - Row fields to return (defaults depend on responseMode)
   * @param {string[]} [readOptions.include] - Expansions to add (description, comments, activity, ...)
   * @param {string} [readOptions.responseMode='compact'] - compact or raw
   * @param {number} [readOptions.descriptionPreviewChars=500] - Description preview length (0 = full, or 100-5000)
   * @param {number} [readOptions.commentsLimit] - Maximum comments per issue
   * @param {number} [readOptions.activityLimit] - Maximum activity entries per issue
   * @param {number} [readOptions.timeReportsLimit] - Maximum time reports per issue
   * @param {number} [readOptions.relationsLimit] - Maximum relations/blockers per issue
   * @param {number} [readOptions.childrenLimit] - Maximum children per issue
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   * @throws {Error} When the priority, status, milestone or label is not found
   */
  async listIssues(project, status, priority, label, milestone, limit, cursor, readOptions = {}) {
    const projection = normalizeIssueReadOptions(readOptions, 'list');
    const detailedRead = projection.include.size > 0;
    limit = normalizePageLimit(
      limit,
      detailedRead ? DEFAULT_DETAIL_PAGE_SIZE : DEFAULT_PAGE_SIZE,
      detailedRead ? MAX_DETAIL_PAGE_SIZE : MAX_PAGE_SIZE
    );
    const client = await this._getClient();

    const proj = await this._findProject(client, project);

    const query = { space: proj._id };

    if (priority) {
      const priorityKey = priority.toLowerCase();
      if (!Object.hasOwn(PRIORITY_MAP, priorityKey)) {
        throw new Error(`Priority not found: ${priority}`);
      }
      query.priority = PRIORITY_MAP[priorityKey];
    }

    const needsStatus = Boolean(status) || projection.fields.has('status') ||
      projection.fields.has('completedAt') || projection.include.has('children');
    const needsMilestone = Boolean(milestone) || projection.fields.has('milestone');
    const [statusData, milestones] = await Promise.all([
      needsStatus
        ? this._buildStatusMaps(client)
        : Promise.resolve({ statuses: [], statusMap: new Map(), doneStatuses: new Set() }),
      needsMilestone
        ? client.findAll(tracker.class.Milestone, { space: proj._id })
        : Promise.resolve([])
    ]);
    const { statuses } = statusData;

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        throw new Error(`Status not found: ${status}`);
      }
    }

    const milestoneMap = new Map(milestones.map(m => [m._id, m.label]));

    if (milestone) {
      const found = milestones.find(m => nameMatch(m.label, milestone));
      if (!found) {
        throw new Error(`Milestone not found: ${milestone}`);
      }
      query.milestone = found._id;
    }

    // Resolve labels to issue IDs before pagination. Filtering after pagination
    // can return short/empty pages even when later matching issues exist.
    let labelIssueIds = null;
    if (label) {
      const tagElement = await this._findLabelByName(client, label);
      if (!tagElement) {
        throw new Error(`Label not found: ${label}`);
      }
      labelIssueIds = await this._findIssueIdsForLabel(client, tagElement._id);
      if (labelIssueIds.length === 0) {
        return listEnvelope([]);
      }
    }

    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_issues',
      project: project.toUpperCase(),
      status: status?.toLowerCase() ?? null,
      priority: priority?.toLowerCase() ?? null,
      label: label?.toLowerCase() ?? null,
      milestone: milestone?.toLowerCase() ?? null,
      fields: [...projection.fields].sort(),
      include: [...projection.include].sort(),
      limits: projection.limits,
      descriptionPreviewChars: projection.descriptionPreviewChars
    };
    const fetchResult = labelIssueIds
      ? await this._paginatedIssuesByIds(client, query, labelIssueIds, { limit, cursor, cursorScope })
      : await this._paginatedFindAll(client, tracker.class.Issue, query, { limit, cursor, cursorScope });
    const issues = fetchResult.items;
    const nextCursor = fetchResult.nextCursor;

    if (issues.length === 0) {
      return listEnvelope([]);
    }

    const [lookups, expansions] = await Promise.all([
      this._issueLookups(client, issues, {
        fields: projection.fields,
        include: projection.include,
        statusData,
        milestoneMap,
        project: proj
      }),
      this._issueExpansions(client, issues, proj, projection)
    ]);
    const field = name => projection.fields.has(name);
    const projectRelations = this._projectRelations.bind(this);
    const result = issues.map(issue => {
      const entry = issueRow(issue, lookups, field);
      applyIssueExpansions(entry, issue, expansions, lookups, projection, projectRelations);
      return projectIssueFields(withExtra(issue, entry), projection);
    });

    return listEnvelope(result, nextCursor);
  }

  /**
   * Get a specific issue by its identifier. The description is included unless `include` says otherwise.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {Object} [options] - Field projection and expansions
   * @param {string[]} [options.fields] - Row fields to return (defaults to all)
   * @param {string[]} [options.include] - Expansions to add (description, comments, activity, ...)
   * @param {string} [options.responseMode='compact'] - compact or raw
   * @param {number} [options.descriptionPreviewChars=0] - Description preview length (0 = full, or 100-5000)
   * @param {number} [options.commentsLimit] - Maximum comments per issue
   * @param {number} [options.activityLimit] - Maximum activity entries per issue
   * @param {number} [options.timeReportsLimit] - Maximum time reports per issue
   * @param {number} [options.relationsLimit] - Maximum relations/blockers per issue
   * @param {number} [options.childrenLimit] - Maximum children per issue
   * @returns {Promise<Object>}
   */
  async getIssue(issueId, options = {}) {
    const projection = normalizeIssueReadOptions(options, 'single');
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const field = name => projection.fields.has(name);
    // A single read returns the milestone with its id and status, not just its name.
    const milestone = field('milestone') && issue.milestone
      ? await client.findOne(tracker.class.Milestone, { _id: issue.milestone })
      : null;
    const milestoneMap = new Map(milestone ? [[milestone._id, {
      id: milestone._id,
      name: milestone.label,
      status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status')
    }]] : []);
    const [lookups, expansions] = await Promise.all([
      this._issueLookups(client, [issue], {
        fields: projection.fields,
        include: projection.include,
        milestoneMap,
        project
      }),
      this._issueExpansions(client, [issue], project, projection)
    ]);
    const result = issueRow(issue, lookups, field);
    applyIssueExpansions(result, issue, expansions, lookups, projection, this._projectRelations.bind(this));
    return projectIssueFields(withExtra(issue, result), projection);
  }

  /**
   * Search issues by text across all projects.
   * @param {string} query - Search text
   * @param {string} [projectIdent] - Optional project to limit search
   * @param {number} [limit=20] - Page size (max 100)
   * @param {string} [cursor] - Pagination cursor from a previous page
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   */
  async searchIssues(query, projectIdent, limit = 20, cursor) {
    const client = await this._getClient();
    limit = normalizePageLimit(limit, 20, MAX_PAGE_SIZE);

    const searchQuery = { $search: query };

    if (projectIdent) {
      const proj = await this._findProject(client, projectIdent);
      searchQuery.space = proj._id;
    }

    const fetchResult = await this._paginatedFindAll(client, tracker.class.Issue, searchQuery, {
      limit,
      cursor,
      cursorScope: {
        workspace: this.workspace,
        tool: 'search_issues',
        query: query.trim().toLowerCase(),
        project: projectIdent?.toUpperCase() ?? null
      }
    });
    const issues = fetchResult.items;
    const lookups = await this._issueLookups(client, issues, { fields: SEARCH_ISSUE_FIELDS });
    const field = name => SEARCH_ISSUE_FIELDS.has(name);
    const items = issues.map(issue => withExtra(issue, issueRow(issue, lookups, field)));
    return listEnvelope(items, fetchResult.nextCursor);
  }

  /**
   * Get issues assigned to the currently authenticated user.
   * @param {string} [projectIdent] - Optional project filter
   * @param {string} [status] - Optional status filter
   * @param {number} [limit=50] - Page size (max 100)
   * @param {string} [cursor] - Pagination cursor from a previous page
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   * @throws {Error} When the current user or the status cannot be found
   */
  async getMyIssues(projectIdent, status, limit = DEFAULT_PAGE_SIZE, cursor) {
    const client = await this._getClient();
    limit = normalizePageLimit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Find the current user's employee record via email channels or account matching
    const { employees, employeeMap } = await this._buildEmployeeMap(client);

    // Try matching by email in channels
    let me = employees.find(e => {
      const channels = e.channels || [];
      return channels.some(ch => ch.value?.toLowerCase() === this.email?.toLowerCase());
    });

    // Fallback: if only one employee, assume it's the current user
    if (!me && employees.length === 1) {
      me = employees[0];
    }

    // Fallback: try matching by PersonAccount email
    if (!me) {
      try {
        const accounts = await client.findAll('contact:class:PersonAccount', {});
        const myAccount = accounts.find(a => a.email?.toLowerCase() === this.email?.toLowerCase());
        if (myAccount) {
          me = employees.find(e => e._id === myAccount.person);
        }
      } catch (e) {
        throw new Error(`Failed to look up PersonAccount: ${e.message}. The PersonAccount class may not exist in this workspace.`);
      }
    }

    if (!me) {
      throw new Error('Could not find current user. Ensure HULY_EMAIL matches your workspace member email, or use HULY_TOKEN.');
    }

    const query = { assignee: me._id };

    if (projectIdent) {
      const proj = await this._findProject(client, projectIdent);
      query.space = proj._id;
    }

    // Resolve status name to ID for server-side filtering
    const { statuses, statusMap, doneStatuses } = await this._buildStatusMaps(client);

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        throw new Error(`Status not found: ${status}`);
      }
    }

    const fetchResult = await this._paginatedFindAll(client, tracker.class.Issue, query, {
      limit,
      cursor,
      cursorScope: {
        workspace: this.workspace,
        tool: 'get_my_issues',
        project: projectIdent?.toUpperCase() ?? null,
        status: status?.toLowerCase() ?? null,
        assignee: me._id
      }
    });
    const issues = fetchResult.items;
    const lookups = await this._issueLookups(client, issues, {
      fields: MY_ISSUE_FIELDS,
      statusData: { statusMap, doneStatuses },
      employeeMap
    });
    const field = name => MY_ISSUE_FIELDS.has(name);
    const result = issues.map(issue => withExtra(issue, issueRow(issue, lookups, field)));

    return listEnvelope(result, fetchResult.nextCursor);
  }

  /**
   * Get a project summary with issue counts by status, priority, and overdue info.
   * @param {string} projectIdent - Project identifier
   * @returns {Promise<Object>}
   */
  async summarizeProject(projectIdent) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    // Only the fields the summary counts; a project can hold thousands of issues.
    const [issues, { statuses, statusMap }, milestones] = await Promise.all([
      client.findAll(tracker.class.Issue, { space: project._id }, {
        projection: {
          number: 1, title: 1, status: 1, priority: 1, dueDate: 1, assignee: 1, estimation: 1, reportedTime: 1
        }
      }),
      this._buildStatusMaps(client),
      client.findAll(tracker.class.Milestone, { space: project._id })
    ]);
    const closedStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY || s.category === LOST_CATEGORY)
      .map(s => s._id));

    const now = Date.now();
    const byStatus = {};
    const byPriority = {};
    const overdueList = [];
    let unassigned = 0;
    let totalEstimation = 0;
    let totalReported = 0;
    for (const issue of issues) {
      const statusName = strictGet(statusMap, issue.status, 'Status');
      byStatus[statusName] = (byStatus[statusName] || 0) + 1;
      const priorityName = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
      byPriority[priorityName] = (byPriority[priorityName] || 0) + 1;
      if (issue.dueDate && issue.dueDate < now && !closedStatuses.has(issue.status)) {
        overdueList.push({
          id: `${project.identifier}-${issue.number}`,
          title: issue.title,
          dueDate: new Date(issue.dueDate).toISOString().split('T')[0],
          priority: priorityName
        });
      }
      if (!issue.assignee) unassigned++;
      totalEstimation += toHours(issue.estimation);
      totalReported += toHours(issue.reportedTime);
    }

    return {
      project: {
        identifier: project.identifier,
        name: project.name || project.identifier
      },
      totalIssues: issues.length,
      byStatus,
      byPriority,
      overdue: {
        count: overdueList.length,
        issues: overdueList
      },
      unassigned,
      milestones: milestones.map(m => ({
        name: m.label,
        status: strictGet(MILESTONE_STATUS_NAMES, m.status, 'Milestone status'),
        targetDate: m.targetDate ? new Date(m.targetDate).toISOString().split('T')[0] : null
      })),
      timeTracking: {
        totalEstimatedHours: totalEstimation,
        totalReportedHours: totalReported
      }
    };
  }

  /**
   * Get an issue's comment and time-log activity timeline, sub-issues and labels.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<Object>}
   */
  async getIssueHistory(issueId) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // Get comments as activity
    const comments = await client.findAll(chunter.class.ChatMessage, {
      attachedTo: issue._id
    }, { sort: { createdOn: 1 } });

    // Get time reports
    const timeReports = await client.findAll(tracker.class.TimeSpendReport, {
      attachedTo: issue._id
    }, { sort: { date: 1 } });

    // Get sub-issues
    const subIssues = await client.findAll(tracker.class.Issue, {
      attachedTo: issue._id,
      attachedToClass: tracker.class.Issue
    });

    // Get labels
    const issueLabels = await client.findAll(tags.class.TagReference, {
      attachedTo: issue._id
    });

    // Build activity timeline
    const activity = [];

    for (const c of comments) {
      activity.push({
        type: 'comment',
        text: fromMarkup(c.message),
        date: c.createdOn,
        dateFormatted: c.createdOn ? new Date(c.createdOn).toISOString() : null
      });
    }

    for (const tr of timeReports) {
      activity.push({
        type: 'time_logged',
        hours: tr.value,
        description: fromMarkup(tr.description),
        date: tr.date,
        dateFormatted: toIsoDate(tr.date)
      });
    }

    // Sort by date
    activity.sort((a, b) => (a.date || 0) - (b.date || 0));

    return {
      issueId,
      title: issue.title,
      createdOn: issue.createdOn ? new Date(issue.createdOn).toISOString() : null,
      modifiedOn: issue.modifiedOn ? new Date(issue.modifiedOn).toISOString() : null,
      subIssues: subIssues.map(si => ({
        id: `${project.identifier}-${si.number}`,
        title: si.title
      })),
      labels: issueLabels.map(l => l.title),
      activity
    };
  }
}
