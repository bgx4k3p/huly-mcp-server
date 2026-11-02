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
  async _findIssueTemplate(client, project, templateId) {
    const template = await client.findOne(tracker.class.IssueTemplate, { _id: templateId, space: project._id });
    if (!template) throw new Error(`Issue template not found in ${project.identifier}: ${templateId}`);
    return template;
  }

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
      ['component', value => this._findComponentByName(client, project._id, value)],
      ['milestone', value => this._findMilestoneByName(client, project._id, value)]
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

  async listIssueTemplates(projectIdent, options = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const templates = await client.findAll(tracker.class.IssueTemplate, { space: project._id });
    const page = this._cursoredFindAll(templates, {
      ...options, cursorScope: { workspace: this.workspace, tool: 'list_issue_templates', project: project.identifier }
    });
    return listEnvelope(await this._readIssueTemplates(client, project, page.items), page.nextCursor);
  }

  async getIssueTemplate(projectIdent, templateId) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const template = await this._findIssueTemplate(client, project, templateId);
    return (await this._readIssueTemplates(client, project, [template]))[0];
  }

  async createIssueTemplate(projectIdent, input = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const data = await this._templateUpdates(client, project, input, true);
    const id = generateId();
    await client.createDoc(tracker.class.IssueTemplate, project._id, { ...data, comments: 0, attachments: 0 }, id);
    return { id, project: project.identifier, title: data.title };
  }

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

  async deleteIssueTemplate(projectIdent, templateId) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);
    const template = await this._findIssueTemplate(client, project, templateId);
    await client.removeDoc(tracker.class.IssueTemplate, project._id, template._id);
    return { id: template._id, message: `Issue template "${template.title}" deleted` };
  }

  /** Create issues using the predefined convenience workflow generators. */
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
