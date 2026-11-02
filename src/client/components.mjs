/**
 * Project components: list, get, create, update and delete.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, nameMatch, toMarkup, withExtra } from '../helpers.mjs';
import { generateId, tracker } from './sdk.mjs';

/**
 * Output row for a component.
 * @param {Object} component - Component document
 * @returns {Object} Component output row; `lead` is the lead's employee ID or null
 */
function componentRow(component) {
  return withExtra(component, {
    id: component._id,
    name: component.label,
    description: fromMarkup(component.description),
    lead: component.lead || null
  });
}

export class ComponentsMethods {
  /**
   * List components in a project, one cursor page at a time.
   * @param {string} projectIdent - Project identifier
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the project is not found, or the limit or cursor is invalid
   */
  async listComponents(projectIdent, options = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const components = await client.findAll(tracker.class.Component, { space: project._id });

    return this._cursoredFindAll(components.map(componentRow), {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_components', project: projectIdent.toUpperCase() }
    });
  }

  /**
   * Create a component in a project. If a component with exactly the same name exists, returns
   * `{ message, id }` for it instead of throwing.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Component name
   * @param {string} [description] - Component description
   * @param {string} [lead] - Lead employee name (case-insensitive)
   * @param {string} [format='markdown'] - Description format: markdown, html, or plain
   * @returns {Promise<Object>} `{ message, id, name, description, lead }`; lead is the employee ID or null
   * @throws {Error} When the project or lead is not found
   */
  async createComponent(projectIdent, name, description, lead, format) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const existing = await client.findOne(tracker.class.Component, {
      space: project._id,
      label: name
    });
    if (existing) {
      return { message: `Component "${name}" already exists`, id: existing._id };
    }

    // Resolve lead name to employee ID
    let leadId = null;
    if (lead) {
      leadId = await this._findEmployeeByName(client, lead);
    }

    const componentId = generateId();
    await client.createDoc(tracker.class.Component, project._id, {
      label: name,
      description: toMarkup(description || '', format),
      lead: leadId,
      attachments: 0,
      comments: 0
    }, componentId);

    return {
      message: `Component "${name}" created`,
      id: componentId,
      name,
      description: description || '',
      lead: leadId
    };
  }

  /**
   * Update a component found by name (case-insensitive).
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Current component name
   * @param {Object} [updates] - Fields to update; omitted keys are left unchanged
   * @param {string} [updates.name] - New name
   * @param {string} [updates.description] - New description
   * @param {string} [updates.descriptionFormat='markdown'] - Description format: markdown, html, or plain
   * @param {string} [updates.lead] - Lead employee name; empty clears it
   * @returns {Promise<{id: string, name: string, updated: string[]}>}
   * @throws {Error} When the project, component, or lead is not found
   */
  async updateComponent(projectIdent, name, updates = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) throw new Error(`Component not found: ${name}`);

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
    if (updates.lead !== undefined) {
      if (updates.lead) {
        docUpdates.lead = await this._findEmployeeByName(client, updates.lead);
      } else {
        docUpdates.lead = null;
      }
      updatedFields.push('lead');
    }

    if (Object.keys(docUpdates).length > 0) {
      await client.updateDoc(tracker.class.Component, project._id, component._id, docUpdates);
    }

    return {
      id: component._id,
      name: docUpdates.label || component.label,
      updated: updatedFields
    };
  }

  /**
   * Delete a component found by name (case-insensitive).
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Component name
   * @returns {Promise<{message: string, id: string}>}
   * @throws {Error} When the project or component is not found
   */
  async deleteComponent(projectIdent, name) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) throw new Error(`Component not found: ${name}`);

    await client.removeDoc(tracker.class.Component, project._id, component._id);

    return {
      message: `Component "${name}" deleted from ${projectIdent}`,
      id: component._id
    };
  }

  /**
   * Get a component by name in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Component name (case-insensitive exact match)
   * @returns {Promise<Object>} Component row
   * @throws {Error} When the project or component is not found; the message lists available components
   */
  async getComponent(projectIdent, name) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) {
      const names = components.map(c => c.label).join(', ');
      throw new Error(`Component not found: "${name}". Available: ${names}`);
    }

    return componentRow(component);
  }
}
