/**
 * Projects: list, get, create, update, archive and delete.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  fromMarkup,
  listEnvelope,
  MILESTONE_STATUS_NAMES,
  nameMatch,
  strictGet,
  withExtra
} from '../helpers.mjs';
import { normalizeIncludeSet } from '../projection.mjs';
import { contactPlugin, core, generateId, tags, task, tracker } from './sdk.mjs';

const PROJECT_INCLUDE_FIELDS = Object.freeze(['milestones', 'components', 'labels', 'members', 'owners', 'defaults']);

/** Group documents by the project space they belong to. */
function groupBySpace(values) {
  const grouped = new Map();
  for (const value of values) {
    if (!grouped.has(value.space)) grouped.set(value.space, []);
    grouped.get(value.space).push(value);
  }
  return grouped;
}

export class ProjectsMethods {
  /**
   * Build output rows for projects, loading only what the requested includes need, in one batch.
   * @param {Object} client - Huly SDK client
   * @param {Object[]} projects - Project documents
   * @param {Set<string>} include - Requested includes (PROJECT_INCLUDE_FIELDS)
   * @param {Object} [options]
   * @param {boolean} [options.ownerCount=false] - Report the owner count when owners are not included
   * @returns {Promise<Object[]>}
   */
  async _projectRows(client, projects, include, { ownerCount = false } = {}) {
    const projectIds = projects.map(project => project._id);
    const any = projectIds.length > 0;
    const needsEmployees = include.has('members') || include.has('owners') || include.has('components');
    const defaultAssignees = include.has('defaults') ? projects.map(p => p.defaultAssignee).filter(Boolean) : [];
    const defaultStatuses = include.has('defaults') ? projects.map(p => p.defaultIssueStatus).filter(Boolean) : [];
    const [milestones, components, labels, employees, assignees, statuses] = await Promise.all([
      include.has('milestones') && any ? client.findAll(tracker.class.Milestone, { space: { $in: projectIds } }) : [],
      include.has('components') && any ? client.findAll(tracker.class.Component, { space: { $in: projectIds } }) : [],
      include.has('labels') && any ? client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue }) : [],
      needsEmployees && any ? client.findAll(contactPlugin.mixin.Employee, { active: true }) : [],
      defaultAssignees.length > 0
        ? client.findAll(contactPlugin.mixin.Employee, { _id: { $in: defaultAssignees } }) : [],
      defaultStatuses.length > 0
        ? client.findAll(tracker.class.IssueStatus, { _id: { $in: defaultStatuses } }) : []
    ]);
    const employeeMap = new Map(employees.map(employee => [employee._id, employee.name]));
    const accountMap = new Map(employees.filter(e => e.personUuid).map(e => [e.personUuid, e.name]));
    const accountName = account => accountMap.get(account) ?? account;
    const assigneeNames = new Map(assignees.map(employee => [employee._id, employee.name]));
    const statusNames = new Map(statuses.map(status => [status._id, status.name]));
    const milestonesByProject = groupBySpace(milestones);
    const componentsByProject = groupBySpace(components);

    return projects.map(project => {
      const row = {
        id: project._id,
        identifier: project.identifier,
        name: project.name || project.identifier,
        description: fromMarkup(project.description),
        archived: project.archived || false,
        private: project.private || false,
        members: project.members?.length || 0,
        ...(ownerCount ? { owners: project.owners?.length || 0 } : {}),
        issueCount: project.sequence || 0,
        createdOn: project.createdOn,
        modifiedOn: project.modifiedOn
      };
      if (include.has('milestones')) {
        row.milestones = (milestonesByProject.get(project._id) || []).map(milestone => ({
          name: milestone.label,
          status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status'),
          targetDate: milestone.targetDate
            ? new Date(milestone.targetDate).toISOString().split('T')[0]
            : null
        }));
      }
      if (include.has('components')) {
        row.components = (componentsByProject.get(project._id) || []).map(component => ({
          name: component.label,
          description: fromMarkup(component.description),
          lead: component.lead ? employeeMap.get(component.lead) ?? null : null
        }));
      }
      if (include.has('labels')) {
        row.labels = labels.map(label => ({ name: label.title, color: label.color ?? null }));
      }
      if (include.has('members')) row.members = (project.members || []).map(accountName);
      if (include.has('owners')) row.owners = (project.owners || []).map(accountName);
      if (include.has('defaults')) {
        row.defaultAssignee = project.defaultAssignee ? assigneeNames.get(project.defaultAssignee) ?? null : null;
        row.defaultIssueStatus = project.defaultIssueStatus ? statusNames.get(project.defaultIssueStatus) ?? null : null;
        row.defaultTimeReportDay = project.defaultTimeReportDay ?? null;
      }
      return withExtra(project, row);
    });
  }

  /**
   * List projects, one cursor page at a time.
   * @param {Object} [options]
   * @param {string[]} [options.include] - Related data to add: milestones, components, labels, members, owners, defaults
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit] - Page size
   * @returns {Promise<{items: Object[], nextCursor?: string}>} List envelope
   */
  async listProjects(options = {}) {
    const client = await this._getClient();
    const projects = await client.findAll(tracker.class.Project, {});

    const include = normalizeIncludeSet(options.include, PROJECT_INCLUDE_FIELDS);
    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_projects',
      include: [...include].sort()
    };
    const page = this._cursoredFindAll(projects, { ...options, cursorScope });
    return listEnvelope(await this._projectRows(client, page.items, include), page.nextCursor);
  }

  /**
   * Get a project by its identifier.
   * @param {string} identifier - Project identifier (e.g., "PROJ")
   * @param {Object} [options]
   * @param {string[]} [options.include] - Related data to add: milestones, components, labels, members, owners, defaults
   * @returns {Promise<Object>}
   */
  async getProject(identifier, options = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, identifier);
    const include = normalizeIncludeSet(options.include, PROJECT_INCLUDE_FIELDS);
    const [row] = await this._projectRows(client, [project], include, { ownerCount: true });
    return row;
  }

  /**
   * The project types that own at least one tracker task type. A workspace with
   * HR or CRM modules also carries vacancy and funnel types, which cannot hold
   * issues and are never candidates for a project created through this server.
   * @param {Object} client - Connected SDK client
   * @param {Object[]} projectTypes - Candidate project types
   * @returns {Promise<Object[]>}
   */
  async _trackerProjectTypes(client, projectTypes) {
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const trackerTaskTypeIds = new Set(
      allTaskTypes
        .filter(tt => tt.ofClass === tracker.class.Issue || tt.targetClass === tracker.class.Issue)
        .map(tt => tt._id)
    );
    return projectTypes.filter(pt => (pt.tasks ?? []).some(id => trackerTaskTypeIds.has(id)));
  }

  async createProject(identifier, name, description, isPrivate = false, projectType, options = {}) {
    const client = await this._getClient();

    identifier = identifier.toUpperCase();
    const existing = await client.findOne(tracker.class.Project, { identifier });
    if (existing) {
      throw new Error(`Project with identifier "${identifier}" already exists`);
    }

    // Resolve project type first — needed to scope statuses
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    if (!projectTypes.length) {
      throw new Error('No project types found in workspace. Configure project types in workspace settings first.');
    }
    let resolvedProjectType;
    if (projectType) {
      resolvedProjectType = projectTypes.find(pt =>
        (pt.name && pt.name.toLowerCase() === projectType.toLowerCase()) || pt._id === projectType
      );
      if (!resolvedProjectType) {
        const available = projectTypes.map(pt => pt.name || pt._id).join(', ');
        throw new Error(`Project type "${projectType}" not found. Available: ${available}`);
      }
    } else if (projectTypes.length === 1) {
      resolvedProjectType = projectTypes[0];
    } else {
      // A workspace with HR or CRM modules carries vacancy and funnel types
      // alongside the tracker's. This server creates tracker projects, so those
      // are not real candidates. Narrow to the types that own a tracker task
      // type; only refuse when the remaining choice is genuinely the caller's.
      const trackerTypes = await this._trackerProjectTypes(client, projectTypes);
      if (trackerTypes.length === 1) {
        resolvedProjectType = trackerTypes[0];
      } else {
        const candidates = trackerTypes.length > 1 ? trackerTypes : projectTypes;
        const available = candidates.map(pt => pt.name || pt._id).join(', ');
        throw new Error(`Multiple project types found: ${available}. Specify projectType explicitly.`);
      }
    }

    // Scope default status to the resolved ProjectType's task types
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found for project');
    let defaultStatusId;
    if (resolvedProjectType.statuses?.length) {
      const ptStatusIds = new Set(resolvedProjectType.statuses.map(s => s.taskType ? s._id : s));
      const scopedStatuses = allStatuses.filter(s => ptStatusIds.has(s._id));
      const todoStatus = scopedStatuses.find(s => s.name === 'Todo') || scopedStatuses[0];
      defaultStatusId = todoStatus?._id || allStatuses.find(s => s.name === 'Todo')?._id || allStatuses[0]._id;
    } else {
      defaultStatusId = allStatuses.find(s => s.name === 'Todo')?._id || allStatuses[0]._id;
    }

    if (!this._accountUuid) {
      throw new Error('Cannot create project: authenticated account UUID is unavailable');
    }

    // Huly's project creation flow always makes the creator both a member and
    // an owner. Private spaces are invisible when owners is populated but
    // members is empty.
    const access = await this._projectUpdateFields(client, {
      identifier, type: resolvedProjectType._id, private: isPrivate,
      members: [this._accountUuid], owners: [this._accountUuid]
    }, options);
    // A newly created project must remain accessible to its creator.
    const members = [...new Set([this._accountUuid, ...(access.members ?? []), ...(access.owners ?? [])])];
    const owners = [...new Set([this._accountUuid, ...(access.owners ?? [])])];

    const projectId = generateId();
    let projectCreated = false;

    try {
      await client.createDoc(tracker.class.Project, core.space.Space, {
        identifier,
        name: name || identifier,
        description: description || '',
        private: isPrivate,
        archived: false,
        autoJoin: !isPrivate,
        sequence: 0,
        defaultIssueStatus: defaultStatusId,
        defaultTimeReportDay: 'CurrentWorkDay',
        type: resolvedProjectType._id,
        ...access,
        members,
        owners
      }, projectId);
      projectCreated = true;

      // Project types may define a mixin for role assignments and custom
      // fields. Match Huly's canonical creation flow even when no roles have
      // been assigned yet.
      if (resolvedProjectType.targetClass) {
        await client.createMixin(
          projectId,
          tracker.class.Project,
          core.space.Space,
          resolvedProjectType.targetClass,
          {}
        );
      }

      // Never report success for a project the creating identity cannot read.
      const createdProject = await client.findOne(tracker.class.Project, { identifier });
      if (!createdProject || createdProject._id !== projectId) {
        throw new Error('project is not readable by the creating account');
      }
      if (!createdProject.members?.includes(this._accountUuid) ||
          !createdProject.owners?.includes(this._accountUuid)) {
        throw new Error('creator membership or ownership was not persisted');
      }
    } catch (error) {
      if (!projectCreated) throw error;

      let rollbackError;
      try {
        await client.removeDoc(tracker.class.Project, core.space.Space, projectId);
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }

      const reason = error instanceof Error ? error.message : String(error);
      if (rollbackError) {
        const cleanupReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Project "${identifier}" creation failed after write (${reason}); ` +
          `automatic rollback failed (${cleanupReason}). Manual cleanup may be required for internal ID ${projectId}.`,
          { cause: error }
        );
      }

      throw new Error(
        `Project "${identifier}" creation failed after write (${reason}); partial project was rolled back.`,
        { cause: error }
      );
    }

    return {
      id: projectId,
      identifier,
      name: name || identifier,
      description: description || '',
      private: isPrivate
    };
  }

  /**
   * Update project fields, defaults, membership, or ownership.
   * @param {string} projectIdent - Project identifier
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateProject(projectIdent, updates = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const ops = await this._projectUpdateFields(client, project, updates);
    if (updates.name !== undefined) ops.name = updates.name;
    if (updates.description !== undefined) ops.description = updates.description;
    if (updates.isPrivate !== undefined) ops.private = updates.isPrivate;

    if (Object.keys(ops).length === 0) {
      return { message: 'No updates specified', identifier: project.identifier };
    }

    const removed = new Set((project.members ?? []).filter(account => ops.members && !ops.members.includes(account)));
    const projectType = removed.size > 0 && project.type
      ? await client.findOne(task.class.ProjectType, { _id: project.type }) : null;
    const roleUpdates = {};
    if (projectType?.targetClass) {
      const roles = await client.findAll(core.class.Role, { attachedTo: project.type });
      const assignments = project[projectType.targetClass] ?? {};
      for (const role of roles) {
        const assigned = assignments[role._id] ?? [];
        const remaining = assigned.filter(account => !removed.has(account));
        if (remaining.length !== assigned.length) roleUpdates[role._id] = remaining;
      }
    }
    if (Object.keys(roleUpdates).length > 0) {
      const transaction = client.apply(project._id);
      await transaction.updateDoc(tracker.class.Project, project.space, project._id, ops);
      await transaction.updateMixin(project._id, tracker.class.Project, project.space, projectType.targetClass, roleUpdates);
      if (!(await transaction.commit()).result) throw new Error('Project membership update failed');
    } else {
      await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, ops);
    }

    return {
      message: `Project ${projectIdent} updated`,
      identifier: project.identifier,
      updated: Object.keys(ops)
    };
  }

  async _projectUpdateFields(client, project, updates) {
    const ops = {};
    if (updates.defaultAssignee !== undefined) {
      ops.defaultAssignee = updates.defaultAssignee.trim() === '' ? null
        : await this._findEmployeeByName(client, updates.defaultAssignee);
    }
    if (updates.defaultIssueStatus !== undefined) {
      const kind = await this._getDefaultTaskType(client, project);
      const statuses = await this._getScopedStatuses(client, kind);
      const status = statuses.find(s => s._id === updates.defaultIssueStatus || nameMatch(s.name, updates.defaultIssueStatus));
      if (!status) throw new Error(`Default issue status not found in project workflow: ${updates.defaultIssueStatus}`);
      ops.defaultIssueStatus = status._id;
    }
    if (updates.defaultTimeReportDay !== undefined) {
      if (!['CurrentWorkDay', 'PreviousWorkDay'].includes(updates.defaultTimeReportDay)) {
        throw new Error('defaultTimeReportDay must be CurrentWorkDay or PreviousWorkDay');
      }
      ops.defaultTimeReportDay = updates.defaultTimeReportDay;
    }
    for (const field of ['members', 'owners']) {
      if (updates[field] !== undefined) {
        ops[field] = (await this._resolveAccountMembers(client, updates[field], field)).map(member => member.account);
      }
    }
    if (ops.owners !== undefined && ops.members === undefined) {
      ops.members = [...new Set([...(project.members ?? []), ...ops.owners])];
    }
    if (ops.members !== undefined || ops.owners !== undefined || updates.isPrivate !== undefined) {
      const members = ops.members ?? project.members ?? [];
      const owners = ops.owners ?? project.owners ?? [];
      if (owners.length === 0) throw new Error('A project must retain at least one owner');
      if ((updates.isPrivate ?? project.private) && !owners.some(owner => members.includes(owner))) {
        throw new Error('A private project must retain an owner who is also a member');
      }
    }
    return ops;
  }

  async archiveProject(projectIdent, archived = true) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent, { showArchived: true });

    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      archived
    });

    return {
      message: archived ? `Project ${projectIdent} archived` : `Project ${projectIdent} unarchived`,
      identifier: project.identifier,
      id: project._id,
      archived
    };
  }

  async deleteProject(projectIdent) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    await client.removeDoc(tracker.class.Project, project.space || project._id, project._id);

    return {
      message: `Project ${projectIdent} permanently deleted`,
      identifier: project.identifier
    };
  }
}
