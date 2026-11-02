/**
 * Issue comments: add, list, get, update and delete.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, toCollaboratorMarkup, withExtra } from '../helpers.mjs';
import { chunter, generateId, tracker } from './sdk.mjs';

export class CommentsMethods {
  /**
   * Add a comment to an issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} text - Comment text
   * @param {string} [format='markdown'] - Text format: markdown, html, or plain
   * @returns {Promise<{message: string, id: string}>}
   * @throws {Error} When the issue is not found
   */
  async addComment(issueId, text, format) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const commentId = generateId();
    await client.addCollection(
      chunter.class.ChatMessage,
      project._id,
      issue._id,
      tracker.class.Issue,
      'comments',
      { message: toCollaboratorMarkup(text, format), attachments: 0 },
      commentId
    );

    return { message: `Comment added to ${issueId}`, id: commentId };
  }

  /**
   * List comments on an issue, newest first, one cursor page at a time.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the issue is not found, or the limit or cursor is invalid
   */
  async listComments(issueId, options = {}) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const comments = await client.findAll(chunter.class.ChatMessage, {
      attachedTo: issue._id
    }, { sort: { createdOn: 1 } });

    const enriched = comments.map(c => withExtra(c, {
      id: c._id,
      text: fromMarkup(c.message),
      createdBy: c.createdBy || null,
      createdOn: c.createdOn,
      modifiedOn: c.modifiedOn
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_comments', issueId: issueId.toUpperCase() }
    });
  }

  /**
   * Replace the text of a comment.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} commentId - Comment ID
   * @param {string} text - New comment text
   * @param {string} [format='markdown'] - Text format: markdown, html, or plain
   * @returns {Promise<{message: string, id: string}>}
   * @throws {Error} When the issue or comment is not found
   */
  async updateComment(issueId, commentId, text, format) {
    const client = await this._getClient();
    const { project } = await this._parseAndFindIssue(client, issueId);

    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);

    await client.updateDoc(chunter.class.ChatMessage, project._id, commentId, {
      message: toCollaboratorMarkup(text, format)
    });

    return {
      message: `Comment updated on ${issueId}`,
      id: commentId
    };
  }

  /**
   * Delete a comment.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} commentId - Comment ID
   * @returns {Promise<{message: string, id: string}>}
   * @throws {Error} When the issue or comment is not found
   */
  async deleteComment(issueId, commentId) {
    const client = await this._getClient();
    await this._parseAndFindIssue(client, issueId);

    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);

    await client.removeCollection(chunter.class.ChatMessage, comment.space, comment._id, comment.attachedTo, comment.attachedToClass, comment.collection);

    return {
      message: `Comment deleted from ${issueId}`,
      id: commentId
    };
  }

  /**
   * Get a comment by ID. The issue must exist; the comment is looked up by ID alone.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} commentId - Comment ID
   * @returns {Promise<Object>} `{ id, text, createdBy, createdOn, modifiedOn, editedOn }` plus extras
   * @throws {Error} When the issue or comment is not found
   */
  async getComment(issueId, commentId) {
    const client = await this._getClient();
    await this._parseAndFindIssue(client, issueId);

    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);

    return withExtra(comment, {
      id: comment._id,
      text: fromMarkup(comment.message),
      createdBy: comment.createdBy || null,
      createdOn: comment.createdOn,
      modifiedOn: comment.modifiedOn,
      editedOn: comment.editedOn || null
    });
  }
}
