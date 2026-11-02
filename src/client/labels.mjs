/**
 * Labels: workspace label definitions and their attachment to issues.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  DEFAULT_LABEL_CATEGORY,
  DEFAULT_LABEL_COLOR,
  fromMarkup,
  nameMatch,
  resolveColor,
  withExtra
} from '../helpers.mjs';
import { assertNameAvailable, findByName } from './lookups.mjs';
import { generateId, tags, tracker } from './sdk.mjs';

export class LabelsMethods {
  /**
   * Add a label to an issue, creating the label if none has exactly that name.
   * @param {Object} client - Huly SDK client
   * @param {string} issueId - Internal issue ID
   * @param {string} space - Project space ID
   * @param {string} labelName - Label name to add
   * @returns {Promise<{message: string}>} Added, or already attached
   */
  async _addLabelToIssue(client, issueId, space, labelName) {
    let tagElement = await this._findLabelByName(client, labelName);

    if (!tagElement) {
      const tagId = generateId();
      await client.createDoc(tags.class.TagElement, space, {
        title: labelName,
        targetClass: tracker.class.Issue,
        description: '',
        color: DEFAULT_LABEL_COLOR,
        category: DEFAULT_LABEL_CATEGORY
      }, tagId);
      tagElement = { _id: tagId, title: labelName, color: DEFAULT_LABEL_COLOR };
    }

    const existing = await client.findOne(tags.class.TagReference, {
      attachedTo: issueId,
      tag: tagElement._id
    });

    if (existing) {
      return { message: `Label "${labelName}" already attached` };
    }

    await client.addCollection(
      tags.class.TagReference,
      space,
      issueId,
      tracker.class.Issue,
      'labels',
      {
        title: tagElement.title,
        color: tagElement.color || 0,
        tag: tagElement._id
      }
    );

    return { message: `Label "${labelName}" added` };
  }

  /**
   * Add a label to an issue by issue identifier.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} labelName - Label name to add; created if no label has exactly that name
   * @returns {Promise<{message: string}>} Added, or already attached (not an error)
   * @throws {Error} When the issue is not found
   */
  async addLabel(issueId, labelName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    return await this._addLabelToIssue(client, issue._id, project._id, labelName);
  }

  /**
   * Remove a label from an issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} labelName - Label name to remove (case-insensitive)
   * @returns {Promise<{message: string}>} Removed, or a not-found message when the issue lacks the label
   * @throws {Error} When the issue is not found
   */
  async removeLabel(issueId, labelName) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const tagRefs = await client.findAll(tags.class.TagReference, {
      attachedTo: issue._id
    });

    const tagRef = tagRefs.find(r => nameMatch(r.title, labelName));

    if (!tagRef) {
      return { message: `Label "${labelName}" not found on issue` };
    }

    await client.removeCollection(tags.class.TagReference, tagRef.space, tagRef._id, tagRef.attachedTo, tagRef.attachedToClass, tagRef.collection);

    return { message: `Label "${labelName}" removed` };
  }

  /**
   * List the workspace's issue labels, one cursor page at a time.
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the limit or cursor is invalid
   */
  async listLabels(options = {}) {
    const client = await this._getClient();

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });

    const enriched = tagElements.map(t => withExtra(t, {
      id: t._id,
      name: t.title,
      description: t.description || '',
      color: t.color ?? null,
      category: t.category || null
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_labels' }
    });
  }

  /**
   * Create an issue label. If a label with exactly the same name exists, returns `{ message, id }` for it
   * instead of throwing.
   * @param {string} name - Label name
   * @param {string|number} [color=9] - Color name, palette index, or RGB number; unrecognized values use the default
   * @param {string} [description] - Label description
   * @returns {Promise<{message: string, id: string, name: string, color: number}>}
   * @throws {Error} When the workspace has no project to own the label or the label was not persisted
   */
  async createLabel(name, color, description) {
    const client = await this._getClient();

    const existing = await this._findLabelByName(client, name);
    if (existing) {
      return { message: `Label "${existing.title}" already exists`, id: existing._id };
    }

    // A built-in project such as tracker:project:DefaultProject is a
    // model-level space, and a TagElement created there is silently not
    // persisted. Own the label with a real, database-created project.
    const projects = await client.findAll(tracker.class.Project, {});
    const project = projects.find(candidate => !String(candidate._id).includes(':')) ?? null;
    if (!project) {
      throw new Error('Cannot create a label: the workspace has no project to own it');
    }
    const space = project._id;

    const tagId = generateId();
    await client.createDoc(tags.class.TagElement, space, {
      title: name,
      targetClass: tracker.class.Issue,
      description: description || '',
      color: resolveColor(color),
      category: DEFAULT_LABEL_CATEGORY
    }, tagId);

    // createDoc resolves even when the server discards the document, which is
    // how a label written to a model-level space used to report success while
    // persisting nothing. Confirm the write before claiming it happened.
    const persisted = await client.findOne(tags.class.TagElement, {
      _id: tagId,
      targetClass: tracker.class.Issue
    });
    if (!persisted) {
      throw new Error(
        `Label "${name}" was not persisted by the server. This usually means the owning space is not a real project space.`
      );
    }

    return { message: `Label "${name}" created`, id: tagId, name, color: resolveColor(color) };
  }

  /**
   * Update a label's name, color, or description. A rename is also applied to every attached reference.
   * @param {string} name - Current label name (exact match)
   * @param {Object} [updates] - Fields to update; omitted keys are left unchanged
   * @param {string} [updates.newName] - New name
   * @param {string|number} [updates.color] - Color name, palette index, or RGB number
   * @param {string} [updates.description] - New description
   * @returns {Promise<Object>} `{ message, id, updated, renamedReferences? }`, or `{ message, id }` when nothing
   *   changed
   * @throws {Error} When the label is not found
   */
  async updateLabel(name, updates = {}) {
    const client = await this._getClient();

    const labels = await this._issueLabels(client);
    const tagElement = findByName(labels, label => label.title, name, 'Label');
    if (updates.newName !== undefined) {
      assertNameAvailable(labels, label => label.title, updates.newName, 'Label', tagElement._id);
    }

    const ops = {};
    if (updates.newName !== undefined) ops.title = updates.newName;
    if (updates.color !== undefined) ops.color = resolveColor(updates.color);
    if (updates.description !== undefined) ops.description = updates.description;

    if (Object.keys(ops).length === 0) {
      return { message: 'No updates specified', id: tagElement._id };
    }

    await client.updateDoc(tags.class.TagElement, tagElement.space, tagElement._id, ops);

    // Issue reads and removeLabel match on the denormalised TagReference.title.
    // Renaming only the element leaves the label answering to its old name
    // there and its new name in label filters.
    let renamedReferences = 0;
    if (ops.title !== undefined) {
      const references = await client.findAll(tags.class.TagReference, { tag: tagElement._id });
      for (const reference of references) {
        await client.updateDoc(tags.class.TagReference, reference.space, reference._id, {
          title: ops.title
        });
        renamedReferences += 1;
      }
    }

    return {
      message: `Label "${name}" updated`,
      id: tagElement._id,
      updated: Object.keys(ops),
      ...(ops.title !== undefined ? { renamedReferences } : {})
    };
  }

  /**
   * Delete an issue label.
   * @param {string} name - Label name (exact match)
   * @returns {Promise<{message: string, id: string}>}
   * @throws {Error} When the label is not found
   */
  async deleteLabel(name) {
    const client = await this._getClient();
    const tagElement = findByName(await this._issueLabels(client), label => label.title, name, 'Label');
    await client.removeDoc(tags.class.TagElement, tagElement.space, tagElement._id);
    return { message: `Label "${name}" deleted`, id: tagElement._id };
  }

  /**
   * Get an issue label by name.
   * @param {string} name - Label name (case-insensitive exact match)
   * @returns {Promise<Object>} `{ id, name, color, description }` plus extras
   * @throws {Error} When the label is not found
   */
  async getLabel(name) {
    const client = await this._getClient();

    const label = findByName(await this._issueLabels(client), tag => tag.title, name, 'Label');

    return withExtra(label, {
      id: label._id,
      name: label.title,
      color: label.color ?? null,
      description: fromMarkup(label.description)
    });
  }
}
