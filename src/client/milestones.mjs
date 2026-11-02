/**
 * Milestones: list, get, create, update, delete and assignment to issues.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  DEFAULT_MILESTONE_DAYS,
  fromMarkup,
  listEnvelope,
  MILESTONE_STATUS_MAP,
  MILESTONE_STATUS_NAMES,
  nameMatch,
  normalizeDueDate,
  normalizePageLimit,
  strictGet,
  toMarkup,
  withExtra
} from '../helpers.mjs';
import { boundedCollection, normalizeIncludeSet } from '../projection.mjs';
import { core, generateId, tracker } from './sdk.mjs';

const MILESTONE_INCLUDE_FIELDS = Object.freeze(['issues']);

/**
 * Output row for a milestone, optionally with a bounded list of its issues.
 * @param {Object} milestone - Milestone document
 * @param {Object} details
 * @param {string[]} details.collaborators - Collaborator names
 * @param {number} [details.issueCount] - Total issue count, reported by single reads
 * @param {Object} [details.issues] - Issue expansion: `{ issues, project, statusMap, taskTypeMap, limit }`
 * @returns {Object}
 */
function milestoneRow(milestone, { collaborators, issueCount, issues }) {
  const row = {
    id: milestone._id,
    name: milestone.label,
    description: fromMarkup(milestone.description),
    status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status'),
    targetDate: milestone.targetDate ? new Date(milestone.targetDate).toISOString().split('T')[0] : null,
    comments: milestone.comments || 0,
    ...(issueCount === undefined ? {} : { issueCount }),
    collaborators
  };
  if (issues) {
    const projected = issues.issues.map(issue => ({
      id: `${issues.project.identifier}-${issue.number}`,
      title: issue.title,
      status: strictGet(issues.statusMap, issue.status, 'Status'),
      type: strictGet(issues.taskTypeMap, issue.kind, 'Task type')
    }));
    const bounded = boundedCollection(projected, issues.limit);
    row.issues = bounded.items;
    row.issuesCount = bounded.count;
    row.issuesTruncated = bounded.truncated;
  }
  return withExtra(milestone, row);
}

export class MilestonesMethods {
  /**
   * List all milestones in a project with optional status filtering.
   * @param {string} projectIdent - Project identifier
   * @param {string} [status] - Filter by status
   * @returns {Promise<Object[]>}
   */
  async listMilestones(projectIdent, status, options = {}) {
    const client = await this._getClient();
    const include = normalizeIncludeSet(options.include, MILESTONE_INCLUDE_FIELDS);
    const issuesLimit = normalizePageLimit(options.issuesLimit, 20, 100);

    const project = await this._findProject(client, projectIdent);

    const query = { space: project._id };

    if (status) {
      const statusValue = MILESTONE_STATUS_MAP[status.toLowerCase()];
      if (statusValue === undefined) throw new Error(`Milestone status not found: ${status}`);
      query.status = statusValue;
    }

    const milestones = await client.findAll(tracker.class.Milestone, query, {
      sort: { targetDate: 1 }
    });

    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_milestones',
      project: projectIdent.toUpperCase(),
      status: status?.toLowerCase() ?? null,
      include: [...include].sort(),
      issuesLimit
    };
    const page = this._cursoredFindAll(milestones, { ...options, cursorScope });
    const selectedMilestones = page.items;
    let issuesByMilestone = new Map();
    let statusMap;
    let taskTypeMap;
    if (include.has('issues') && selectedMilestones.length > 0) {
      const milestoneIds = selectedMilestones.map(milestone => milestone._id);
      const [allIssues, statusMaps, fetchedTaskTypeMap] = await Promise.all([
        client.findAll(tracker.class.Issue, {
          space: project._id,
          milestone: { $in: milestoneIds }
        }),
        this._buildStatusMaps(client),
        this._buildTaskTypeMap(client)
      ]);
      statusMap = statusMaps.statusMap;
      taskTypeMap = fetchedTaskTypeMap;
      issuesByMilestone = new Map();
      for (const issue of allIssues) {
        if (!issuesByMilestone.has(issue.milestone)) issuesByMilestone.set(issue.milestone, []);
        issuesByMilestone.get(issue.milestone).push(issue);
      }
    }

    const collaboratorsByMilestone = await this._collaboratorsByObject(
      client,
      selectedMilestones.map(milestone => milestone._id)
    );
    const items = selectedMilestones.map(milestone => milestoneRow(milestone, {
      collaborators: collaboratorsByMilestone.get(milestone._id) ?? [],
      issues: include.has('issues') ? {
        issues: issuesByMilestone.get(milestone._id) || [],
        project,
        statusMap,
        taskTypeMap,
        limit: issuesLimit
      } : undefined
    }));
    return listEnvelope(items, page.nextCursor);
  }

  /**
   * Get a specific milestone by name with issue count.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Milestone name
   * @returns {Promise<Object>}
   */
  async getMilestone(projectIdent, name, options = {}) {
    const client = await this._getClient();
    const include = normalizeIncludeSet(options.include, MILESTONE_INCLUDE_FIELDS);
    const issuesLimit = normalizePageLimit(options.issuesLimit, 20, 100);

    const project = await this._findProject(client, projectIdent);

    const milestones = await client.findAll(tracker.class.Milestone, {
      space: project._id
    });

    const milestone = milestones.find(m => nameMatch(m.label, name));

    if (!milestone) {
      throw new Error(`Milestone not found: ${name}`);
    }

    const issues = await client.findAll(tracker.class.Issue, {
      space: project._id,
      milestone: milestone._id
    });

    const [collaboratorsByMilestone, statusData, taskTypeMap] = await Promise.all([
      this._collaboratorsByObject(client, [milestone._id]),
      include.has('issues') ? this._buildStatusMaps(client) : null,
      include.has('issues') ? this._buildTaskTypeMap(client) : null
    ]);
    return milestoneRow(milestone, {
      collaborators: collaboratorsByMilestone.get(milestone._id) ?? [],
      issueCount: issues.length,
      issues: include.has('issues') ? {
        issues,
        project,
        statusMap: statusData.statusMap,
        taskTypeMap,
        limit: issuesLimit
      } : undefined
    });
  }

  /**
   * Create a new milestone in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Milestone name
   * @param {string} [description] - Milestone description
   * @param {string} [targetDate] - Target date ISO 8601
   * @param {string} [status] - Initial status
   * @returns {Promise<Object>}
   */
  async createMilestone(projectIdent, name, description, targetDate, status, format, collaborators = []) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    const allMilestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const existing = allMilestones.find(m => nameMatch(m.label, name));

    if (existing) {
      return {
        message: `Milestone "${name}" already exists`,
        id: existing._id,
        name: existing.label
      };
    }

    const targetTimestamp = normalizeDueDate(targetDate) ??
      Date.now() + (DEFAULT_MILESTONE_DAYS * 24 * 60 * 60 * 1000);

    let statusValue = 0;
    if (status) {
      const parsed = MILESTONE_STATUS_MAP[status.toLowerCase()];
      if (parsed === undefined) throw new Error(`Milestone status not found: ${status}`);
      statusValue = parsed;
    }

    // Resolve every collaborator before writing the milestone so an invalid
    // member cannot leave behind a partially-created object.
    const resolvedCollaborators = await this._resolveCollaboratorMembers(client, collaborators);

    const milestoneId = generateId();
    await client.createDoc(tracker.class.Milestone, project._id, {
      label: name,
      description: toMarkup(description || '', format),
      status: statusValue,
      targetDate: targetTimestamp,
      comments: 0,
      attachments: 0
    }, milestoneId);

    try {
      for (const collaborator of resolvedCollaborators) {
        await client.addCollection(
          core.class.Collaborator,
          project._id,
          milestoneId,
          tracker.class.Milestone,
          'collaborators',
          { collaborator: collaborator.account }
        );
      }
    } catch (error) {
      await client.removeDoc(tracker.class.Milestone, project._id, milestoneId);
      throw error;
    }

    return {
      message: `Milestone "${name}" created`,
      id: milestoneId,
      name,
      description: description || '',
      status: MILESTONE_STATUS_NAMES[statusValue],
      targetDate: new Date(targetTimestamp).toISOString().split('T')[0],
      collaborators: resolvedCollaborators
    };
  }

  /**
   * Set or clear the milestone for an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} [milestoneName] - Milestone name or empty to clear
   * @returns {Promise<Object>}
   */
  async setMilestone(issueId, milestoneName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    if (!milestoneName || milestoneName.trim() === '') {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
        milestone: null
      });
      return {
        message: `Cleared milestone from ${issueId}`,
        issueId,
        milestone: null
      };
    }

    const milestones = await client.findAll(tracker.class.Milestone, {
      space: project._id
    });

    const milestone = milestones.find(m => nameMatch(m.label, milestoneName));

    if (!milestone) {
      const available = milestones.map(m => m.label).join(', ');
      throw new Error(`Milestone "${milestoneName}" not found. Available milestones: ${available || 'none'}`);
    }

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      milestone: milestone._id
    });

    return {
      message: `Set milestone "${milestone.label}" on ${issueId}`,
      issueId,
      milestone: {
        id: milestone._id,
        name: milestone.label
      }
    };
  }

  async updateMilestone(projectIdent, name, updates = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const milestone = milestones.find(m => nameMatch(m.label, name));
    if (!milestone) throw new Error(`Milestone not found: ${name}`);

    const docUpdates = {};
    const updatedFields = [];

    if (updates.name !== undefined) {
      docUpdates.label = updates.name;
      updatedFields.push('name');
    }
    if (updates.description !== undefined) {
      docUpdates.description = toMarkup(updates.description, updates.descriptionFormat);
      updatedFields.push('description');
    }
    if (updates.status !== undefined) {
      const statusValue = MILESTONE_STATUS_MAP[updates.status.toLowerCase()];
      if (statusValue === undefined) {
        throw new Error(`Milestone status not found: ${updates.status}`);
      }
      docUpdates.status = statusValue;
      updatedFields.push('status');
    }
    if (updates.targetDate !== undefined) {
      docUpdates.targetDate = normalizeDueDate(updates.targetDate);
      updatedFields.push('targetDate');
    }

    // Validate collaborator identities before applying any ordinary milestone
    // fields so a bad member name cannot cause a partial update.
    if (updates.collaborators !== undefined) {
      await this._resolveCollaboratorMembers(client, updates.collaborators);
    }

    if (Object.keys(docUpdates).length > 0) {
      await client.updateDoc(tracker.class.Milestone, project._id, milestone._id, docUpdates);
    }

    let collaborators;
    if (updates.collaborators !== undefined) {
      collaborators = await this._syncCollaborators(client, milestone, updates.collaborators);
      updatedFields.push('collaborators');
    }

    return {
      id: milestone._id,
      name: docUpdates.label || milestone.label,
      updated: updatedFields,
      ...(collaborators !== undefined ? { collaborators } : {})
    };
  }

  async deleteMilestone(projectIdent, name, moveIssuesTo) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const milestone = milestones.find(m => nameMatch(m.label, name));
    if (!milestone) throw new Error(`Milestone not found: ${name}`);

    let targetMilestone = null;
    if (moveIssuesTo && moveIssuesTo.trim() !== '') {
      targetMilestone = milestones.find(m => m._id !== milestone._id && nameMatch(m.label, moveIssuesTo));
      if (!targetMilestone) throw new Error(`Milestone not found: ${moveIssuesTo}`);
    }

    const issues = await client.findAll(tracker.class.Issue, { milestone: milestone._id });
    for (const issue of issues) {
      await client.updateDoc(tracker.class.Issue, issue.space, issue._id, {
        milestone: targetMilestone?._id ?? null
      });
    }

    await client.removeDoc(tracker.class.Milestone, project._id, milestone._id);

    return {
      message: `Milestone "${name}" deleted from ${projectIdent}`,
      id: milestone._id,
      issuesMoved: issues.length,
      movedTo: targetMilestone?.label ?? null
    };
  }
}
