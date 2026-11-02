/**
 * Reading and writing collaborative rich-text fields (issue descriptions) through the collaborator service.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromCollaboratorMarkup, toCollaboratorMarkup } from '../helpers.mjs';

export class RichTextMethods {
  /**
   * Read a rich-text field from the collaborator service and return it as markdown.
   * Issue descriptions live in a separate Yjs-backed document store; the issue's field holds a reference ID.
   *
   * @param {string} objectId - Internal document ID (issue._id)
   * @param {string} objectClass - Document class (e.g. tracker:class:Issue)
   * @param {string} [attr='description'] - Attribute name
   * @param {string|null} [source=null] - Stored collaborator reference, passed to the collaborator as the source
   * @returns {Promise<string>} Markdown text
   * @throws {Error} When the collaborator client is not initialized
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
   * Write a rich-text field to the collaborator service.
   * Converts the text to ProseMirror markup and pushes it to the live collaborative document; it does not
   * change the reference stored on the object itself.
   *
   * @param {string} objectId - Internal document ID
   * @param {string} objectClass - Document class
   * @param {string} text - Content to write; empty text writes an empty paragraph
   * @param {string} [format='markdown'] - Input format: markdown, html or plain
   * @param {string} [attr='description'] - Attribute name
   * @returns {Promise<void>}
   * @throws {Error} When the collaborator client is not initialized
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
