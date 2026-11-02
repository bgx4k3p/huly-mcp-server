/**
 * Workflow configuration: task types, project types and statuses.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, nameMatch, STATUS_CATEGORY_NAMES, withExtra } from '../helpers.mjs';
import { findByName, typeDisplayName } from './lookups.mjs';
import { task, tracker } from './sdk.mjs';

/**
 * Output row for a task type.
 * @param {Object} taskType - TaskType document
 * @returns {Object}
 */
function taskTypeRow(taskType) {
  return withExtra(taskType, {
    id: taskType._id,
    name: typeDisplayName(taskType),
    description: fromMarkup(taskType.description),
    kind: taskType.kind || null,
    ofClass: taskType.ofClass,
    parent: taskType.parent,
    allowedAsChildOf: taskType.allowedAsChildOf || [],
    statusCategories: taskType.statusCategories || [],
    statuses: taskType.statuses || []
  });
}

export class WorkflowMethods {
  /**
   * Task types a project offers: those of its project type, or every issue task type when the project type
   * declares none.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @returns {Promise<Object[]>} TaskType documents
   */
  async _issueTaskTypes(client, project) {
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const projectType = await this._projectType(client, project);
    if (projectType?.tasks) {
      const taskTypeIds = new Set(projectType.tasks);
      return allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    }
    return allTaskTypes.filter(tt =>
      tt.ofClass === tracker.class.Issue ||
      tt.targetClass === tracker.class.Issue
    );
  }

  /**
   * List the task types a project offers, one cursor page at a time.
   * @param {string} projectIdent - Project identifier
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the project is not found, or the limit or cursor is invalid
   */
  async listTaskTypes(projectIdent, options = {}) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    const typesToReturn = await this._issueTaskTypes(client, project);

    return this._cursoredFindAll(typesToReturn.map(taskTypeRow), {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_task_types', project: projectIdent.toUpperCase() }
    });
  }

  /**
   * List the project types configured in the workspace, one cursor page at a time. These are the valid
   * values for the `projectType` argument of createProject; each row names the task types it owns.
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the limit or cursor is invalid
   */
  async listProjectTypes(options = {}) {
    const client = await this._getClient();

    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeById = new Map(allTaskTypes.map(tt => [tt._id, tt]));

    const enriched = projectTypes.map(pt => withExtra(pt, {
      id: pt._id,
      name: typeDisplayName(pt),
      description: fromMarkup(pt.description) || pt.shortDescription || null,
      taskTypes: (pt.tasks || [])
        .map(id => taskTypeById.get(id))
        .filter(Boolean)
        .map(typeDisplayName)
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_project_types' }
    });
  }

  /**
   * List available issue statuses, optionally scoped to a project or task type.
   * @param {string} [projectIdent] - Project identifier to scope statuses
   * @param {string} [taskTypeName] - Task type name to scope statuses, case-insensitive (e.g., "Task", "Epic")
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the project, its project type, or the task type is not found, or the limit or cursor is
   *   invalid
   */
  async listStatuses(projectIdent, taskTypeName, options = {}) {
    const client = await this._getClient();
    const rows = await this._statusRows(client, projectIdent, taskTypeName);
    return this._cursoredFindAll(rows, {
      ...options,
      cursorScope: {
        workspace: this.workspace,
        tool: 'list_statuses',
        project: projectIdent?.toUpperCase() ?? null,
        taskType: taskTypeName?.toLowerCase() ?? null
      }
    });
  }

  /**
   * Every status row in scope: all workspace statuses, or those of a project's task types, optionally narrowed
   * to one task type.
   * @param {Object} client - Huly SDK client
   * @param {string} [projectIdent] - Project identifier to scope statuses
   * @param {string} [taskTypeName] - Task type name to scope statuses (case-insensitive)
   * @returns {Promise<Object[]>} Status rows
   * @throws {Error} When the project, its project type, or the task type is not found
   */
  async _statusRows(client, projectIdent, taskTypeName) {
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    // withExtra carries the source doc's createdOn, which the cursor tuple sorts on. Without it these rows
    // tuple to 0 and ordering silently degenerates to id-descending. Compact output strips extra entirely.
    const statusRow = status => withExtra(status, {
      id: status._id,
      name: status.name,
      category: STATUS_CATEGORY_NAMES[status.category] || status.category,
      color: status.color,
      description: fromMarkup(status.description)
    });
    if (!projectIdent && !taskTypeName) return allStatuses.map(statusRow);

    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    let relevantTaskTypes = allTaskTypes;

    if (projectIdent) {
      const project = await this._findProject(client, projectIdent);
      const projectType = await this._projectType(client, project);
      // An unresolvable project type is a data problem, not a licence to return
      // every status in the workspace as though it were project-scoped. A type
      // that simply declares no task types legitimately scopes to nothing.
      if (!projectType) {
        throw new Error(`Project type not found for project ${projectIdent}`);
      }
      const taskTypeIds = new Set(projectType.tasks ?? []);
      relevantTaskTypes = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    }

    // An unknown task type name must fail rather than fall through to the unscoped status list.
    if (taskTypeName) {
      relevantTaskTypes = relevantTaskTypes.filter(tt => nameMatch(tt.name, taskTypeName));
      if (relevantTaskTypes.length === 0) {
        throw new Error(`Task type not found: ${taskTypeName}`);
      }
    }

    const statusIds = new Set(relevantTaskTypes.flatMap(tt => tt.statuses ?? []));
    return allStatuses.filter(status => statusIds.has(status._id)).map(statusRow);
  }

  /**
   * Get a status by name within a project, searching all of the project's statuses.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Status name (case-insensitive exact match)
   * @returns {Promise<Object>} Status row
   * @throws {Error} When the project or status is not found; the message lists available statuses
   */
  async getStatus(projectIdent, name) {
    const client = await this._getClient();
    const rows = await this._statusRows(client, projectIdent);
    const status = rows.find(row => nameMatch(row.name, name));
    if (!status) {
      throw new Error(`Status not found: "${name}". Available: ${rows.map(row => row.name).join(', ')}`);
    }
    return status;
  }

  /**
   * Get a task type the project offers by name.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Task type name (case-insensitive exact match on the stored name)
   * @returns {Promise<Object>} Task type row
   * @throws {Error} When the project or task type is not found; the message lists available types
   */
  async getTaskType(projectIdent, name) {
    const client = await this._getClient();

    const project = await this._findProject(client, projectIdent);

    const typesToSearch = await this._issueTaskTypes(client, project);

    return taskTypeRow(findByName(typesToSearch, typeDisplayName, name, 'Task type'));
  }
}
