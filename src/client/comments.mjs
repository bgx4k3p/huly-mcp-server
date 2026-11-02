/**
 * Issue comments: add, list, get, update and delete.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, toCollaboratorMarkup, withExtra } from '../helpers.mjs';
import { chunter, generateId, tracker } from './sdk.mjs';

/**
 * Output row for a comment.
 * @param {Object} comment - ChatMessage document
 * @returns {Object}
 */
function commentRow(comment) {
  return withExtra(comment, {
    id: comment._id,
    text: fromMarkup(comment.message),
    createdBy: comment.createdBy || null,
    createdOn: comment.createdOn,
    modifiedOn: comment.modifiedOn,
    editedOn: comment.editedOn || null
  });
}

export class CommentsMethods {
  /**
   * Find a comment that belongs to the given issue. A comment on any other issue is reported as not found,
   * so a comment can only be read or changed through its own issue.
   * @param {Object} client - Huly SDK client
   * @param {Object} issue - Issue document
   * @param {string} commentId - Comment ID
   * @returns {Promise<Object>} ChatMessage document
   * @throws {Error} When the issue has no comment with that ID
   */
  async _findCommentOnIssue(client, issue, commentId) {
    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId, attachedTo: issue._id });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);
    return comment;
  }

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

    return this._cursoredFindAll(comments.map(commentRow), {
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
   * @throws {Error} When the issue is not found or the comment is not on it
   */
  async updateComment(issueId, commentId, text, format) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);
    const comment = await this._findCommentOnIssue(client, issue, commentId);

    // editedOn is what marks a message as edited in Huly.
    await client.updateDoc(chunter.class.ChatMessage, comment.space, comment._id, {
      message: toCollaboratorMarkup(text, format),
      editedOn: Date.now()
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
   * @throws {Error} When the issue is not found or the comment is not on it
   */
  async deleteComment(issueId, commentId) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);
    const comment = await this._findCommentOnIssue(client, issue, commentId);

    await client.removeCollection(chunter.class.ChatMessage, comment.space, comment._id, comment.attachedTo, comment.attachedToClass, comment.collection);

    return {
      message: `Comment deleted from ${issueId}`,
      id: commentId
    };
  }

  /**
   * Get a comment on an issue by ID.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} commentId - Comment ID
   * @returns {Promise<Object>} `{ id, text, createdBy, createdOn, modifiedOn, editedOn }` plus extras
   * @throws {Error} When the issue is not found or the comment is not on it
   */
  async getComment(issueId, commentId) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);
    const comment = await this._findCommentOnIssue(client, issue, commentId);

    return commentRow(comment);
  }
}
