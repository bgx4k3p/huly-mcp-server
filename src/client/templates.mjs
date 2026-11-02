/**
 * Issue templates stored in Huly, and the predefined issue-set generator.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  fromMarkup,
  listEnvelope,
  parseHours,
  PRIORITY_MAP,
  PRIORITY_NAMES,
  strictGet,
  toHours,
  toMarkup,
  withExtra
} from '../helpers.mjs';
import { contactPlugin, generateId, tags, task, tracker } from './sdk.mjs';

export class TemplatesMethods {
  /**
   * Find an issue template by ID within a project.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {string} templateId - Template ID
   * @returns {Promise<Object>} Template document
   * @throws {Error} When the template is not in the project
   */
  async _findIssueTemplate(client, project, templateId) {
    const template = await client.findOne(tracker.class.IssueTemplate, { _id: templateId, space: project._id });
    if (!template) throw new Error(`Issue template not found in ${project.identifier}: ${templateId}`);
    return template;
  }

  /**
   * Validate and resolve template fields (excluding children and relations) into document data.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {Object} input - Template fields
   * @param {string} [input.title] - Title (required on create)
   * @param {string} [input.description] - Description
   * @param {string} [input.descriptionFormat='markdown'] - Description format: markdown, html, or plain
   * @param {string} [input.priority] - Priority name: none, urgent, high, medium, low
   * @param {number|string} [input.estimation] - Estimated hours; must be a non-negative number
   * @param {string} [input.assignee] - Assignee name; empty clears it
   * @param {string} [input.component] - Component name (exact); empty clears it
   * @param {string} [input.milestone] - Milestone name (exact); empty clears it
   * @param {string} [input.type] - Task type name; empty selects the project default
   * @param {string[]} [input.labels] - Existing label names (case-insensitive)
   * @param {boolean} [create=false] - Start from creation defaults and require a title
   * @returns {Promise<Object>} Document fields; `type` is stored as `kind`
   * @throws {Error} When a field is invalid or a referenced name is not found
   */
  async _templateData(client, project, input, create = false) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new Error('Template fields must be an object');
    }
    const data = create ? {
      title: '', description: toMarkup(''), priority: 0, assignee: null,
      component: null, milestone: null, estimation: 0, labels: []
    } : {};
    if (create || input.title !== undefined) {
      if (typeof input.title !== 'string' || !input.title.trim()) throw new Error('Template title must not be empty');
      data.title = input.title.trim();
    }
    if (input.description !== undefined) data.description = toMarkup(input.description, input.descriptionFormat);
    if (input.priority !== undefined) {
      const priority = PRIORITY_MAP[input.priority.toLowerCase()];
      if (priority === undefined) throw new Error(`Unknown template priority: ${input.priority}`);
      data.priority = priority;
    }
    if (input.estimation !== undefined) data.estimation = parseHours(input.estimation, 'estimation');
    for (const [field, resolve] of [
      ['assignee', value => this._findEmployeeByName(client, value)],
      ['component', async value => (await this._findComponent(client, project._id, value))._id],
      ['milestone', async value => (await this._findMilestone(client, project._id, value))._id]
    ]) {
      if (input[field] !== undefined) data[field] = input[field].trim() === '' ? null : await resolve(input[field]);
    }
    if (input.type !== undefined) {
      data.kind = input.type.trim() === '' ? await this._getDefaultTaskType(client, project)
        : await this._findTaskTypeByName(client, project, input.type);
    }
    if (input.labels !== undefined) {
      if (!Array.isArray(input.labels)) throw new Error('Template labels must be an array');
      data.labels = [];
      for (const name of input.labels) {
        const label = await this._findLabelByName(client, name);
        if (!label) throw new Error(`Label not found: ${name}`);
        if (!data.labels.includes(label._id)) data.labels.push(label._id);
      }
    }
    return data;
  }

  /**
   * Validate and resolve template fields, children and relations into document data.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {Object} input - Template fields (see `_templateData`) plus `children` and `relations`
   * @param {boolean} [create=false] - Apply creation defaults, including empty children and relations
   * @returns {Promise<Object>} Document fields to write
   * @throws {Error} When a field, child, or relation is invalid or not found
   */
  async _templateUpdates(client, project, input, create = false) {
    const data = await this._templateData(client, project, input, create);
    if (create || input.children !== undefined) {
      const children = input.children === undefined ? [] : input.children;
      if (!Array.isArray(children) || children.length > 50) {
        throw new Error('Template children must be an array of at most 50 items');
      }
      const ids = new Set();
      data.children = [];
      for (const child of children) {
        if (!child || typeof child !== 'object' || Array.isArray(child)) throw new Error('Child template must be an object');
        const allowed = new Set(['id', 'title', 'description', 'descriptionFormat', 'priority', 'assignee',
          'component', 'milestone', 'estimation', 'labels', 'type']);
        for (const key of Object.keys(child)) {
          if (!allowed.has(key)) throw new Error(`Unsupported child-template field: ${key}`);
        }
        const id = child.id ?? generateId();
        if (typeof id !== 'string' || !id.trim() || ids.has(id)) throw new Error('Template child IDs must be non-empty and unique');
        ids.add(id);
        data.children.push({ ...await this._templateData(client, project, child, true), id });
      }
    }
    if (create || input.relations !== undefined) {
      const relations = input.relations === undefined ? [] : input.relations;
      if (!Array.isArray(relations)) throw new Error('Template relations must be an array');
      data.relations = [];
      for (const relation of relations) {
        if (!relation || typeof relation.id !== 'string' || !relation.id.trim() ||
            typeof relation.objectClass !== 'string' || !relation.objectClass.trim()) {
          throw new Error('Template relations require a non-empty id and objectClass');
        }
        const target = await client.findOne(relation.objectClass, { _id: relation.id });
        if (!target) throw new Error(`Related document not found: ${relation.id}`);
        if (!data.relations.some(r => r._id === target._id)) {
          data.relations.push({ _id: target._id, _class: target._class });
        }
      }
    }
    return data;
  }

  /**
   * Build output rows for issue templates, resolving IDs to names in one batch.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project document
   * @param {Object[]} templates - Template documents
   * @returns {Promise<Object[]>} Template rows, in input order
   */
  async _readIssueTemplates(client, project, templates) {
    if (templates.length === 0) return [];
    const [employees, components, milestones, labels, types] = await Promise.all([
      client.findAll(contactPlugin.mixin.Employee, {}),
      client.findAll(tracker.class.Component, { space: project._id }),
      client.findAll(tracker.class.Milestone, { space: project._id }),
      client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue }),
      client.findAll(task.class.TaskType, {})
    ]);
    const maps = [employees, components, milestones, labels, types].map(docs => new Map(docs.map(doc => [doc._id, doc])));
    const read = doc => ({
      title: doc.title, description: fromMarkup(doc.description),
      priority: strictGet(PRIORITY_NAMES, doc.priority, 'Priority'),
      assignee: doc.assignee ? maps[0].get(doc.assignee)?.name ?? doc.assignee : null,
      component: doc.component ? maps[1].get(doc.component)?.label ?? doc.component : null,
      milestone: doc.milestone ? maps[2].get(doc.milestone)?.label ?? doc.milestone : null,
      estimation: toHours(doc.estimation),
      labels: (doc.labels ?? []).map(id => maps[3].get(id)?.title ?? id),
      type: doc.kind ? maps[4].get(doc.kind)?.name ?? doc.kind : null
    });
    return templates.map(template => withExtra(template, {
      id: template._id, project: project.identifier, ...read(template),
      children: (template.children ?? []).map(child => ({ id: child.id, ...read(child) })),
      relations: (template.relations ?? []).map(r => ({ id: r._id, objectClass: r._class })),
      comments: template.comments ?? 0, attachments: template.attachments ?? 0
    }));
  }

  /**
   * List issue templates stored in a project, one cursor page at a time.
   * @param {string} projectIdent - Project identifier
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the project is not found, or the limit or cursor is invalid
   */
  async listIssueTemplates(projectIdent, options = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const templates = await client.findAll(tracker.class.IssueTemplate, { space: project._id });
    const page = this._cursoredFindAll(templates, {
      ...options, cursorScope: { workspace: this.workspace, tool: 'list_issue_templates', project: project.identifier }
    });
    return listEnvelope(await this._readIssueTemplates(client, project, page.items), page.nextCursor);
  }

  /**
   * Get an issue template by ID.
   * @param {string} projectIdent - Project identifier
   * @param {string} templateId - Template ID
   * @returns {Promise<Object>} Template row with children and relations
   * @throws {Error} When the project or template is not found
   */
  async getIssueTemplate(projectIdent, templateId) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const template = await this._findIssueTemplate(client, project, templateId);
    return (await this._readIssueTemplates(client, project, [template]))[0];
  }

  /**
   * Create an issue template in a project.
   * @param {string} projectIdent - Project identifier
   * @param {Object} input - Template fields; `title` is required
   * @param {string} [input.title] - Title (required on create)
   * @param {string} [input.description] - Description
   * @param {string} [input.descriptionFormat='markdown'] - Description format: markdown, html, or plain
   * @param {string} [input.priority] - Priority name: none, urgent, high, medium, low
   * @param {number|string} [input.estimation] - Estimated hours; must be a non-negative number
   * @param {string} [input.assignee] - Assignee name; empty clears it
   * @param {string} [input.component] - Component name (exact); empty clears it
   * @param {string} [input.milestone] - Milestone name (exact); empty clears it
   * @param {string} [input.type] - Task type name; empty selects the project default
   * @param {string[]} [input.labels] - Existing label names (case-insensitive)
   * @param {Object[]} [input.children] - Child templates (at most 50): the same fields plus an optional unique `id`;
   *   replaces the existing list
   * @param {{id: string, objectClass: string}[]} [input.relations] - Related documents; replaces the existing list
   * @returns {Promise<{id: string, project: string, title: string}>}
   * @throws {Error} When the project is not found or a field is invalid
   */
  async createIssueTemplate(projectIdent, input = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const data = await this._templateUpdates(client, project, input, true);
    const id = generateId();
    await client.createDoc(tracker.class.IssueTemplate, project._id, { ...data, comments: 0, attachments: 0 }, id);
    return { id, project: project.identifier, title: data.title };
  }

  /**
   * Update an issue template. Omitted fields are left unchanged.
   * @param {string} projectIdent - Project identifier
   * @param {string} templateId - Template ID
   * @param {Object} [input] - Fields to update
   * @param {string} [input.title] - Title (required on create)
   * @param {string} [input.description] - Description
   * @param {string} [input.descriptionFormat='markdown'] - Description format: markdown, html, or plain
   * @param {string} [input.priority] - Priority name: none, urgent, high, medium, low
   * @param {number|string} [input.estimation] - Estimated hours; must be a non-negative number
   * @param {string} [input.assignee] - Assignee name; empty clears it
   * @param {string} [input.component] - Component name (exact); empty clears it
   * @param {string} [input.milestone] - Milestone name (exact); empty clears it
   * @param {string} [input.type] - Task type name; empty selects the project default
   * @param {string[]} [input.labels] - Existing label names (case-insensitive)
   * @param {Object[]} [input.children] - Child templates (at most 50): the same fields plus an optional unique `id`;
   *   replaces the existing list
   * @param {{id: string, objectClass: string}[]} [input.relations] - Related documents; replaces the existing list
   * @returns {Promise<{id: string, updated: string[]}>}
   * @throws {Error} When the project or template is not found or a field is invalid
   */
  async updateIssueTemplate(projectIdent, templateId, input = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const template = await this._findIssueTemplate(client, project, templateId);
    const data = await this._templateUpdates(client, project, input);
    if (Object.keys(data).length > 0) {
      await client.updateDoc(tracker.class.IssueTemplate, project._id, template._id, data);
    }
    return { id: template._id, updated: Object.keys(data).map(key => key === 'kind' ? 'type' : key) };
  }

  /**
   * Delete an issue template.
   * @param {string} projectIdent - Project identifier
   * @param {string} templateId - Template ID
   * @returns {Promise<{id: string, message: string}>}
   * @throws {Error} When the project or template is not found
   */
  async deleteIssueTemplate(projectIdent, templateId) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const template = await this._findIssueTemplate(client, project, templateId);
    await client.removeDoc(tracker.class.IssueTemplate, project._id, template._id);
    return { id: template._id, message: `Issue template "${template.title}" deleted` };
  }

  /**
   * Create a set of issues from a predefined generator (feature, bug, sprint, release), linking children to
   * their parent. Unrelated to the issue templates stored in Huly. An unknown generator name returns
   * `{ error, availableTemplates }` instead of throwing.
   * @param {string} projectIdent - Project identifier
   * @param {string} templateName - Generator name (case-insensitive)
   * @param {Object} [params] - Substitution values
   * @param {string} [params.title] - Title inserted into each issue title
   * @param {string} [params.version] - Release version, used by the release generator when no title is given
   * @returns {Promise<Object>} `{ template, description, created, errors, total }`; errors lists failed parent links
   */
  async createIssuesFromTemplate(projectIdent, templateName, params = {}) {
    const client = await this._getClient();
    const templates = {
      'feature': {
        description: 'Standard feature development workflow',
        issues: [
          { title: `[Feature] ${params.title || 'New Feature'}`, type: 'Epic', children: [
            { title: `Design: ${params.title || 'New Feature'}`, priority: 'high', labels: ['design'] },
            { title: `Implement: ${params.title || 'New Feature'}`, priority: 'high', labels: ['development'] },
            { title: `Write tests: ${params.title || 'New Feature'}`, priority: 'medium', labels: ['testing'] },
            { title: `Documentation: ${params.title || 'New Feature'}`, priority: 'low', labels: ['docs'] },
            { title: `Code review: ${params.title || 'New Feature'}`, priority: 'medium', labels: ['review'] }
          ]}
        ]
      },
      'bug': {
        description: 'Bug investigation and fix workflow',
        issues: [
          { title: `[Bug] ${params.title || 'Bug Report'}`, type: 'Bug', children: [
            { title: `Reproduce: ${params.title || 'Bug'}`, priority: 'high' },
            { title: `Root cause analysis: ${params.title || 'Bug'}`, priority: 'high' },
            { title: `Fix: ${params.title || 'Bug'}`, priority: 'urgent' },
            { title: `Regression test: ${params.title || 'Bug'}`, priority: 'medium', labels: ['testing'] }
          ]}
        ]
      },
      'sprint': {
        description: 'Sprint planning template with ceremonies',
        issues: [
          { title: `Sprint Planning: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] },
          { title: `Daily Standup Notes: ${params.title || 'Sprint'}`, priority: 'medium', labels: ['ceremony'] },
          { title: `Sprint Review: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] },
          { title: `Sprint Retrospective: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] }
        ]
      },
      'release': {
        description: 'Release checklist',
        issues: [
          { title: `[Release] ${params.title || params.version || 'Release'}`, type: 'Epic', children: [
            { title: `Feature freeze: ${params.title || params.version || 'Release'}`, priority: 'urgent' },
            { title: `QA sign-off: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['testing'] },
            { title: `Update changelog: ${params.title || params.version || 'Release'}`, priority: 'high', labels: ['docs'] },
            { title: `Deploy to staging: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] },
            { title: `Production deploy: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] },
            { title: `Post-deploy verification: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] }
          ]}
        ]
      }
    };

    const template = templates[templateName.toLowerCase()];
    if (!template) {
      return {
        error: `Unknown template: "${templateName}"`,
        availableTemplates: Object.entries(templates).map(([name, t]) => ({
          name,
          description: t.description
        }))
      };
    }

    const allCreated = [];
    const errors = [];

    const taskTypes = await client.findAll(task.class.TaskType, {});
    const availableTypes = new Set(taskTypes.map(t => t.name));

    for (const item of template.issues) {
      // Create parent issue
      const resolvedType = (item.type && availableTypes.has(item.type)) ? item.type : undefined;
      const parent = await this.createIssue(
        projectIdent, item.title, item.description || '',
        item.priority || 'medium', item.status || 'Todo',
        item.labels || [], resolvedType
      );
      allCreated.push(parent);

      // Create children and link to parent
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          const resolvedChildType = (child.type && availableTypes.has(child.type)) ? child.type : undefined;
          const childIssue = await this.createIssue(
            projectIdent, child.title, child.description || '',
            child.priority || 'medium', child.status || 'Todo',
            child.labels || [], resolvedChildType
          );
          allCreated.push(childIssue);

          try {
            await this.setParent(childIssue.id, parent.id);
          } catch (e) {
            errors.push({ childId: childIssue.id, parentId: parent.id, error: e.message });
          }
        }
      }
    }

    return {
      template: templateName,
      description: template.description,
      created: allCreated,
      errors,
      total: allCreated.length
    };
  }
}
