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
 * @returns {Object}
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
  async listComponents(projectIdent, options = {}) {
    const client = await this._getClient();
    const project = await this._findProject(client, projectIdent);

    const components = await client.findAll(tracker.class.Component, { space: project._id });

    return this._cursoredFindAll(components.map(componentRow), {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_components', project: projectIdent.toUpperCase() }
    });
  }

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
   * Find a component by name in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Component name (fuzzy match)
   * @returns {Promise<Object>}
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
