/**
 * Account-level operations that need no workspace connection: authentication, workspaces, profile,
 * invites, integrations, mailboxes and social identities.
 *
 * Exposed as static methods on HulyClient; `this` is the HulyClient class.
 */
import { AUTH_CACHE_TTL_MS } from '../helpers.mjs';
import { ensureOutboundHeaders, registerOriginsFromServerConfig } from '../outboundHeaders.mjs';
import { getAccountClient, loadConfig } from './sdk.mjs';

export class AccountMethods {
  /**
   * List the workspaces accessible to the authenticated account.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<{slug: string, name: string, mode: string, createdOn: ?string}[]>}
   * @throws {Error} When authentication fails
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
   * Process-wide cache of the last account token, keyed by server URL and credential.
   * @type {{token: ?string, accountId: ?string, accountsUrl: ?string, expiresAt: number}}
   */
  static _authCache = { token: null, accountId: null, accountsUrl: null, expiresAt: 0 };

  /**
   * Get an authenticated account client, reusing a cached token for the same URL and credential for 10 minutes.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<{authClient: Object, token: string, accountId: string, accountsUrl: string}>}
   * @throws {Error} When login fails or a token has no account claim
   */
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
   * Get an account client scoped to a workspace the account can access.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @returns {Promise<{wsClient: Object, wsInfo: Object}>} Workspace-scoped client and the selection result
   * @throws {Error} When authentication fails or the workspace is not accessible
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
   * Get details about a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @returns {Promise<Object>} `{ slug, name, uuid, mode, version, createdOn, lastVisit, isDisabled }`
   * @throws {Error} When authentication fails or the workspace is not accessible
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
   * Create a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} name - Workspace display name
   * @returns {Promise<{message: string, slug: string, uuid: string}>}
   * @throws {Error} When authentication fails
   */
  static async createWorkspace(url, creds, name) {
    const { authClient } = await this._getAuthClient(url, creds);
    const result = await authClient.createWorkspace(name);
    // WorkspaceLoginInfo carries the slug as workspaceUrl and the uuid as
    // workspace.
    return {
      message: `Workspace "${name}" created`,
      slug: result.workspaceUrl ?? result.url ?? result.workspace,
      uuid: result.workspace ?? result.uuid
    };
  }

  /**
   * Rename a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @param {string} newName - New display name
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
   */
  static async updateWorkspaceName(url, creds, workspaceSlug, newName) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceName(newName);
    return { message: `Workspace "${workspaceSlug}" renamed to "${newName}"` };
  }

  /**
   * Permanently delete a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
   */
  static async deleteWorkspace(url, creds, workspaceSlug) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.deleteWorkspace();
    return { message: `Workspace "${workspaceSlug}" deleted permanently` };
  }

  /**
   * List workspace members with their roles.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @returns {Promise<{id: string, role: string, email: ?string, name: ?string}[]>}
   * @throws {Error} When authentication fails or the workspace is not accessible
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
   * Change a member's role in a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @param {string} memberEmail - Member identifier passed to the account service
   * @param {string} role - New role (e.g., "MEMBER", "OWNER")
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
   */
  static async updateWorkspaceRole(url, creds, workspaceSlug, memberEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceRole(memberEmail, role);
    return { message: `Updated role for ${memberEmail} to ${role} in ${workspaceSlug}` };
  }

  /**
   * Get the authenticated account's info from the account service.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<Object>} Account info as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getAccountInfo(url, creds) {
    const { authClient, accountId } = await this._getAuthClient(url, creds);
    return await authClient.getAccountInfo(accountId);
  }

  /**
   * Get the authenticated user's profile.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<Object>} Profile as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getUserProfile(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.getUserProfile();
  }

  /**
   * Update the authenticated user's profile. Only the arguments that are not undefined are sent.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} [name] - Display name
   * @param {string} [city] - City
   * @param {string} [country] - Country
   * @returns {Promise<{message: string, updated: string[]}>}
   * @throws {Error} When authentication fails
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
   * Change the authenticated user's password. Requires email/password credentials.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} newPassword - New password
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the credentials are a token
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
   * Change the authenticated user's name.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} firstName - First name
   * @param {string} [lastName] - Last name
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails
   */
  static async changeUsername(url, creds, firstName, lastName) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.changeUsername(firstName, lastName || '');
    return { message: `Username changed to "${firstName}${lastName ? ' ' + lastName : ''}"` };
  }

  /**
   * Send an email invite to join a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @param {string} inviteEmail - Invitee email address
   * @param {string} [role='MEMBER'] - Role granted on joining
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
   */
  static async sendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.sendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite sent to ${inviteEmail} for workspace ${workspaceSlug}` };
  }

  /**
   * Resend a pending workspace invite.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @param {string} inviteEmail - Invitee email address
   * @param {string} [role='MEMBER'] - Role granted on joining
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
   */
  static async resendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await this._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.resendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite resent to ${inviteEmail}` };
  }

  /**
   * Create an invite link for a workspace.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} workspaceSlug - Workspace slug (URL name)
   * @param {string} [email] - Restrict the link to this email address
   * @param {string} [role='MEMBER'] - Role granted on joining
   * @param {string} [firstName] - Invitee first name
   * @param {string} [lastName] - Invitee last name
   * @param {number} [expireHours=48] - Hours until the link expires
   * @returns {Promise<{link: string, workspace: string, role: string}>}
   * @throws {Error} When authentication fails or the workspace is not accessible
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
   * List the account's integrations.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {Object} [filter] - Account-service filter (e.g., `{ socialId, kind, workspaceUuid }`)
   * @returns {Promise<Object[]>} Integrations as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async listIntegrations(url, creds, filter) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.listIntegrations(filter || {});
  }

  /**
   * Get an integration by key.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {{socialId: string, kind: string, workspaceUuid: ?string}} integrationKey - Integration key
   * @returns {Promise<?Object>} Integration as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getIntegration(url, creds, integrationKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.getIntegration(integrationKey);
  }

  /**
   * Create an integration.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {Object} integration - `{ socialId, kind, workspaceUuid, data?, disabled? }`
   * @returns {Promise<*>} Account service result
   * @throws {Error} When authentication fails
   */
  static async createIntegration(url, creds, integration) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.createIntegration(integration);
  }

  /**
   * Update an integration.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {Object} integration - Full integration `{ socialId, kind, workspaceUuid, data?, disabled? }`
   * @returns {Promise<*>} Account service result
   * @throws {Error} When authentication fails
   */
  static async updateIntegration(url, creds, integration) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.updateIntegration(integration);
  }

  /**
   * Delete an integration by key.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {{socialId: string, kind: string, workspaceUuid: ?string}} integrationKey - Integration key
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails
   */
  static async deleteIntegration(url, creds, integrationKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.deleteIntegration(integrationKey);
    return { message: 'Integration deleted' };
  }

  /**
   * List the account's mailboxes.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<Object[]>} Mailboxes as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getMailboxes(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.getMailboxes();
  }

  /**
   * Create a mailbox.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} name - Mailbox local part
   * @param {string} domain - Mailbox domain
   * @returns {Promise<*>} Account service result
   * @throws {Error} When authentication fails
   */
  static async createMailbox(url, creds, name, domain) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.createMailbox(name, domain);
  }

  /**
   * Delete a mailbox.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} mailboxId - Mailbox ID
   * @returns {Promise<{message: string}>}
   * @throws {Error} When authentication fails
   */
  static async deleteMailbox(url, creds, mailboxId) {
    const { authClient } = await this._getAuthClient(url, creds);
    await authClient.deleteMailbox(mailboxId);
    return { message: `Mailbox ${mailboxId} deleted` };
  }

  /**
   * Find a person by social key.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} socialKey - Social key (e.g., "email:user@example.com")
   * @returns {Promise<*>} Person UUID or null, as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async findPersonBySocialKey(url, creds, socialKey) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.findPersonBySocialKey(socialKey);
  }

  /**
   * Get the authenticated account's social IDs.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<Object[]>} Social IDs as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getSocialIds(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.getSocialIds();
  }

  /**
   * Add an email social ID to the authenticated account.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @param {string} targetEmail - Email address to add
   * @returns {Promise<*>} Account service result
   * @throws {Error} When authentication fails
   */
  static async addEmailSocialId(url, creds, targetEmail) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.addEmailSocialId(targetEmail);
  }

  /**
   * List the authenticated account's subscriptions, excluding inactive ones.
   * @param {string} url - Huly server URL
   * @param {{email: string, password: string}|{token: string}} creds - Credentials
   * @returns {Promise<Object[]>} Subscriptions as returned by the account service
   * @throws {Error} When authentication fails
   */
  static async getSubscriptions(url, creds) {
    const { authClient } = await this._getAuthClient(url, creds);
    return await authClient.getSubscriptions(undefined, false);
  }
}
