/**
 * Workspace members and the account/collaborator resolution shared by projects and milestones.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { withExtra } from '../helpers.mjs';
import { findByName } from './lookups.mjs';
import { contactPlugin, core } from './sdk.mjs';

/**
 * Output row for a workspace member.
 * @param {Object} employee - Employee document
 * @returns {Object}
 */
function memberRow(employee) {
  return withExtra(employee, {
    id: employee._id,
    name: employee.name,
    email: employee.channels?.[0]?.value || null,
    role: employee.role || 'USER',
    position: employee.position || null
  });
}

export class MembersMethods {
  /**
   * Resolve collaborator names or account UUIDs to accounts.
   * @param {Object} client - Huly SDK client
   * @param {string[]} names - Member names or account UUIDs
   * @returns {Promise<{account: string, name: string}[]>}
   * @throws {Error} See `_resolveAccountMembers`
   */
  async _resolveCollaboratorMembers(client, names) {
    return this._resolveAccountMembers(client, names, 'collaborators');
  }

  /**
   * Resolve active members by exact name (case-insensitive) or account UUID, dropping duplicates.
   * @param {Object} client - Huly SDK client
   * @param {string[]} names - Member names or account UUIDs
   * @param {string} field - Field name used in error messages
   * @returns {Promise<{account: string, name: string}[]>}
   * @throws {Error} When `names` is not an array of non-empty strings, or a name is unknown, ambiguous or has
   *   no account UUID
   */
  async _resolveAccountMembers(client, names, field) {
    if (!Array.isArray(names)) throw new Error(`${field} must be an array`);

    const requested = names.map((name) => {
      if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`${field} must contain non-empty member names or account UUIDs`);
      }
      return name.trim();
    });
    if (requested.length === 0) return [];
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const resolved = [];

    for (const name of requested) {
      const matches = employees.filter(employee =>
        employee.name?.trim().toLowerCase() === name.toLowerCase() || employee.personUuid === name
      );
      if (matches.length > 1) throw new Error(`Ambiguous ${field} member: ${name}; use an account UUID`);
      const member = matches[0];
      if (!member) throw new Error(`${field === 'collaborators' ? 'Collaborator' : 'Member'} not found: ${name}`);
      if (!member.personUuid) {
        throw new Error(`${field} member "${member.name}" has no account UUID`);
      }
      if (!resolved.some(item => item.account === member.personUuid)) {
        resolved.push({ account: member.personUuid, name: member.name });
      }
    }

    return resolved;
  }

  /**
   * Load the collaborators of several objects, sorted by name (or account when the name is unknown).
   * @param {Object} client - Huly SDK client
   * @param {string[]} objectIds - Object ids; falsy and duplicate ids are ignored
   * @returns {Promise<Map<string, {account: string, name: string|null}[]>>} Object id → collaborators
   */
  async _collaboratorsByObject(client, objectIds) {
    const ids = [...new Set(objectIds.filter(Boolean))];
    const result = new Map(ids.map(id => [id, []]));
    if (ids.length === 0) return result;

    const records = await client.findAll(core.class.Collaborator, {
      attachedTo: { $in: ids }
    });
    if (records.length === 0) return result;

    const accounts = [...new Set(records.map(record => record.collaborator))];
    const employees = await client.findAll(contactPlugin.mixin.Employee, {
      active: true,
      personUuid: { $in: accounts }
    });
    const employeeByAccount = new Map(employees.map(employee => [employee.personUuid, employee]));
    for (const record of records) {
      if (!result.has(record.attachedTo)) continue;
      const employee = employeeByAccount.get(record.collaborator);
      result.get(record.attachedTo).push({
        account: record.collaborator,
        name: employee?.name ?? null
      });
    }
    for (const collaborators of result.values()) {
      collaborators.sort((a, b) => (a.name ?? a.account).localeCompare(b.name ?? b.account));
    }
    return result;
  }

  /**
   * Make an object's collaborators exactly the given members, adding missing and removing extra ones.
   * @param {Object} client - Huly SDK client
   * @param {Object} object - Document the collaborators are attached to
   * @param {string[]} names - Member names or account UUIDs
   * @returns {Promise<{account: string, name: string}[]>} The resolved collaborators
   * @throws {Error} See `_resolveAccountMembers`
   */
  async _syncCollaborators(client, object, names) {
    const desired = await this._resolveCollaboratorMembers(client, names);
    const desiredAccounts = new Set(desired.map(item => item.account));
    const existing = await client.findAll(core.class.Collaborator, { attachedTo: object._id });
    const existingAccounts = new Set(existing.map(item => item.collaborator));

    for (const collaborator of desired) {
      if (existingAccounts.has(collaborator.account)) continue;
      await client.addCollection(
        core.class.Collaborator,
        object.space,
        object._id,
        object._class,
        'collaborators',
        { collaborator: collaborator.account }
      );
    }

    for (const collaborator of existing) {
      if (desiredAccounts.has(collaborator.collaborator)) continue;
      await client.removeCollection(
        core.class.Collaborator,
        collaborator.space,
        collaborator._id,
        collaborator.attachedTo,
        collaborator.attachedToClass,
        collaborator.collection
      );
    }

    return desired;
  }

  /**
   * List active workspace members.
   * @param {Object} [options] - Paging options
   * @param {number} [options.limit=50] - Page size (max 100)
   * @param {string} [options.cursor] - Pagination cursor from a previous page
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   */
  async listMembers(options = {}) {
    const client = await this._getClient();
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    return this._cursoredFindAll(employees.map(memberRow), {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_members' }
    });
  }

  /**
   * Get an active member by name (case-insensitive).
   * @param {string} name - Member name
   * @returns {Promise<Object>} Member row, as list_members returns it
   * @throws {Error} When no active member has that name
   */
  async getMember(name) {
    const client = await this._getClient();
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });

    return memberRow(findByName(employees, employee => employee.name, name, 'Member'));
  }
}
