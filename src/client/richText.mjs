/**
 * Reading and writing collaborative rich-text fields (issue descriptions) through the collaborator service.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromCollaboratorMarkup, toCollaboratorMarkup } from '../helpers.mjs';

export class RichTextMethods {
  /**
   * Read a description from the collaborator service.
   * Issue descriptions are stored in a separate Yjs-backed document store.
   * The issue's description field holds a reference ID; this method fetches
   * the actual content and returns it as markdown.
   *
   * @param {string} objectId - Internal document ID (issue._id)
   * @param {string} objectClass - Document class (e.g. tracker:class:Issue)
   * @param {string} [attr='description'] - Attribute name
   * @returns {Promise<string>} Markdown text
   */
  async _readCollaboratorField(objectId, objectClass, attr = 'description', source = null) {
    if (!this._collabClient) {
      throw new Error('Collaborator client not initialized. Cannot read rich text fields.');
    }
    const docRef = { objectClass, objectId, objectAttr: attr };
    const markup = await this._collabClient.getMarkup(docRef, source);
    return fromCollaboratorMarkup(markup, 'markdown');
  }

  /**
   * Write a description to the collaborator service.
   * Converts the input text (markdown/html/plain) to ProseMirror JSON
   * and pushes it to the collaborator. The issue's description field
   * must already contain a valid collaborator reference.
   *
   * @param {string} objectId - Internal document ID
   * @param {string} objectClass - Document class
   * @param {string} text - Content to write
   * @param {string} [format='markdown'] - Input format
   * @param {string} [attr='description'] - Attribute name
   * @returns {Promise<void>}
   */
  async _writeCollaboratorField(objectId, objectClass, text, format = 'markdown', attr = 'description') {
    if (!this._collabClient) {
      throw new Error('Collaborator client not initialized. Cannot write rich text fields.');
    }
    const docRef = { objectClass, objectId, objectAttr: attr };
    const markup = toCollaboratorMarkup(text, format);
    await this._collabClient.updateMarkup(docRef, markup);
  }
}
