/**
 * Workflow configuration: task types, project types and statuses.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, nameMatch, STATUS_CATEGORY_NAMES, withExtra } from '../helpers.mjs';
import { task, tracker } from './sdk.mjs';

export class WorkflowMethods {
  /**
   * List all available task types for a project.
   * @param {string} projectIdent - Project identifier
   * @returns {Promise<Object[]>}
   */
  async listTaskTypes(projectIdent, options = {}) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    // Scope task types to project via its ProjectType
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);

    let typesToReturn;
    if (projectType && projectType.tasks) {
      // Return only task types belonging to this project's type
      const taskTypeIds = new Set(projectType.tasks);
      typesToReturn = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    } else {
      // Fallback: return tracker-related task types
      typesToReturn = allTaskTypes.filter(tt =>
        tt.ofClass === tracker.class.Issue ||
        tt.targetClass === tracker.class.Issue
      );
    }

    const enriched = typesToReturn.map(tt => withExtra(tt, {
      id: tt._id,
      name: tt.name || tt._id.split(':').pop(),
      description: fromMarkup(tt.description),
      kind: tt.kind || null,
      ofClass: tt.ofClass,
      parent: tt.parent,
      allowedAsChildOf: tt.allowedAsChildOf || [],
      statusCategories: tt.statusCategories || [],
      statuses: tt.statuses || []
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_task_types', project: projectIdent.toUpperCase() }
    });
  }

  /**
   * List the project types configured in the workspace. These are the valid
   * values for the `projectType` argument of createProject. Returns the names
   * of the task types scoped to each, for convenience.
   * @returns {Promise<Object>} { items, nextCursor? }
   */
  async listProjectTypes(options = {}) {
    const client = await this._getClient();

    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeById = new Map(allTaskTypes.map(tt => [tt._id, tt]));

    const enriched = projectTypes.map(pt => withExtra(pt, {
      id: pt._id,
      name: pt.name || pt._id.split(':').pop(),
      description: fromMarkup(pt.description) || pt.shortDescription || null,
      taskTypes: (pt.tasks || [])
        .map(id => taskTypeById.get(id))
        .filter(Boolean)
        .map(tt => tt.name || tt._id.split(':').pop())
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_project_types' }
    });
  }

  /**
   * List available issue statuses, optionally scoped to a project or task type.
   * @param {string} [projectIdent] - Project identifier to scope statuses
   * @param {string} [taskTypeName] - Task type name to scope statuses (e.g., "Task", "Epic")
   * @returns {Promise<Object[]>}
   */
  async listStatuses(projectIdent, taskTypeName, options = {}) {
    const client = await this._getClient();

    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});

    // If no scoping requested, return all
    if (!projectIdent && !taskTypeName) {
      // withExtra carries the source doc's createdOn, which the cursor tuple
      // sorts on. Without it these rows tuple to 0 and ordering silently
      // degenerates to id-descending. Compact output strips extra entirely.
      const enriched = allStatuses.map(s => withExtra(s, {
        id: s._id,
        name: s.name,
        category: STATUS_CATEGORY_NAMES[s.category] || s.category,
        color: s.color,
        description: fromMarkup(s.description)
      }));
      return this._cursoredFindAll(enriched, {
        ...options,
        cursorScope: { workspace: this.workspace, tool: 'list_statuses', project: null, taskType: null }
      });
    }

    // Get task types scoped to this project
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    let relevantTaskTypes = allTaskTypes;

    if (projectIdent) {
      const project = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (!project) throw new Error(`Project not found: ${projectIdent}`);
      const projectTypes = await client.findAll(task.class.ProjectType, {});
      const projectType = projectTypes.find(pt => pt._id === project.type);
      // An unresolvable project type is a data problem, not a licence to return
      // every status in the workspace as though it were project-scoped. A type
      // that simply declares no task types legitimately scopes to nothing.
      if (!projectType) {
        throw new Error(`Project type not found for project ${projectIdent}`);
      }
      const taskTypeIds = new Set(projectType.tasks ?? []);
      relevantTaskTypes = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    }

    // Further filter by task type name. An unknown name must fail rather than
    // fall through to the unscoped status list below.
    if (taskTypeName) {
      relevantTaskTypes = relevantTaskTypes.filter(tt => nameMatch(tt.name, taskTypeName));
      if (relevantTaskTypes.length === 0) {
        throw new Error(`Task type not found: ${taskTypeName}`);
      }
    }

    // Collect status IDs from matching task types
    const statusIds = new Set();
    for (const tt of relevantTaskTypes) {
      if (tt.statuses) {
        for (const sid of tt.statuses) {
          statusIds.add(sid);
        }
      }
    }

    // Filter statuses to only those in scope
    const scopedStatuses = allStatuses.filter(s => statusIds.has(s._id));

    const enriched = scopedStatuses.map(s => withExtra(s, {
      id: s._id,
      name: s.name,
      category: STATUS_CATEGORY_NAMES[s.category] || s.category,
      color: s.color,
      description: s.description || ''
    }));
    return this._cursoredFindAll(enriched, {
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
   * Find a status by name within a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Status name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getStatus(projectIdent, name) {
    const result = await this.listStatuses(projectIdent);
    const status = result.items.find(s => nameMatch(s.name, name));
    if (!status) {
      const names = result.items.map(s => s.name).join(', ');
      throw new Error(`Status not found: "${name}". Available: ${names}`);
    }
    return status;
  }

  /**
   * Find a task type by name in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Task type name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getTaskType(projectIdent, name) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);

    let typesToSearch;
    if (projectType && projectType.tasks) {
      const taskTypeIds = new Set(projectType.tasks);
      typesToSearch = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    } else {
      typesToSearch = allTaskTypes.filter(tt =>
        tt.ofClass === tracker.class.Issue ||
        tt.targetClass === tracker.class.Issue
      );
    }

    const found = typesToSearch.find(tt => nameMatch(tt.name, name));
    if (!found) {
      const names = typesToSearch.map(tt => tt.name || tt._id.split(':').pop()).join(', ');
      throw new Error(`Task type not found: "${name}". Available: ${names}`);
    }

    return withExtra(found, {
      id: found._id,
      name: found.name || found._id.split(':').pop(),
      kind: found.kind || null,
      ofClass: found.ofClass || null,
      allowedAsChildOf: found.allowedAsChildOf || [],
      statusCategories: found.statusCategories || [],
      statuses: found.statuses || []
    });
  }
}
