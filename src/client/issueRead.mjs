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

export class IssueReadMethods {
  _issueTimeFields(issue) {
    return issueTimeFields(issue);
  }

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
   * List issues in a project with optional filtering.
   * @param {string} project - Project identifier
   * @param {string} [status] - Filter by status name
   * @param {string} [priority] - Filter by priority level
   * @param {string} [label] - Filter by label name
   * @param {string} [milestone] - Filter by milestone name
   * @param {number} [limit=500] - Maximum number of issues
   * @returns {Promise<Object[]>}
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

    const proj = await client.findOne(tracker.class.Project, {
      identifier: project.toUpperCase()
    });

    if (!proj) {
      throw new Error(`Project not found: ${project}`);
    }

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
    const { statuses, statusMap, doneStatuses } = statusData;

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

    // Fetch only lookup tables required by the requested projection.
    const issueIds = issues.map(i => i._id);
    const needsType = projection.fields.has('type') || projection.include.has('children');
    const [allLabels, taskTypeMap, components, employeeData] = await Promise.all([
      projection.fields.has('labels')
        ? client.findAll(tags.class.TagReference, { attachedTo: { $in: issueIds } })
        : Promise.resolve([]),
      needsType ? this._buildTaskTypeMap(client) : Promise.resolve(new Map()),
      projection.fields.has('component')
        ? client.findAll(tracker.class.Component, { space: proj._id })
        : Promise.resolve([]),
      projection.fields.has('assignee')
        ? this._buildEmployeeMap(client)
        : Promise.resolve({ employeeMap: new Map() })
    ]);
    const labelsByIssue = this._groupLabelsByIssue(allLabels);
    const componentMap = new Map(components.map(c => [c._id, c.label]));
    const { employeeMap } = employeeData;

    // Parent issue map for hierarchy (batch lookup)
    const parentIds = projection.fields.has('parent')
      ? [...new Set(issues
        .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
        .map(i => i.attachedTo))]
      : [];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentSpaceIds = [...new Set(parentIssues.map(p => p.space))];
    const parentProjects = parentSpaceIds.length > 0
      ? await client.findAll(tracker.class.Project, { _id: { $in: parentSpaceIds } })
      : [];
    const parentProjMap = new Map(parentProjects.map(p => [p._id, p.identifier]));
    const parentMap = new Map(parentIssues.map(p => [
      p._id,
      `${parentProjMap.get(p.space) ?? '?'}-${p.number}`
    ]));

    const groupByAttachedTo = values => {
      const grouped = new Map();
      for (const value of values) {
        if (!grouped.has(value.attachedTo)) grouped.set(value.attachedTo, []);
        grouped.get(value.attachedTo).push(value);
      }
      return grouped;
    };
    const [allComments, allTimeReports, allChildren, relatedIssueMap, descriptions] = await Promise.all([
      projection.include.has('comments') || projection.include.has('activity')
        ? client.findAll(chunter.class.ChatMessage, { attachedTo: { $in: issueIds } }, { sort: { createdOn: 1 } })
        : Promise.resolve([]),
      projection.include.has('timeReports') || projection.include.has('activity')
        ? client.findAll(tracker.class.TimeSpendReport, { attachedTo: { $in: issueIds } }, { sort: { date: -1 } })
        : Promise.resolve([]),
      projection.include.has('children')
        ? client.findAll(tracker.class.Issue, {
          attachedTo: { $in: issueIds },
          attachedToClass: tracker.class.Issue,
          space: proj._id
        })
        : Promise.resolve([]),
      projection.include.has('relations') || projection.include.has('blockedBy')
        ? this._buildRelatedIssueMap(client, issues)
        : Promise.resolve(new Map()),
      projection.include.has('description')
        ? Promise.all(issues.map(async issue => {
          const rawDesc = issue.description;
          const text = typeof rawDesc === 'string' && /^[a-f0-9]+-\w+-\d+$/.test(rawDesc)
            ? await this._readCollaboratorField(issue._id, issue._class, 'description', rawDesc)
            : fromMarkup(rawDesc);
          return [issue._id, text];
        }))
        : Promise.resolve([])
    ]);
    const commentsByIssue = groupByAttachedTo(allComments);
    const timeReportsByIssue = groupByAttachedTo(allTimeReports);
    const childrenByIssue = groupByAttachedTo(allChildren);
    const descriptionByIssue = new Map(descriptions);

    const assignBounded = (entry, key, values, maximum) => {
      const bounded = boundedCollection(values, maximum);
      entry[key] = bounded.items;
      if (projection.emitExpansionMetadata || bounded.truncated) {
        entry[`${key}Count`] = bounded.count;
        entry[`${key}Truncated`] = bounded.truncated;
      }
    };

    const field = name => projection.fields.has(name);
    const included = name => projection.include.has(name);

    const result = issues.map(issue => {
      const entry = { id: `${proj.identifier}-${issue.number}` };
      if (field('title')) entry.title = issue.title;
      if (field('status')) entry.status = strictGet(statusMap, issue.status, 'Status');
      if (field('priority')) entry.priority = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
      if (field('type')) entry.type = strictGet(taskTypeMap, issue.kind, 'Task type');
      if (field('assignee')) entry.assignee = issue.assignee ? employeeMap.get(issue.assignee) ?? null : null;
      if (field('component')) entry.component = issue.component ? componentMap.get(issue.component) ?? null : null;
      if (field('labels')) entry.labels = (labelsByIssue.get(issue._id) || []).map(item => item.title);
      if (field('parent')) {
        entry.parent = issue.attachedTo && issue.attachedToClass === tracker.class.Issue
          ? parentMap.get(issue.attachedTo) ?? null
          : null;
      }
      if (field('childCount')) entry.childCount = issue.subIssues || 0;
      if (field('milestone')) entry.milestone = issue.milestone ? milestoneMap.get(issue.milestone) ?? null : null;
      if (field('dueDate')) entry.dueDate = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
      const timeFields = this._issueTimeFields(issue);
      if (field('estimation')) entry.estimation = timeFields.estimation;
      if (field('reportedTime')) entry.reportedTime = timeFields.reportedTime;
      // Only an issue with children carries a rollup, so a leaf costs no bytes.
      const rollup = issueRollupFields(issue);
      if (rollup) {
        if (field('estimationTotal')) entry.estimationTotal = rollup.estimationTotal;
        if (field('reportedTimeTotal')) entry.reportedTimeTotal = rollup.reportedTimeTotal;
      }
      if (field('createdOn')) entry.createdOn = issue.createdOn;
      if (field('modifiedOn')) entry.modifiedOn = issue.modifiedOn;
      if (field('completedAt')) entry.completedAt = doneStatuses.has(issue.status) ? issue.modifiedOn : null;

      if (included('description')) {
        const preview = markdownPreview(descriptionByIssue.get(issue._id) ?? '', projection.descriptionPreviewChars);
        entry.description = preview.text;
        if (projection.emitExpansionMetadata || preview.truncated) {
          entry.descriptionTruncated = preview.truncated;
        }
      }
      if (included('comments')) {
        const comments = (commentsByIssue.get(issue._id) || []).map(comment => ({
          id: comment._id,
          text: fromMarkup(comment.message),
          createdBy: comment.createdBy || null,
          createdOn: comment.createdOn,
          modifiedOn: comment.modifiedOn
        }));
        assignBounded(entry, 'comments', comments, projection.limits.comments);
      }
      if (included('activity')) {
        const activity = [
          ...(commentsByIssue.get(issue._id) || []).map(comment => ({
            type: 'comment',
            text: fromMarkup(comment.message),
            date: comment.createdOn,
            dateFormatted: comment.createdOn ? new Date(comment.createdOn).toISOString() : null
          })),
          ...(timeReportsByIssue.get(issue._id) || []).map(report => ({
            type: 'time_logged',
            hours: report.value,
            description: fromMarkup(report.description),
            date: report.date,
            dateFormatted: toIsoDate(report.date)
          }))
        ].sort((a, b) => (a.date || 0) - (b.date || 0));
        assignBounded(entry, 'activity', activity, projection.limits.activity);
      }
      if (included('timeReports')) {
        const reports = (timeReportsByIssue.get(issue._id) || []).map(report => ({
          id: report._id,
          hours: report.value,
          description: fromMarkup(report.description),
          date: toIsoDate(report.date)
        }));
        assignBounded(entry, 'timeReports', reports, projection.limits.timeReports);
      }
      if (included('relations') || included('blockedBy')) {
        const relationData = this._projectRelations(issue, relatedIssueMap, projection.limits.relations);
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
        const children = (childrenByIssue.get(issue._id) || []).map(child => ({
          id: `${proj.identifier}-${child.number}`,
          title: child.title,
          status: strictGet(statusMap, child.status, 'Status'),
          type: strictGet(taskTypeMap, child.kind, 'Task type')
        }));
        assignBounded(entry, 'children', children, projection.limits.children);
      }

      return projectIssueFields(withExtra(issue, entry), projection);
    });

    return listEnvelope(result, nextCursor);
  }

  /**
   * Get a specific issue by its identifier with full details.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<Object>}
   */
  async getIssue(issueId, options = {}) {
    const projection = normalizeIssueReadOptions(options, 'single');
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const field = name => projection.fields.has(name);
    const included = name => projection.include.has(name);
    const needsStatus = field('status') || field('completedAt') || included('children');
    const needsType = field('type') || included('children');
    const [statusData, taskTypeMap, employeeData, components, issueLabels] = await Promise.all([
      needsStatus
        ? this._buildStatusMaps(client)
        : Promise.resolve({ statusMap: new Map(), doneStatuses: new Set() }),
      needsType ? this._buildTaskTypeMap(client) : Promise.resolve(new Map()),
      field('assignee') ? this._buildEmployeeMap(client) : Promise.resolve({ employeeMap: new Map() }),
      field('component')
        ? client.findAll(tracker.class.Component, { space: project._id })
        : Promise.resolve([]),
      field('labels')
        ? client.findAll(tags.class.TagReference, { attachedTo: issue._id })
        : Promise.resolve([])
    ]);
    const { statusMap, doneStatuses } = statusData;
    const { employeeMap } = employeeData;
    const componentMap = new Map(components.map(c => [c._id, c.label]));

    const descriptionPromise = included('description')
      ? (async () => {
        const rawDesc = issue.description;
        return typeof rawDesc === 'string' && /^[a-f0-9]+-\w+-\d+$/.test(rawDesc)
          ? this._readCollaboratorField(issue._id, issue._class, 'description', rawDesc)
          : fromMarkup(rawDesc);
      })()
      : Promise.resolve(undefined);
    const parentPromise = field('parent') && issue.attachedTo && issue.attachedToClass === tracker.class.Issue
      ? (async () => {
        const parentIssue = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
        if (!parentIssue) return null;
        const parentProject = await client.findOne(tracker.class.Project, { _id: parentIssue.space });
        return parentProject ? `${parentProject.identifier}-${parentIssue.number}` : null;
      })()
      : Promise.resolve(null);
    const milestonePromise = field('milestone') && issue.milestone
      ? client.findOne(tracker.class.Milestone, { _id: issue.milestone })
      : Promise.resolve(null);
    const [descriptionContent, parentId, milestone, comments, timeReports, children, relatedIssueMap] = await Promise.all([
      descriptionPromise,
      parentPromise,
      milestonePromise,
      included('comments') || included('activity')
        ? client.findAll(chunter.class.ChatMessage, { attachedTo: issue._id }, { sort: { createdOn: 1 } })
        : Promise.resolve([]),
      included('timeReports') || included('activity')
        ? client.findAll(tracker.class.TimeSpendReport, { attachedTo: issue._id }, { sort: { date: -1 } })
        : Promise.resolve([]),
      included('children')
        ? client.findAll(tracker.class.Issue, {
          space: project._id,
          attachedTo: issue._id,
          attachedToClass: tracker.class.Issue
        })
        : Promise.resolve([]),
      included('relations') || included('blockedBy')
        ? this._buildRelatedIssueMap(client, [issue])
        : Promise.resolve(new Map())
    ]);

    const result = { id: `${project.identifier}-${issue.number}` };
    if (field('title')) result.title = issue.title;
    if (field('status')) result.status = strictGet(statusMap, issue.status, 'Status');
    if (field('priority')) result.priority = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
    if (field('type')) result.type = strictGet(taskTypeMap, issue.kind, 'Task type');
    if (field('assignee')) result.assignee = issue.assignee ? employeeMap.get(issue.assignee) ?? null : null;
    if (field('component')) result.component = issue.component ? componentMap.get(issue.component) ?? null : null;
    if (field('labels')) result.labels = issueLabels.map(item => item.title);
    if (field('parent')) result.parent = parentId;
    if (field('childCount')) result.childCount = issue.subIssues || 0;
    if (field('milestone')) {
      result.milestone = milestone ? {
        id: milestone._id,
        name: milestone.label,
        status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status')
      } : null;
    }
    if (field('dueDate')) result.dueDate = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
    const issueTimes = this._issueTimeFields(issue);
    if (field('estimation')) result.estimation = issueTimes.estimation;
    if (field('reportedTime')) result.reportedTime = issueTimes.reportedTime;
    const issueRollup = issueRollupFields(issue);
    if (issueRollup) {
      if (field('estimationTotal')) result.estimationTotal = issueRollup.estimationTotal;
      if (field('reportedTimeTotal')) result.reportedTimeTotal = issueRollup.reportedTimeTotal;
    }
    if (field('createdOn')) result.createdOn = issue.createdOn;
    if (field('modifiedOn')) result.modifiedOn = issue.modifiedOn;
    if (field('completedAt')) result.completedAt = doneStatuses.has(issue.status) ? issue.modifiedOn : null;

    if (included('description')) {
      const preview = markdownPreview(descriptionContent ?? '', projection.descriptionPreviewChars);
      result.description = preview.text;
      if (projection.emitExpansionMetadata || preview.truncated) {
        result.descriptionTruncated = preview.truncated;
      }
    }
    const assignBounded = (key, values, maximum) => {
      const bounded = boundedCollection(values, maximum);
      result[key] = bounded.items;
      if (projection.emitExpansionMetadata || bounded.truncated) {
        result[`${key}Count`] = bounded.count;
        result[`${key}Truncated`] = bounded.truncated;
      }
    };
    if (included('comments')) {
      assignBounded('comments', comments.map(comment => ({
        id: comment._id,
        text: fromMarkup(comment.message),
        createdBy: comment.createdBy || null,
        createdOn: comment.createdOn,
        modifiedOn: comment.modifiedOn
      })), projection.limits.comments);
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
      assignBounded('activity', activity, projection.limits.activity);
    }
    if (included('timeReports')) {
      assignBounded('timeReports', timeReports.map(report => ({
        id: report._id,
        hours: report.value,
        description: fromMarkup(report.description),
        date: toIsoDate(report.date)
      })), projection.limits.timeReports);
    }
    if (included('relations') || included('blockedBy')) {
      const relationData = this._projectRelations(issue, relatedIssueMap, projection.limits.relations);
      for (const key of ['relations', 'blockedBy']) {
        if (!included(key)) continue;
        result[key] = relationData[key];
        if (projection.emitExpansionMetadata || relationData[`${key}Truncated`]) {
          result[`${key}Count`] = relationData[`${key}Count`];
          result[`${key}Truncated`] = relationData[`${key}Truncated`];
        }
      }
    }
    if (included('children')) {
      assignBounded('children', children.map(child => ({
        id: `${project.identifier}-${child.number}`,
        title: child.title,
        status: strictGet(statusMap, child.status, 'Status'),
        type: strictGet(taskTypeMap, child.kind, 'Task type')
      })), projection.limits.children);
    }

    return projectIssueFields(withExtra(issue, result), projection);
  }

  /**
   * Search issues by text across all projects.
   * @param {string} query - Search text
   * @param {string} [projectIdent] - Optional project to limit search
   * @param {number} [limit=200] - Maximum results
   * @returns {Promise<Object[]>}
   */
  async searchIssues(query, projectIdent, limit = 20, cursor) {
    const client = await this._getClient();
    limit = normalizePageLimit(limit, 20, MAX_PAGE_SIZE);

    const searchQuery = { $search: query };

    if (projectIdent) {
      const proj = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (!proj) throw new Error(`Project not found: ${projectIdent}`);
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

    const { statusMap, doneStatuses } = await this._buildStatusMaps(client);

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    const taskTypeMap = await this._buildTaskTypeMap(client);
    const { employeeMap } = await this._buildEmployeeMap(client);

    // Component map (ID → name) — gather all unique spaces from results
    const spaceIds = [...new Set(issues.map(i => i.space))];
    const allComponents = spaceIds.length > 0
      ? await client.findAll(tracker.class.Component, { space: { $in: spaceIds } })
      : [];
    const componentMap = new Map(allComponents.map(c => [c._id, c.label]));

    // Milestone map (ID → name)
    const allMilestones = spaceIds.length > 0
      ? await client.findAll(tracker.class.Milestone, { space: { $in: spaceIds } })
      : [];
    const milestoneMap = new Map(allMilestones.map(m => [m._id, m.label]));

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) ?? '?'}-${p.number}`]));

    const items = issues.map(i => withExtra(i, {
      id: `${strictGet(projMap, i.space, 'Issue project')}-${i.number}`,
      title: i.title,
      status: strictGet(statusMap, i.status, 'Status'),
      priority: strictGet(PRIORITY_NAMES, i.priority, 'Priority'),
      type: strictGet(taskTypeMap, i.kind, 'Task type'),
      assignee: i.assignee ? employeeMap.get(i.assignee) ?? null : null,
      component: i.component ? componentMap.get(i.component) ?? null : null,
      milestone: i.milestone ? milestoneMap.get(i.milestone) ?? null : null,
      parent: (i.attachedTo && i.attachedToClass === tracker.class.Issue) ? parentMap.get(i.attachedTo) ?? null : null,
      childCount: i.subIssues || 0,
      dueDate: i.dueDate ? new Date(i.dueDate).toISOString().split('T')[0] : null,
      createdOn: i.createdOn,
      modifiedOn: i.modifiedOn,
      completedAt: doneStatuses.has(i.status) ? i.modifiedOn : null
    }));
    return listEnvelope(items, fetchResult.nextCursor);
  }

  /**
   * Get issues assigned to the currently authenticated user.
   * @param {string} [projectIdent] - Optional project filter
   * @param {string} [status] - Optional status filter
   * @param {number} [limit=500] - Maximum results
   * @returns {Promise<Object[]>}
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
      const proj = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (!proj) throw new Error(`Project not found: ${projectIdent}`);
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

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    // Batch fetch all labels for efficiency (avoids N+1)
    const issueIds = issues.map(i => i._id);
    const allLabels = issueIds.length > 0
      ? await client.findAll(tags.class.TagReference, { attachedTo: { $in: issueIds } })
      : [];
    const labelsByIssue = this._groupLabelsByIssue(allLabels);

    const taskTypeMap = await this._buildTaskTypeMap(client);

    // Component map (ID → name)
    const spaceIds = [...new Set(issues.map(i => i.space))];
    const allComponents = spaceIds.length > 0
      ? await client.findAll(tracker.class.Component, { space: { $in: spaceIds } })
      : [];
    const componentMap = new Map(allComponents.map(c => [c._id, c.label]));

    // Milestone map (ID → name)
    const allMilestones = spaceIds.length > 0
      ? await client.findAll(tracker.class.Milestone, { space: { $in: spaceIds } })
      : [];
    const milestoneMap = new Map(allMilestones.map(m => [m._id, m.label]));

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) ?? '?'}-${p.number}`]));

    const result = [];
    for (const issue of issues) {
      const issueLabels = labelsByIssue.get(issue._id) || [];

      result.push(withExtra(issue, {
        id: `${strictGet(projMap, issue.space, 'Issue project')}-${issue.number}`,
        title: issue.title,
        status: strictGet(statusMap, issue.status, 'Status'),
        priority: strictGet(PRIORITY_NAMES, issue.priority, 'Priority'),
        type: strictGet(taskTypeMap, issue.kind, 'Task type'),
        assignee: issue.assignee ? employeeMap.get(issue.assignee) ?? null : null,
        component: issue.component ? componentMap.get(issue.component) ?? null : null,
        labels: issueLabels.map(l => l.title),
        parent: (issue.attachedTo && issue.attachedToClass === tracker.class.Issue) ? parentMap.get(issue.attachedTo) ?? null : null,
        childCount: issue.subIssues || 0,
        milestone: issue.milestone ? milestoneMap.get(issue.milestone) ?? null : null,
        dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
        ...this._issueTimeFields(issue),
        createdOn: issue.createdOn,
        modifiedOn: issue.modifiedOn,
        completedAt: doneStatuses.has(issue.status) ? issue.modifiedOn : null
      }));
    }

    return listEnvelope(result, fetchResult.nextCursor);
  }

  /**
   * Get a project summary with issue counts by status, priority, and overdue info.
   * @param {string} projectIdent - Project identifier
   * @returns {Promise<Object>}
   */
  async summarizeProject(projectIdent) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const issues = await client.findAll(tracker.class.Issue, { space: project._id });
    const { statuses, statusMap } = await this._buildStatusMaps(client);
    const closedStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY || s.category === LOST_CATEGORY)
      .map(s => s._id));
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });

    // Count by status
    const byStatus = {};
    for (const issue of issues) {
      const name = strictGet(statusMap, issue.status, 'Status');
      byStatus[name] = (byStatus[name] || 0) + 1;
    }

    // Count by priority
    const byPriority = {};
    for (const issue of issues) {
      const name = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
      byPriority[name] = (byPriority[name] || 0) + 1;
    }

    // Overdue issues
    const now = Date.now();
    const overdue = issues.filter(i => {
      if (!i.dueDate) return false;
      return i.dueDate < now && !closedStatuses.has(i.status);
    });

    const overdueList = overdue.map(i => ({
      id: `${project.identifier}-${i.number}`,
      title: i.title,
      dueDate: new Date(i.dueDate).toISOString().split('T')[0],
      priority: strictGet(PRIORITY_NAMES, i.priority, 'Priority')
    }));

    // Unassigned count
    const unassigned = issues.filter(i => !i.assignee).length;

    // Estimation stats
    const totalEstimation = issues.reduce((sum, i) => sum + toHours(i.estimation), 0);
    const totalReported = issues.reduce((sum, i) => sum + toHours(i.reportedTime), 0);

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
   * Get the modification history / activity for an issue.
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
