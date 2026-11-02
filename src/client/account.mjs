/**
 * Account-level operations that need no workspace connection: authentication, workspaces, profile, invites, integrations, mailboxes and social identities. Exposed as static methods.
 *
 * Methods are composed onto HulyClient; `this` is the client instance class (static methods).
 */
import { AUTH_CACHE_TTL_MS } from '../helpers.mjs';
import { ensureOutboundHeaders, registerOriginsFromServerConfig } from '../outboundHeaders.mjs';
import { getAccountClient, loadConfig } from './sdk.mjs';

export class AccountMethods {
  /**
   * List all workspaces accessible to the authenticated user.
   * This is an account-level operation, not workspace-specific.
   *
   * @param {string} url - Huly server URL
   * @param {Object} creds - Credentials: { email, password } or { token }
   * @returns {Promise<Object[]>}
   */
  static async listWorkspaces(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    const workspaces = await authClient.getUserWorkspaces();

    return workspaces.map(ws => ({
      slug: ws.url || ws.workspace,
      name: ws.name || ws.workspaceName,
      mode: ws.mode,
      createdOn: ws.createdOn ? new Date(ws.createdOn).toISOString() : null
    }));
  }

  /**
   * Helper: get an authenticated account client.
   * @param {string} url - Huly server URL
   * @param {Object} creds - Credentials: { email, password } or { token }
   * @returns {Promise<{ authClient: Object, token: string, accountsUrl: string }>}
   */
  static _authCache = { token: null, accountId: null, accountsUrl: null, expiresAt: 0 };

  static async _getAuthClient(url, creds) {
    const cacheKey = creds.token || creds.email;
    const now = Date.now();
    if (this._authCache.token && now < this._authCache.expiresAt &&
        this._authCache._url === url && this._authCache._cacheKey === cacheKey) {
      return {
        authClient: getAccountClient(this._authCache.accountsUrl, this._authCache.token),
        token: this._authCache.token,
        accountId: this._authCache.accountId,
        accountsUrl: this._authCache.accountsUrl
      };
    }

    ensureOutboundHeaders(url);
    const config = await loadConfig(url);
    registerOriginsFromServerConfig(config, url);
    const accountsUrl = config.ACCOUNTS_URL;
    let token, accountId;

    if (creds.token) {
      // Token-based auth: use the token directly, extract accountId from JWT payload
      token = creds.token;
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      accountId = payload.account;
      if (!accountId) {
        throw new Error('JWT token missing account field');
      }
    } else {
      // Email/password auth
      const client = getAccountClient(accountsUrl);
      const loginInfo = await client.login(creds.email, creds.password);
      if (!loginInfo?.token) {
        throw new Error('Login failed — check email and password');
      }
      token = loginInfo.token;
      accountId = loginInfo.account;
    }

    this._authCache = {
      token,
      accountId,
      accountsUrl,
      expiresAt: now + AUTH_CACHE_TTL_MS,
      _url: url,
      _cacheKey: cacheKey
    };

    return {
      authClient: getAccountClient(accountsUrl, token),
      token,
      accountId,
      accountsUrl
    };
  }

  /**
   * Helper: get a workspace-scoped account client.
   */
  static async _getWorkspaceAuthClient(url, creds, workspaceSlug) {
    const { authClient, accountsUrl } = await this._getAuthClient(url, creds);

    // Validate the workspace exists before selecting it
    const workspaces = await authClient.getUserWorkspaces();
    const ws = workspaces.find(w => (w.url || w.workspace) === workspaceSlug);
    if (!ws) {
      throw new Error(`Workspace not found: ${workspaceSlug}`);
    }

    const wsInfo = await authClient.selectWorkspace(workspaceSlug);
    if (!wsInfo?.token) {
      throw new Error(`Failed to select workspace: ${workspaceSlug}`);
    }
    return { wsClient: getAccountClient(accountsUrl, wsInfo.token), wsInfo };
  }

  /**
   * Get detailed info about a specific workspace.
   */
  static async getWorkspaceInfo(url, creds, workspaceSlug) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    const info = await wsClient.getWorkspaceInfo();
    return {
      slug: info.url || info.workspaceUrl,
      name: info.name,
      uuid: info.uuid || info.workspaceUuid,
      mode: info.mode,
      version: info.versionMajor != null ? `${info.versionMajor}.${info.versionMinor}.${info.versionPatch}` : null,
      createdOn: info.createdOn ? new Date(info.createdOn).toISOString() : null,
      lastVisit: info.lastVisit ? new Date(info.lastVisit).toISOString() : null,
      isDisabled: info.isDisabled || false
    };
  }

  /**
   * Create a new workspace.
   */
  static async createWorkspace(url, creds, name) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.createWorkspace(name);
    // WorkspaceLoginInfo carries the slug as workspaceUrl and the uuid as
    // workspace. Reading result.url returned the uuid as the slug and left
    // uuid undefined, so the reported slug could not address the workspace.
    return {
      message: `Workspace "${name}" created`,
      slug: result.workspaceUrl ?? result.url ?? result.workspace,
      uuid: result.workspace ?? result.uuid
    };
  }

  /**
   * Rename an existing workspace.
   */
  static async updateWorkspaceName(url, creds, workspaceSlug, newName) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceName(newName);
    return { message: `Workspace "${workspaceSlug}" renamed to "${newName}"` };
  }

  /**
   * Permanently delete a workspace.
   */
  static async deleteWorkspace(url, creds, workspaceSlug) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.deleteWorkspace();
    return { message: `Workspace "${workspaceSlug}" deleted permanently` };
  }

  /**
   * Get workspace members with roles.
   */
  static async getWorkspaceMembers(url, creds, workspaceSlug) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    const members = await wsClient.getWorkspaceMembers();
    return members.map(m => ({
      id: m.person || m._id,
      role: m.role,
      email: m.email || null,
      name: m.name || null
    }));
  }

  /**
   * Update a member's role in a workspace.
   */
  static async updateWorkspaceRole(url, creds, workspaceSlug, memberEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceRole(memberEmail, role);
    return { message: `Updated role for ${memberEmail} to ${role} in ${workspaceSlug}` };
  }

  /**
   * Get the current user's account info.
   */
  static async getAccountInfo(url, creds) {
    const { authClient, accountId } = await this._getAuthClient(url, creds);
    const info = await authClient.getAccountInfo(accountId);
    return info;
  }

  /**
   * Get the current user's profile.
   */
  static async getUserProfile(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    const profile = await authClient.getUserProfile();
    return profile;
  }

  /**
   * Update the current user's profile.
   */
  static async setMyProfile(url, creds, name, city, country) {
    const { authClient } = await this._getAuthClient(url, creds);
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (city !== undefined) updates.city = city;
    if (country !== undefined) updates.country = country;
    await authClient.setMyProfile(updates);
    return { message: 'Profile updated', updated: Object.keys(updates) };
  }

  /**
   * Change the current user's password.
   */
  static async changePassword(url, creds, newPassword) {
    const { authClient } = await this._getAuthClient(url, creds);
    if (!creds.password) {
      throw new Error('changePassword requires email/password auth, not token auth');
    }
    await authClient.changePassword(creds.password, newPassword);
    return { message: 'Password changed successfully' };
  }

  /**
   * Change the current user's username.
   */
  static async changeUsername(url, creds, firstName, lastName) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.changeUsername(firstName, lastName || '');
    return { message: `Username changed to "${firstName}${lastName ? ' ' + lastName : ''}"` };
  }

  /**
   * Send an invite to join a workspace.
   */
  static async sendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.sendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite sent to ${inviteEmail} for workspace ${workspaceSlug}` };
  }

  /**
   * Resend a pending invite.
   */
  static async resendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.resendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite resent to ${inviteEmail}` };
  }

  /**
   * Create an invite link for a workspace.
   */
  static async createInviteLink(url, creds, workspaceSlug, email, role, firstName, lastName, expireHours) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    const link = await wsClient.createInviteLink(
      email || '',
      role || 'MEMBER',
      false,
      firstName || '',
      lastName || '',
      undefined,
      expireHours || 48
    );
    return { link, workspace: workspaceSlug, role: role || 'MEMBER' };
  }

  /**
   * List all integrations.
   */
  static async listIntegrations(url, creds, filter) {
    const { authClient } = await this._getAuthClient(url, creds);
    const integrations = await authClient.listIntegrations(filter || {});
    return integrations;
  }

  /**
   * Get a specific integration by key (socialId + kind + workspaceUuid).
   */
  static async getIntegration(url, creds, integrationKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    const integration = await authClient.getIntegration(integrationKey);
    return integration;
  }

  /**
   * Create a new integration.
   * @param {object} integration - { socialId, kind, workspaceUuid, data?, disabled? }
   */
  static async createIntegration(url, creds, integration) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.createIntegration(integration);
    return result;
  }

  /**
   * Update an existing integration.
   * @param {object} integration - Full Integration object { socialId, kind, workspaceUuid, data?, disabled? }
   */
  static async updateIntegration(url, creds, integration) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.updateIntegration(integration);
    return result;
  }

  /**
   * Delete an integration by key.
   * @param {object} integrationKey - { socialId, kind, workspaceUuid }
   */
  static async deleteIntegration(url, creds, integrationKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.deleteIntegration(integrationKey);
    return { message: 'Integration deleted' };
  }

  /**
   * List all mailboxes.
   */
  static async getMailboxes(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    const mailboxes = await authClient.getMailboxes();
    return mailboxes;
  }

  /**
   * Create a new mailbox.
   */
  static async createMailbox(url, creds, name, domain) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.createMailbox(name, domain);
    return result;
  }

  /**
   * Delete a mailbox.
   */
  static async deleteMailbox(url, creds, mailboxId) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.deleteMailbox(mailboxId);
    return { message: `Mailbox ${mailboxId} deleted` };
  }

  /**
   * Find a person by social key.
   */
  static async findPersonBySocialKey(url, creds, socialKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    const person = await authClient.findPersonBySocialKey(socialKey);
    return person;
  }

  /**
   * Get social IDs for the current user.
   */
  static async getSocialIds(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    const socialIds = await authClient.getSocialIds();
    return socialIds;
  }

  /**
   * Add an email social ID to a person.
   */
  static async addEmailSocialId(url, creds, targetEmail) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.addEmailSocialId(targetEmail);
    return result;
  }

  /**
   * Get all subscriptions for the current account.
   */
  static async getSubscriptions(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    const subscriptions = await authClient.getSubscriptions(undefined, false);
    return subscriptions;
  }
}
