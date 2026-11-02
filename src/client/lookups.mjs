/**
 * Shared resolvers that turn user-facing names and identifiers into SDK documents and ids.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { DONE_CATEGORY, LOOKUP_CACHE_TTL_MS, nameMatch } from '../helpers.mjs';
import { contactPlugin, tags, task, tracker } from './sdk.mjs';

/**
 * Display name of a task or project type; types created without a name fall back to the last segment of their id.
 * @param {Object} type - TaskType or ProjectType document
 * @returns {string}
 */
export function typeDisplayName(type) {
  return type.name || type._id.split(':').pop();
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
   * Get the default task type for a project from its project type config.
   * Returns the first task type scoped to the project type.
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
   * Statuses in a task type's workflow, in workflow order. Falls back to every workspace status when the
   * task type has no scoped list.
   * @param {Object} client - Huly SDK client
   * @param {string} taskTypeId - Task type id
   * @returns {Promise<Object[]>} IssueStatus documents
   */
  async _getScopedStatuses(client, taskTypeId) {
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found in workspace');

    // Find the task type to get its scoped status list
    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskType = taskTypes.find(tt => tt._id === taskTypeId);

    if (taskType?.statuses?.length) {
      // Preserve workflow order from TaskType.statuses array
      const statusById = new Map(allStatuses.map(s => [s._id, s]));
      const scoped = taskType.statuses.map(id => statusById.get(id)).filter(Boolean);
      if (scoped.length) return scoped;
    }

    return allStatuses;
  }

  async _findEmployeeByName(client, name) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const found = employees.find(e => nameMatch(e.name, name));
    if (!found) {
      throw new Error(`Employee not found: ${name}`);
    }
    return found._id;
  }

  async _findMilestoneByName(client, projectId, name) {
    const ms = await client.findOne(tracker.class.Milestone, {
      space: projectId,
      label: name
    });
    if (!ms) {
      throw new Error(`Milestone not found: ${name}`);
    }
    return ms._id;
  }

  async _findComponentByName(client, projectId, name) {
    const comp = await client.findOne(tracker.class.Component, {
      space: projectId,
      label: name
    });
    if (!comp) {
      throw new Error(`Component not found: ${name}`);
    }
    return comp._id;
  }

  async _buildStatusMaps(client) {
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));
    const doneStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY)
      .map(s => s._id));
    return { statuses, statusMap, doneStatuses };
  }

  async _buildTaskTypeMap(client) {
    const taskTypes = await client.findAll(task.class.TaskType, {});
    return new Map(taskTypes.map(t => [t._id, t.name]));
  }

  async _buildEmployeeMap(client) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));
    return { employees, employeeMap };
  }

  async _findLabelByName(client, labelName) {
    const key = labelName.toLowerCase();
    const cached = this._labelLookupCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });
    const expiresAt = Date.now() + LOOKUP_CACHE_TTL_MS;
    for (const tagElement of tagElements) {
      this._labelLookupCache.set(tagElement.title.toLowerCase(), {
        value: tagElement,
        expiresAt
      });
    }
    const matched = tagElements.find(tagElement => nameMatch(tagElement.title, labelName)) ?? null;
    if (matched) this._labelLookupCache.set(key, { value: matched, expiresAt });
    return matched;
  }
}
