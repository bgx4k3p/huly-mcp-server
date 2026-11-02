/**
 * Issue writes: create, update, batch create, move and delete, including issue numbering and ranks.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  MAX_BATCH_SIZE,
  nameMatch,
  normalizeDueDate,
  parseHours,
  PRIORITY_NAMES,
  resolvePriority,
  toMarkup
} from '../helpers.mjs';
import { issueRank } from '../issueRank.mjs';
import { contactPlugin, generateId, task, tracker } from './sdk.mjs';

export class IssueWriteMethods {
  /**
   * Reserve `count` consecutive issue numbers in a project and return the first.
   * Call only after every input is validated: a reserved number is never released,
   * so a failure after this point leaves a permanent gap in the numbering.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {number} count - How many numbers to reserve
   * @returns {Promise<number>} First reserved issue number
   * @throws {Error} When Huly does not return the updated sequence
   */
  async _reserveIssueNumbers(client, project, count) {
    const result = await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      $inc: { sequence: count }
    }, true);
    // The retrieved document carries the incremented value, so concurrent creates cannot read each other's number.
    const sequence = result?.object?.sequence;
    if (!Number.isInteger(sequence)) {
      throw new Error(`Huly did not return the updated sequence for project ${project.identifier}`);
    }
    return sequence - count + 1;
  }

  /**
   * Highest issue rank in a project, or undefined when it has none. New ranks are computed here
   * rather than left to the server, because only Huly servers from March 2026 on assign them.
   * @param {Object} client - Huly SDK client
   * @param {string} projectId - Project document id
   * @returns {Promise<string|undefined>}
   */
  async _lastIssueRank(client, projectId) {
    const last = await client.findOne(tracker.class.Issue, { space: projectId }, { sort: { rank: -1 } });
    return last?.rank;
  }

  /**
   * Create a new issue in a project. Status defaults to the project's default status, type to the
   * project's default task type.
   * @param {string} projectIdent - Project identifier
   * @param {string} title - Issue title
   * @param {string} [description] - Description, in `extra.descriptionFormat`
   * @param {string} [priority] - Priority name; defaults to none
   * @param {string} [status] - Initial status name, scoped to the task type
   * @param {string[]} [labels] - Label names to apply
   * @param {string} [type] - Task type name
   * @param {Object} [extra] - Additional fields
   * @param {string} [extra.assignee] - Assignee name
   * @param {string} [extra.component] - Component name
   * @param {string} [extra.milestone] - Milestone name
   * @param {string|number} [extra.dueDate] - Due date (ISO date or timestamp)
   * @param {number|string} [extra.estimation] - Estimated hours
   * @param {string} [extra.descriptionFormat='markdown'] - Description format: markdown, html or plain
   * @returns {Promise<Object>} id, internalId, title, and the stored status and priority names (as reads report them)
   * @throws {Error} When a status, type, priority, assignee, component, milestone or date is invalid
   */
  async createIssue(projectIdent, title, description, priority, status, labels, type, extra = {}) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    // Resolve task type first — status lookup depends on it
    let taskTypeId;
    if (type) {
      taskTypeId = await this._findTaskTypeByName(client, project, type);
    } else {
      taskTypeId = await this._getDefaultTaskType(client, project);
    }

    // Resolve status scoped to the task type
    const statuses = await this._getScopedStatuses(client, taskTypeId);
    let statusDoc;
    if (status) {
      statusDoc = statuses.find(s => nameMatch(s.name, status));
      if (!statusDoc) {
        const available = statuses.map(s => s.name).join(', ');
        throw new Error(`Status "${status}" not found. Available: ${available}`);
      }
    } else {
      statusDoc = this._defaultStatus(project, statuses);
    }
    const statusId = statusDoc._id;

    // Resolve optional extra fields
    let assigneeId = null;
    if (extra.assignee) {
      assigneeId = await this._findEmployeeByName(client, extra.assignee);
    }

    let componentId = null;
    if (extra.component) {
      componentId = await this._findComponentByName(client, project._id, extra.component);
    }

    let milestoneId = null;
    if (extra.milestone) {
      milestoneId = await this._findMilestoneByName(client, project._id, extra.milestone);
    }

    const priorityValue = resolvePriority(priority);
    const estimation = extra.estimation === undefined ? 0 : parseHours(extra.estimation, 'estimation');
    const dueDate = normalizeDueDate(extra.dueDate);
    const lastRank = await this._lastIssueRank(client, project._id);

    // Every input is valid; only now spend an issue number.
    const nextNumber = await this._reserveIssueNumbers(client, project, 1);

    const issueId = generateId();
    await client.addCollection(
      tracker.class.Issue,
      project._id,
      project._id,
      tracker.class.Project,
      'issues',
      {
        title,
        identifier: `${project.identifier}-${nextNumber}`,
        description: '',
        status: statusId,
        priority: priorityValue,
        number: nextNumber,
        assignee: assigneeId,
        component: componentId,
        milestone: milestoneId,
        estimation,
        dueDate,
        remainingTime: 0,
        reportedTime: 0,
        childInfo: [],
        parents: [],
        kind: taskTypeId,
        rank: issueRank(lastRank, nextNumber)
      },
      issueId
    );

    if (description) {
      // Write description via collaborator for proper UI rendering.
      // Set a collaborator reference on the doc first, then write content
      // via updateMarkup which updates the live document.
      const refId = `${issueId}-description-${Date.now()}`;
      await client.updateDoc(tracker.class.Issue, project._id, issueId, {
        description: refId
      });
      await this._writeCollaboratorField(
        issueId, tracker.class.Issue, description, extra.descriptionFormat
      );
    }

    if (labels && labels.length > 0) {
      for (const labelName of labels) {
        await this._addLabelToIssue(client, issueId, project._id, labelName);
      }
    }

    return {
      id: `${project.identifier}-${nextNumber}`,
      internalId: issueId,
      title,
      status: statusDoc.name,
      priority: PRIORITY_NAMES[priorityValue]
    };
  }

  /**
   * Update fields on an existing issue. Only arguments that are not undefined are changed.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} [title] - New title
   * @param {string} [description] - New description, in `extra.descriptionFormat`
   * @param {string} [priority] - New priority name
   * @param {string} [status] - New status name, scoped to the (new) task type
   * @param {string} [type] - New task type name
   * @param {Object} [extra] - Additional fields
   * @param {string} [extra.assignee] - Assignee name; empty string clears it
   * @param {string} [extra.component] - Component name; empty string clears it
   * @param {string} [extra.milestone] - Milestone name; empty string clears it
   * @param {string|number|null} [extra.dueDate] - Due date (ISO date or timestamp); blank or null clears it
   * @param {number|string} [extra.estimation] - Estimated hours
   * @param {string} [extra.descriptionFormat='markdown'] - Description format: markdown, html or plain
   * @returns {Promise<{id: string, updated: string[]}>} Issue id and the names of the updated fields
   * @throws {Error} When a status, type, priority, assignee, component, milestone or date is invalid
   */
  async updateIssue(issueId, title, description, priority, status, type, extra = {}) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const updates = {};
    const updatedFields = [];

    if (title !== undefined) {
      updates.title = title;
      updatedFields.push('title');
    }

    if (priority !== undefined) {
      updates.priority = resolvePriority(priority, issue.priority);
      updatedFields.push('priority');
    }

    // Resolve type first so status can be scoped to the new type
    let resolvedTaskTypeId = issue.kind;
    if (type !== undefined) {
      resolvedTaskTypeId = await this._findTaskTypeByName(client, project, type);
      updates.kind = resolvedTaskTypeId;
      updatedFields.push('type');
    }

    if (status !== undefined) {
      const taskTypeId = resolvedTaskTypeId || await this._getDefaultTaskType(client, project);
      const statuses = await this._getScopedStatuses(client, taskTypeId);
      const found = statuses.find(s => nameMatch(s.name, status));
      if (!found) {
        const available = statuses.map(s => s.name).join(', ');
        throw new Error(`Status "${status}" not found. Available: ${available}`);
      }
      updates.status = found._id;
      updatedFields.push('status');
    }

    if (extra.assignee !== undefined) {
      updates.assignee = extra.assignee.trim() === ''
        ? null
        : await this._findEmployeeByName(client, extra.assignee);
      updatedFields.push('assignee');
    }

    if (extra.component !== undefined) {
      updates.component = extra.component.trim() === ''
        ? null
        : await this._findComponentByName(client, project._id, extra.component);
      updatedFields.push('component');
    }

    if (extra.milestone !== undefined) {
      updates.milestone = extra.milestone.trim() === ''
        ? null
        : await this._findMilestoneByName(client, project._id, extra.milestone);
      updatedFields.push('milestone');
    }

    if (extra.dueDate !== undefined) {
      updates.dueDate = normalizeDueDate(extra.dueDate);
      updatedFields.push('dueDate');
    }

    if (extra.estimation !== undefined) {
      updates.estimation = parseHours(extra.estimation, 'estimation');
      updatedFields.push('estimation');
    }

    if (Object.keys(updates).length > 0) {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, updates);
    }

    if (description !== undefined) {
      // Write description via collaborator service for proper UI rendering.
      // updateMarkup writes to the live document, which getMarkup reads back.
      await this._writeCollaboratorField(
        issue._id, issue._class, description, extra.descriptionFormat
      );
      updatedFields.push('description');
    }

    return {
      id: issueId,
      updated: updatedFields
    };
  }

  /**
   * Create multiple issues in a single batch. Invalid items are reported in `errors` and do not consume a number.
   * @param {string} projectIdent - Project identifier
   * @param {Object[]} issues - Issue objects with { title, description, descriptionFormat, priority, status,
   *   labels, type, assignee, component, milestone, estimation, dueDate }
   * @returns {Promise<Object>} project, created, errors, total
   * @throws {Error} When `issues` is empty, not an array, or larger than MAX_BATCH_SIZE (500)
   */
  async batchCreateIssues(projectIdent, issues) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    if (!Array.isArray(issues) || issues.length === 0) {
      throw new Error('issues must be a non-empty array');
    }
    if (issues.length > MAX_BATCH_SIZE) throw new Error(`Batch size limited to ${MAX_BATCH_SIZE} issues`);

    // Cache lookups to avoid N+1 queries in the loop
    const cachedTaskTypes = await client.findAll(task.class.TaskType, {});
    const defaultTaskTypeId = await this._getDefaultTaskType(client, project);
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const taskTypeIdsByName = new Map();
    const statusesByTaskType = new Map();

    const findNamed = (records, nameOf, wanted, kind) => {
      const found = records.find(r => nameMatch(nameOf(r), wanted));
      if (!found) {
        throw new Error(`${kind} "${wanted}" not found. Available: ${records.map(nameOf).join(', ')}`);
      }
      return found._id;
    };

    // Resolve every item before reserving numbers, so a rejected item never consumes one.
    const resolved = [];
    const errors = [];
    for (const item of issues) {
      if (!item.title) {
        errors.push({ error: 'Missing title', input: item });
        continue;
      }
      try {
        let taskTypeId = defaultTaskTypeId;
        if (item.type) {
          const key = item.type.toLowerCase();
          if (!taskTypeIdsByName.has(key)) {
            taskTypeIdsByName.set(key, await this._findTaskTypeByName(client, project, item.type, cachedTaskTypes));
          }
          taskTypeId = taskTypeIdsByName.get(key);
        }
        if (!statusesByTaskType.has(taskTypeId)) {
          statusesByTaskType.set(taskTypeId, await this._getScopedStatuses(client, taskTypeId));
        }
        const scopedStatuses = statusesByTaskType.get(taskTypeId);

        resolved.push({
          item,
          attributes: {
            status: item.status
              ? findNamed(scopedStatuses, s => s.name, item.status, 'Status')
              : this._defaultStatus(project, scopedStatuses)._id,
            priority: resolvePriority(item.priority),
            assignee: item.assignee ? findNamed(employees, e => e.name, item.assignee, 'Assignee') : null,
            component: item.component ? findNamed(components, c => c.label, item.component, 'Component') : null,
            milestone: item.milestone ? findNamed(milestones, m => m.label, item.milestone, 'Milestone') : null,
            estimation: item.estimation === undefined ? 0 : parseHours(item.estimation, 'estimation'),
            dueDate: normalizeDueDate(item.dueDate),
            kind: taskTypeId
          }
        });
      } catch (error) {
        errors.push({ error: error.message, input: item });
      }
    }

    const statusNames = new Map([...statusesByTaskType.values()].flat().map(status => [status._id, status.name]));
    const created = [];
    if (resolved.length === 0) {
      return { project: project.identifier, created, errors, total: 0 };
    }

    // All items share one position after the last rank; their numbers order them, so issues
    // created concurrently by other sessions interleave strictly by number.
    const lastRank = await this._lastIssueRank(client, project._id);
    let currentSequence = await this._reserveIssueNumbers(client, project, resolved.length) - 1;

    for (const { item, attributes } of resolved) {
      currentSequence++;
      const issueId = generateId();
      await client.addCollection(
        tracker.class.Issue,
        project._id,
        project._id,
        tracker.class.Project,
        'issues',
        {
          title: item.title,
          identifier: `${project.identifier}-${currentSequence}`,
          description: '',
          status: attributes.status,
          priority: attributes.priority,
          number: currentSequence,
          assignee: attributes.assignee,
          component: attributes.component,
          milestone: attributes.milestone,
          estimation: attributes.estimation,
          dueDate: attributes.dueDate,
          remainingTime: 0,
          reportedTime: 0,
          childInfo: [],
          parents: [],
          kind: attributes.kind,
          rank: issueRank(lastRank, currentSequence)
        },
        issueId
      );

      if (item.description) {
        try {
          await this._writeCollaboratorField(issueId, tracker.class.Issue, item.description, item.descriptionFormat);
        } catch {
          // Fallback to markup if collaborator unavailable
          await client.updateDoc(tracker.class.Issue, project._id, issueId, {
            description: toMarkup(item.description, item.descriptionFormat)
          });
        }
      }

      if (item.labels && item.labels.length > 0) {
        for (const labelName of item.labels) {
          await this._addLabelToIssue(client, issueId, project._id, labelName);
        }
      }

      created.push({
        id: `${project.identifier}-${currentSequence}`,
        internalId: issueId,
        title: item.title,
        status: statusNames.get(attributes.status),
        priority: PRIORITY_NAMES[attributes.priority]
      });
    }

    return { project: project.identifier, created, errors, total: created.length };
  }

  /**
   * Move an issue to a different project, giving it a new number there. The status is kept when the target
   * workflow has one with the same name, otherwise the target project's default status is used.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} targetProject - Target project identifier
   * @returns {Promise<Object>}
   */
  async moveIssue(issueId, targetProject) {
    const client = await this._getClient();

    const { project: sourceProject, issue } = await this._parseAndFindIssue(client, issueId);

    const destProject = await this._findProject(client, targetProject);

    if (sourceProject._id === destProject._id) {
      return { message: `Issue ${issueId} is already in project ${targetProject}` };
    }

    // Remap the status when the destination workflow lacks the current one
    const destTaskTypeId = issue.kind ?? await this._getDefaultTaskType(client, destProject);
    const destStatuses = await this._getScopedStatuses(client, destTaskTypeId);
    const currentStatusName = (await client.findOne(tracker.class.IssueStatus, { _id: issue.status }))?.name;
    let destStatusId;
    if (currentStatusName) {
      const destStatus = destStatuses.find(s => nameMatch(s.name, currentStatusName));
      // Fall back to target project's default status
      destStatusId = (destStatus ?? this._defaultStatus(destProject, destStatuses))?._id;
    }
    const lastDestRank = await this._lastIssueRank(client, destProject._id);

    // Everything is resolved; only now spend a number in the target project.
    const nextNumber = await this._reserveIssueNumbers(client, destProject, 1);
    const issueUpdates = {
      space: destProject._id,
      number: nextNumber,
      identifier: `${destProject.identifier}-${nextNumber}`,
      rank: issueRank(lastDestRank, nextNumber)
    };

    // Fix attachedTo for top-level issues (attached to source project)
    if (issue.attachedTo === sourceProject._id || issue.attachedToClass === tracker.class.Project) {
      issueUpdates.attachedTo = destProject._id;
    }
    if (destStatusId !== undefined) issueUpdates.status = destStatusId;

    await client.updateDoc(tracker.class.Issue, sourceProject._id, issue._id, issueUpdates);

    const newId = `${destProject.identifier}-${nextNumber}`;

    return {
      message: `Moved ${issueId} to ${newId}`,
      oldId: issueId,
      newId,
      sourceProject: sourceProject.identifier,
      targetProject: destProject.identifier
    };
  }

  /**
   * Permanently delete an issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<{message: string, issueId: string}>}
   */
  async deleteIssue(issueId) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    await client.removeCollection(tracker.class.Issue, project._id, issue._id, issue.attachedTo, issue.attachedToClass, issue.collection);

    return {
      message: `Issue ${issueId} permanently deleted`,
      issueId
    };
  }
}
