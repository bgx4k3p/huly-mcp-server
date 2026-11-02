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
   * @param {string} issueId - Issue identifier
   * @param {string} text - Comment text
   * @returns {Promise<Object>}
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
   * List all comments on an issue.
   * @param {string} issueId - Issue identifier
   * @returns {Promise<Object[]>}
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
   * Get a specific comment by ID on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} commentId - Comment ID
   * @returns {Promise<Object>}
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
