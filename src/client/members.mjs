/**
 * Workspace members and the account/collaborator resolution shared by projects and milestones.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { withExtra } from '../helpers.mjs';
import { contactPlugin, core } from './sdk.mjs';

export class MembersMethods {
  async _resolveCollaboratorMembers(client, names) {
    return this._resolveAccountMembers(client, names, 'collaborators');
  }

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

  async _collaboratorsByObject(client, objectIds) {
    const ids = [...new Set(objectIds.filter(Boolean))];
    const result = new Map(ids.map(id => [id, []]));
    if (ids.length === 0) return result;

    const records = await client.findAll(core.class.Collaborator, {
      attachedTo: { $in: ids }
    });
    if (records.length === 0) return result;

    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeByAccount = new Map(
      employees.filter(employee => employee.personUuid)
        .map(employee => [employee.personUuid, employee])
    );
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
   * List all active workspace members.
   * @returns {Promise<Object[]>}
   */
  async listMembers(options = {}) {
    const client = await this._getClient();
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const enriched = employees.map(e => withExtra(e, {
      id: e._id,
      name: e.name,
      email: e.channels?.[0]?.value || null,
      role: e.role || 'USER',
      position: e.position || null
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_members' }
    });
  }

  /**
   * Find a member by name.
   * @param {string} name - Member name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getMember(name) {
    const client = await this._getClient();
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });

    const member = employees.find(e =>
      e.name?.toLowerCase().includes(name.toLowerCase())
    );
    if (!member) {
      const names = employees.map(e => e.name).join(', ');
      throw new Error(`Member not found: "${name}". Available: ${names}`);
    }

    return withExtra(member, {
      id: member._id,
      name: member.name,
      role: member.role || 'USER'
    });
  }
}
