/**
 * Shared resolvers that turn user-facing names and identifiers into SDK documents and ids.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { DONE_CATEGORY, nameMatch } from '../helpers.mjs';
import { contactPlugin, tags, task, tracker } from './sdk.mjs';

/**
 * Display name of a task or project type; types created without a name fall back to the last segment of their id.
 * @param {Object} type - TaskType or ProjectType document
 * @returns {string}
 */
export function typeDisplayName(type) {
  return type.name || type._id.split(':').pop();
}

/**
 * Find a record by name, ignoring case, or fail listing the names that exist.
 * @param {Object[]} records - Candidate documents
 * @param {(record: Object) => string} nameOf - Name accessor
 * @param {string} name - Requested name
 * @param {string} kind - Record kind for the error message, e.g. "Component"
 * @returns {Object} Matching document
 * @throws {Error} When no record has that name
 */
export function findByName(records, nameOf, name, kind) {
  const found = records.find(record => nameMatch(nameOf(record), name));
  if (!found) {
    throw new Error(`${kind} not found: ${name}. Available: ${records.map(nameOf).join(', ') || 'none'}`);
  }
  return found;
}

/**
 * Fail when another record already uses a name, ignoring case, so names never collide by case alone.
 * @param {Object[]} records - Existing documents
 * @param {(record: Object) => string} nameOf - Name accessor
 * @param {string} name - Name about to be created or given
 * @param {string} kind - Record kind for the error message
 * @param {string} [exceptId] - Record being renamed, which may keep its own name
 * @throws {Error} When the name is taken
 */
export function assertNameAvailable(records, nameOf, name, kind, exceptId) {
  const taken = records.find(record => record._id !== exceptId && nameMatch(nameOf(record), name));
  if (taken) throw new Error(`${kind} "${nameOf(taken)}" already exists`);
}

export class LookupsMethods {
  /**
   * Find a project by its identifier (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {string} identifier - Project identifier, e.g. "PROJ"
   * @param {Object} [options] - SDK find options, e.g. `{ showArchived: true }`
   * @returns {Promise<Object>} Project document
   * @throws {Error} When no project has that identifier
   */
  async _findProject(client, identifier, options) {
    const project = await client.findOne(tracker.class.Project, { identifier: identifier.toUpperCase() }, options);
    if (!project) throw new Error(`Project not found: ${identifier}`);
    return project;
  }

  /**
   * Parse an issue identifier and find the corresponding issue and project.
   * @param {Object} client - Huly SDK client
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<{project: Object, issue: Object}>}
   * @throws {Error} When the identifier is missing or malformed, or the project or issue does not exist
   */
  async _parseAndFindIssue(client, issueId) {
    if (typeof issueId !== 'string' || issueId.trim() === '') {
      throw new Error('Issue ID is required (expected format: PROJECT-NUMBER)');
    }

    const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
    if (!match) {
      throw new Error(`Invalid issue ID format: ${issueId}. Expected format: PROJECT-NUMBER`);
    }

    const [, projectId, issueNum] = match;

    const project = await this._findProject(client, projectId);

    const issue = await client.findOne(tracker.class.Issue, {
      space: project._id,
      number: parseInt(issueNum, 10)
    });

    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    return { project, issue };
  }

  /**
   * The project's ProjectType document, or undefined when it cannot be resolved.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @returns {Promise<Object|undefined>}
   */
  async _projectType(client, project) {
    return await client.findOne(task.class.ProjectType, { _id: project.type }) ?? undefined;
  }

  /**
   * Find a task type id by name among the task types of a project's type (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {string} typeName - Task type name
   * @param {Object[]} [cachedTaskTypes] - All TaskType documents, when the caller already loaded them
   * @returns {Promise<string>} Task type id
   * @throws {Error} When no task type of the project has that name
   */
  async _findTaskTypeByName(client, project, typeName, cachedTaskTypes) {
    const taskTypes = cachedTaskTypes || await client.findAll(task.class.TaskType, {});
    const projectType = await this._projectType(client, project);
    const scopedTypes = projectType?.tasks
      ? taskTypes.filter(tt => projectType.tasks.includes(tt._id))
      : taskTypes;

    const found = scopedTypes.find(tt => nameMatch(typeDisplayName(tt), typeName));

    if (!found) {
      const availableTypes = scopedTypes.map(typeDisplayName).join(', ');
      throw new Error(`Task type "${typeName}" not found. Available types: ${availableTypes}`);
    }

    return found._id;
  }

  /**
   * Default task type for a project: the scoped task type named "Task", else the first one scoped to the
   * project type.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @returns {Promise<string>} Task type id
   * @throws {Error} When the project type has no task types
   */
  async _getDefaultTaskType(client, project) {
    const projectType = await this._projectType(client, project);

    if (projectType?.tasks?.length) {
      const taskTypes = await client.findAll(task.class.TaskType, {});
      const scoped = taskTypes.filter(tt => projectType.tasks.includes(tt._id));
      if (scoped.length) {
        // Prefer the type named "Task" (the common default), not the first in list (often Epic)
        const taskType = scoped.find(tt => nameMatch(typeDisplayName(tt), 'Task'));
        return (taskType || scoped[0])._id;
      }
    }

    throw new Error(
      `No task types configured for project "${project.identifier}". ` +
      'Specify a type explicitly or configure task types in workspace settings.'
    );
  }

  /**
   * Status a new or moved issue gets when none is requested: the project's default when it belongs to the
   * task type's workflow, otherwise the workflow's first status.
   * @param {Object} project - Project document
   * @param {Object[]} statuses - The task type's workflow statuses, from `_getScopedStatuses`
   * @returns {Object} IssueStatus document
   */
  _defaultStatus(project, statuses) {
    return statuses.find(status => status._id === project.defaultIssueStatus) ?? statuses[0];
  }

  /**
   * Statuses in a task type's workflow, in workflow order. Falls back to every workspace status when the
   * task type has no scoped list.
   * @param {Object} client - Huly SDK client
   * @param {string} taskTypeId - Task type id
   * @returns {Promise<Object[]>} IssueStatus documents
   * @throws {Error} When the workspace has no statuses
   */
  async _getScopedStatuses(client, taskTypeId) {
    const taskType = await client.findOne(task.class.TaskType, { _id: taskTypeId });
    if (taskType?.statuses?.length) {
      const found = await client.findAll(tracker.class.IssueStatus, { _id: { $in: taskType.statuses } });
      // Preserve workflow order from TaskType.statuses
      const statusById = new Map(found.map(s => [s._id, s]));
      const scoped = taskType.statuses.map(id => statusById.get(id)).filter(Boolean);
      if (scoped.length) return scoped;
    }

    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found in workspace');
    return allStatuses;
  }

  /**
   * Find an active employee id by name (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {string} name - Employee name
   * @returns {Promise<string>} Employee id
   * @throws {Error} When no active employee has that name
   */
  async _findEmployeeByName(client, name) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const found = employees.find(e => nameMatch(e.name, name));
    if (!found) {
      throw new Error(`Employee not found: ${name}`);
    }
    return found._id;
  }

  /**
   * Find a milestone in a project by name (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {string} projectId - Project id
   * @param {string} name - Milestone name
   * @returns {Promise<Object>} Milestone document
   * @throws {Error} When the project has no milestone with that name
   */
  async _findMilestone(client, projectId, name) {
    const milestones = await client.findAll(tracker.class.Milestone, { space: projectId });
    return findByName(milestones, milestone => milestone.label, name, 'Milestone');
  }

  /**
   * Find a component in a project by name (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {string} projectId - Project id
   * @param {string} name - Component name
   * @returns {Promise<Object>} Component document
   * @throws {Error} When the project has no component with that name
   */
  async _findComponent(client, projectId, name) {
    const components = await client.findAll(tracker.class.Component, { space: projectId });
    return findByName(components, component => component.label, name, 'Component');
  }

  /**
   * Load every issue status in the workspace.
   * @param {Object} client - Huly SDK client
   * @returns {Promise<{statuses: Object[], statusMap: Map<string, string>, doneStatuses: Set<string>}>}
   *   Status documents, id → name, and ids of statuses in the done category
   */
  async _buildStatusMaps(client) {
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));
    const doneStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY)
      .map(s => s._id));
    return { statuses, statusMap, doneStatuses };
  }

  /**
   * Map every task type id to its name.
   * @param {Object} client - Huly SDK client
   * @returns {Promise<Map<string, string>>}
   */
  async _buildTaskTypeMap(client) {
    const taskTypes = await client.findAll(task.class.TaskType, {});
    return new Map(taskTypes.map(t => [t._id, t.name]));
  }

  /**
   * Load active employees and map their ids to names.
   * @param {Object} client - Huly SDK client
   * @returns {Promise<{employees: Object[], employeeMap: Map<string, string>}>}
   */
  async _buildEmployeeMap(client) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));
    return { employees, employeeMap };
  }

  /**
   * All issue labels in the workspace, read fresh so names created or renamed elsewhere are seen at once.
   * @param {Object} client - Huly SDK client
   * @returns {Promise<Object[]>} TagElement documents
   */
  async _issueLabels(client) {
    return await client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue });
  }

  /**
   * Find an issue label by name (case-insensitive).
   * @param {Object} client - Huly SDK client
   * @param {string} labelName - Label title
   * @returns {Promise<Object|null>} TagElement document, or null when no label has that name
   */
  async _findLabelByName(client, labelName) {
    const labels = await this._issueLabels(client);
    return labels.find(label => nameMatch(label.title, labelName)) ?? null;
  }
}
