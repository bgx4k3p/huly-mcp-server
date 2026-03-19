/**
 * HulyClient - All business logic for interacting with Huly issue tracking.
 *
 * Helpers, constants, and markup utilities are in helpers.mjs.
 * JSDOM polyfills are initialized there before any SDK imports.
 */
import {
  PRIORITY_MAP, PRIORITY_NAMES,
  MILESTONE_STATUS_MAP, MILESTONE_STATUS_NAMES,
  COLOR_PALETTE, resolveColor,
  nameMatch, withExtra,
  toCollaboratorMarkup, fromCollaboratorMarkup,
  toMarkup, fromMarkup
} from './helpers.mjs';

export { PRIORITY_MAP, PRIORITY_NAMES, MILESTONE_STATUS_MAP, MILESTONE_STATUS_NAMES };

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Direct file requires to bypass package.json exports restrictions
const { getWorkspaceToken } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/utils.js'));
const { createRestTxOperations } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/rest/tx.js'));
const { getClient: getAccountClient } = require('@hcengineering/account-client');
const { loadServerConfig: loadConfig } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/config.js'));
const { generateId } = require('@hcengineering/core');
const { getClient: getCollaboratorClient } = require('@hcengineering/collaborator-client');

const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const contactPlugin = require('@hcengineering/contact').default;
const chunter = require('@hcengineering/chunter').default;
const task = require('@hcengineering/task').default;

/**
 * HulyClient encapsulates all business logic for a single workspace connection.
 */
export class HulyClient {
  /**
   * List all workspaces accessible to the authenticated user.
   * This is an account-level operation, not workspace-specific.
   *
   * @param {string} url - Huly server URL
   * @param {Object} creds - Credentials: { email, password } or { token }
   * @returns {Promise<Object[]>}
   */
  static async listWorkspaces(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
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
    if (HulyClient._authCache.token && now < HulyClient._authCache.expiresAt &&
        HulyClient._authCache._url === url && HulyClient._authCache._cacheKey === cacheKey) {
      return {
        authClient: getAccountClient(HulyClient._authCache.accountsUrl, HulyClient._authCache.token),
        token: HulyClient._authCache.token,
        accountId: HulyClient._authCache.accountId,
        accountsUrl: HulyClient._authCache.accountsUrl
      };
    }

    const config = await loadConfig(url);
    const accountsUrl = config.ACCOUNTS_URL;
    let token, accountId;

    if (creds.token) {
      // Token-based auth: use the token directly, extract accountId from JWT payload
      token = creds.token;
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        accountId = payload.account || null;
      } catch (e) {
        console.warn('Failed to parse JWT token:', e.message);
        accountId = null;
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

    HulyClient._authCache = {
      token,
      accountId,
      accountsUrl,
      expiresAt: now + 600000, // 10 min cache
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
    const { authClient, accountsUrl } = await HulyClient._getAuthClient(url, creds);

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
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
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
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.createWorkspace(name);
    return {
      message: `Workspace "${name}" created`,
      slug: result.url || result.workspace,
      uuid: result.uuid || result.workspaceId
    };
  }

  /**
   * Rename an existing workspace.
   */
  static async updateWorkspaceName(url, creds, workspaceSlug, newName) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    // Need to get workspace UUID first
    const workspaces = await authClient.getUserWorkspaces();
    const ws = workspaces.find(w => (w.url || w.workspace) === workspaceSlug);
    if (!ws) {
      throw new Error(`Workspace not found: ${workspaceSlug}`);
    }
    await authClient.updateWorkspaceName(ws.uuid, newName);
    return { message: `Workspace "${workspaceSlug}" renamed to "${newName}"` };
  }

  /**
   * Permanently delete a workspace.
   */
  static async deleteWorkspace(url, creds, workspaceSlug) {
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.deleteWorkspace();
    return { message: `Workspace "${workspaceSlug}" deleted permanently` };
  }

  /**
   * Get workspace members with roles.
   */
  static async getWorkspaceMembers(url, creds, workspaceSlug) {
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
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
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceRole(memberEmail, role);
    return { message: `Updated role for ${memberEmail} to ${role} in ${workspaceSlug}` };
  }

  /**
   * Get the current user's account info.
   */
  static async getAccountInfo(url, creds) {
    const { authClient, accountId } = await HulyClient._getAuthClient(url, creds);
    const info = await authClient.getAccountInfo(accountId);
    return info;
  }

  /**
   * Get the current user's profile.
   */
  static async getUserProfile(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const profile = await authClient.getUserProfile();
    return profile;
  }

  /**
   * Update the current user's profile.
   */
  static async setMyProfile(url, creds, name, city, country) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
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
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    if (!creds.password) {
      throw new Error('changePassword requires email/password auth, not token auth');
    }
    await authClient.changePassword(creds.password, newPassword);
    return { message: 'Password changed successfully' };
  }

  /**
   * Change the current user's username.
   */
  static async changeUsername(url, creds, newUsername) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    await authClient.changeUsername(newUsername);
    return { message: `Username changed to "${newUsername}"` };
  }

  // ── Invites ─────────────────────────────────────────────

  /**
   * Send an invite to join a workspace.
   */
  static async sendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const workspaces = await authClient.getUserWorkspaces();
    const ws = workspaces.find(w => (w.url || w.workspace) === workspaceSlug);
    if (!ws) throw new Error(`Workspace not found: ${workspaceSlug}`);
    await authClient.sendInvite(ws.uuid, inviteEmail, role || 'MEMBER');
    return { message: `Invite sent to ${inviteEmail} for workspace ${workspaceSlug}` };
  }

  /**
   * Resend a pending invite.
   */
  static async resendInvite(url, creds, workspaceSlug, inviteEmail) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const workspaces = await authClient.getUserWorkspaces();
    const ws = workspaces.find(w => (w.url || w.workspace) === workspaceSlug);
    if (!ws) throw new Error(`Workspace not found: ${workspaceSlug}`);
    await authClient.resendInvite(ws.uuid, inviteEmail);
    return { message: `Invite resent to ${inviteEmail}` };
  }

  /**
   * Create an invite link for a workspace.
   */
  static async createInviteLink(url, creds, workspaceSlug, role, expireHours) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const workspaces = await authClient.getUserWorkspaces();
    const ws = workspaces.find(w => (w.url || w.workspace) === workspaceSlug);
    if (!ws) throw new Error(`Workspace not found: ${workspaceSlug}`);
    const link = await authClient.createInviteLink(ws.uuid, role || 'MEMBER', expireHours || 48);
    return { link, workspace: workspaceSlug, role: role || 'MEMBER' };
  }

  // ── Integrations ────────────────────────────────────────

  /**
   * List all integrations.
   */
  static async listIntegrations(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const integrations = await authClient.listIntegrations();
    return integrations;
  }

  /**
   * Get a specific integration.
   */
  static async getIntegration(url, creds, integrationId) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const integration = await authClient.getIntegration(integrationId);
    return integration;
  }

  /**
   * Create a new integration.
   */
  static async createIntegration(url, creds, data) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.createIntegration(data);
    return result;
  }

  /**
   * Update an existing integration.
   */
  static async updateIntegration(url, creds, integrationId, data) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.updateIntegration(integrationId, data);
    return result;
  }

  /**
   * Delete an integration.
   */
  static async deleteIntegration(url, creds, integrationId) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    await authClient.deleteIntegration(integrationId);
    return { message: `Integration ${integrationId} deleted` };
  }

  // ── Mailboxes ───────────────────────────────────────────

  /**
   * List all mailboxes.
   */
  static async getMailboxes(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const mailboxes = await authClient.getMailboxes();
    return mailboxes;
  }

  /**
   * Create a new mailbox.
   */
  static async createMailbox(url, creds, mailboxData) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.createMailbox(mailboxData);
    return result;
  }

  /**
   * Delete a mailbox.
   */
  static async deleteMailbox(url, creds, mailboxId) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    await authClient.deleteMailbox(mailboxId);
    return { message: `Mailbox ${mailboxId} deleted` };
  }

  // ── Person / Social ID Management ──────────────────────

  /**
   * Find a person by social key.
   */
  static async findPersonBySocialKey(url, creds, socialKey) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const person = await authClient.findPersonBySocialKey(socialKey);
    return person;
  }

  /**
   * Get social IDs for the current user.
   */
  static async getSocialIds(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const socialIds = await authClient.getSocialIds();
    return socialIds;
  }

  /**
   * Add an email social ID to a person.
   */
  static async addEmailSocialId(url, creds, targetEmail) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.addEmailSocialId(targetEmail);
    return result;
  }

  // ── Subscriptions ───────────────────────────────────────

  /**
   * Get all subscriptions for the current account.
   */
  static async getSubscriptions(url, creds) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const subscriptions = await authClient.getSubscriptions(undefined, false);
    return subscriptions;
  }

  /**
   * @param {Object} opts
   * @param {string} opts.url - Huly server URL
   * @param {string} [opts.email] - Authentication email (required if no token)
   * @param {string} [opts.password] - Authentication password (required if no token)
   * @param {string} [opts.token] - Authentication token (alternative to email/password)
   * @param {string} opts.workspace - Workspace slug
   */
  constructor({ url, email, password, token, workspace }) {
    this.url = url;
    this.token = token || null;
    this.email = email || null;
    this.password = password || null;
    this.workspace = workspace;
    this._client = null;
    this._connectionPromise = null;
    this._collabClient = null;
    this._workspaceId = null;
    this._serverConfig = null;
  }

  /**
   * Establish a REST client connection to Huly.
   * @returns {Promise<void>}
   */
  async connect() {
    if (this._client) return;

    if (this._connectionPromise) {
      await this._connectionPromise;
      return;
    }

    this._connectionPromise = (async () => {
      if (!this.workspace) {
        throw new Error('Missing required config: workspace');
      }
      if (!this.token && (!this.email || !this.password)) {
        throw new Error('Missing required auth: set HULY_TOKEN or HULY_EMAIL + HULY_PASSWORD');
      }

      const authOpts = this.token
        ? { token: this.token, workspace: this.workspace }
        : { email: this.email, password: this.password, workspace: this.workspace };

      this._serverConfig = await loadConfig(this.url);
      const { endpoint, token, workspaceId } = await getWorkspaceToken(this.url, authOpts, this._serverConfig);
      this._workspaceId = workspaceId;
      this._wsToken = token;

      // Extract authenticated account UUID from JWT for ownership
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        this._accountUuid = payload.account || null;
      } catch {
        this._accountUuid = null;
      }

      this._client = await createRestTxOperations(endpoint, workspaceId, token);

      // Initialize collaborator client for rich text (issue descriptions)
      const collabUrl = (this._serverConfig.COLLABORATOR_URL || '')
        .replace('wss://', 'https://').replace('ws://', 'http://');
      if (collabUrl) {
        this._collabClient = getCollaboratorClient(workspaceId, token, collabUrl);
      }

      // SDK bug note: RestClientImpl.findAll crashes when lookupMap has null
      // entries (workspaces with custom task types). Fixed via postinstall
      // patch in scripts/patch-sdk.mjs. See hcengineering/huly.core#17.
    })();

    try {
      await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  /**
   * Disconnect and clear the cached client.
   */
  disconnect() {
    this._client = null;
    this._connectionPromise = null;
    this._collabClient = null;
    this._workspaceId = null;
    this._serverConfig = null;
    this._wsToken = null;
  }

  /**
   * Get the underlying SDK client, connecting if needed.
   * @returns {Promise<Object>}
   */
  async _getClient() {
    if (!this._client) {
      await this.connect();
    }
    return this._client;
  }

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
  async _readCollaboratorField(objectId, objectClass, attr = 'description') {
    if (!this._collabClient) {
      throw new Error('Collaborator client not initialized. Cannot read rich text fields.');
    }
    const docRef = { objectClass, objectId, objectAttr: attr };
    const markup = await this._collabClient.getMarkup(docRef);
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
   * @returns {Promise<boolean>} True if write succeeded
   */
  async _writeCollaboratorField(objectId, objectClass, text, format = 'markdown', attr = 'description') {
    if (!this._collabClient) {
      throw new Error('Collaborator client not initialized. Cannot write rich text fields.');
    }
    const docRef = { objectClass, objectId, objectAttr: attr };
    const markup = toCollaboratorMarkup(text, format);
    await this._collabClient.updateMarkup(docRef, markup);
  }

  /**
   * Execute an operation with automatic reconnect on connection failure.
   * @param {Function} operation - Async function to execute
   * @returns {Promise<*>}
   */
  async withReconnect(operation) {
    const maxRetries = 2;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isConnectionError = error.message?.includes('ConnectionClosed') ||
            error.message?.includes('connection') ||
            error.message?.includes('ECONNREFUSED') ||
            error.message?.includes('socket') ||
            error.code === 'ECONNRESET';
        if (isConnectionError && attempt < maxRetries) {
          console.error(`Connection lost, attempting reconnect (${attempt + 1}/${maxRetries})...`);
          this.disconnect();
          continue;
        }
        throw error;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────

  /**
   * Parse an issue identifier and find the corresponding issue and project.
   * @param {Object} client - Huly SDK client
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<{project: Object, issue: Object}>}
   */
  async _parseAndFindIssue(client, issueId) {
    const match = issueId.match(/^([A-Z0-9]+)-(\d+)$/i);
    if (!match) {
      throw new Error(`Invalid issue ID format: ${issueId}. Expected format: PROJECT-NUMBER`);
    }

    const [, projectId, issueNum] = match;

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectId.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectId}`);
    }

    const issue = await client.findOne(tracker.class.Issue, {
      space: project._id,
      number: parseInt(issueNum, 10)
    });

    if (!issue) {
      throw new Error(`Issue not found: ${issueId}`);
    }

    return { project, issue };
  }

  /**
   * Add a label to an issue, creating the tag element if it doesn't exist.
   * @param {Object} client - Huly SDK client
   * @param {string} issueId - Internal issue ID
   * @param {string} space - Project space ID
   * @param {string} labelName - Label name to add
   * @returns {Promise<Object>}
   */
  async _addLabelToIssue(client, issueId, space, labelName) {
    let tagElement = await client.findOne(tags.class.TagElement, {
      title: labelName,
      targetClass: tracker.class.Issue
    });

    if (!tagElement) {
      const tagId = generateId();
      await client.createDoc(tags.class.TagElement, space, {
        title: labelName,
        targetClass: tracker.class.Issue,
        description: '',
        color: 9,
        category: 'tracker:category:Other'
      }, tagId);
      tagElement = { _id: tagId, title: labelName, color: 9 };
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
   * Find a task type ID by its name within a project.
   * @param {Object} client - Huly SDK client
   * @param {string} projectIdent - Project identifier
   * @param {string} typeName - Task type name
   * @returns {Promise<string>}
   */
  async _findTaskTypeByName(client, projectIdent, typeName, cachedTaskTypes) {
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    // Use cached task types if provided (avoids N+1 in batch operations)
    const taskTypes = cachedTaskTypes || await client.findAll(task.class.TaskType, {});

    // Scope to project type if possible
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);
    const scopedTypes = projectType?.tasks
      ? taskTypes.filter(tt => projectType.tasks.includes(tt._id))
      : taskTypes;

    const found = scopedTypes.find(tt => {
      const name = tt.name || tt._id.split(':').pop();
      return nameMatch(name, typeName);
    });

    if (!found) {
      const availableTypes = scopedTypes.map(tt => tt.name || tt._id.split(':').pop()).join(', ');
      throw new Error(`Task type "${typeName}" not found. Available types: ${availableTypes}`);
    }

    return found._id;
  }

  /**
   * Get the default task type for a project from its project type config.
   * Returns the first task type scoped to the project type.
   */
  async _getDefaultTaskType(client, project) {
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);

    if (projectType?.tasks?.length) {
      const taskTypes = await client.findAll(task.class.TaskType, {});
      const scoped = taskTypes.filter(tt => projectType.tasks.includes(tt._id));
      if (scoped.length) return scoped[0]._id;
    }

    throw new Error(
      `No task types configured for project "${project.identifier}". ` +
      'Specify a type explicitly or configure task types in workspace settings.'
    );
  }

  /**
   * Get statuses scoped to a specific task type within a project.
   * Falls back to all statuses if task type has no scoped list.
   */
  async _getScopedStatuses(client, project, taskTypeId) {
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found in workspace');

    // Find the task type to get its scoped status list
    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskType = taskTypes.find(tt => tt._id === taskTypeId);

    if (taskType?.statuses?.length) {
      const scopedIds = new Set(taskType.statuses);
      const scoped = allStatuses.filter(s => scopedIds.has(s._id));
      if (scoped.length) return scoped;
    }

    return allStatuses;
  }

  /**
   * Paginated findAll — fetches results in batches to avoid data loss.
   * The SDK's findAll has a server-side page limit. If limit exceeds
   * the page size, this fetches multiple pages using createdOn cursor.
   */
  async _paginatedFindAll(client, _class, query, options = {}) {
    const PAGE_SIZE = 500;
    const limit = options.limit || PAGE_SIZE;

    // If within a single page, just fetch directly
    if (limit <= PAGE_SIZE) {
      return await client.findAll(_class, query, options);
    }

    // Fetch in pages using createdOn as cursor
    const allResults = [];
    let remaining = limit;
    let lastCreatedOn = undefined;

    while (remaining > 0) {
      const pageLimit = Math.min(remaining, PAGE_SIZE);
      const pageQuery = { ...query };
      if (lastCreatedOn !== undefined) {
        pageQuery.createdOn = { $lt: lastCreatedOn };
      }

      const page = await client.findAll(_class, pageQuery, {
        ...options,
        limit: pageLimit,
        sort: { createdOn: -1 }
      });

      if (page.length === 0) break;

      allResults.push(...page);
      remaining -= page.length;
      lastCreatedOn = page[page.length - 1].createdOn;

      // If we got less than requested, no more pages
      if (page.length < pageLimit) break;
    }

    return allResults;
  }

  async _findEmployeeByName(client, name) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const found = employees.find(e => nameMatch(e.name, name));
    return found ? found._id : null;
  }

  async _findMilestoneByName(client, projectId, name) {
    const ms = await client.findOne(tracker.class.Milestone, {
      space: projectId,
      label: name
    });
    return ms ? ms._id : null;
  }

  async _findComponentByName(client, projectId, name) {
    const comp = await client.findOne(tracker.class.Component, {
      space: projectId,
      label: name
    });
    return comp ? comp._id : null;
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * List all projects with issue counts.
   * @returns {Promise<Object[]>}
   */
  async listProjects() {
    const client = await this._getClient();
    const projects = await client.findAll(tracker.class.Project, {});

    // Count issues per project efficiently using the project's own sequence counter
    return projects.map(project => withExtra(project, {
      id: project._id,
      identifier: project.identifier,
      name: project.name || project.identifier,
      description: fromMarkup(project.description),
      archived: project.archived || false,
      private: project.private || false,
      members: project.members?.length || 0,
      issueCount: project.sequence || 0,
      createdOn: project.createdOn,
      modifiedOn: project.modifiedOn
    }));
  }

  /**
   * Get a project by its identifier.
   * @param {string} identifier - Project identifier (e.g., "PROJ")
   * @returns {Promise<Object>}
   */
  async getProject(identifier) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: identifier.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${identifier}`);
    }

    return withExtra(project, {
      id: project._id,
      identifier: project.identifier,
      name: project.name || project.identifier,
      description: fromMarkup(project.description),
      archived: project.archived || false,
      private: project.private || false,
      members: project.members?.length || 0,
      owners: project.owners?.length || 0,
      issueCount: project.sequence || 0,
      createdOn: project.createdOn,
      modifiedOn: project.modifiedOn
    });
  }

  /**
   * List issues in a project with optional filtering.
   * @param {string} project - Project identifier
   * @param {string} [status] - Filter by status name
   * @param {string} [priority] - Filter by priority level
   * @param {string} [label] - Filter by label name
   * @param {string} [milestone] - Filter by milestone name
   * @param {number} [limit=500] - Maximum number of issues
   * @returns {Promise<Object[]>}
   */
  async listIssues(project, status, priority, label, milestone, limit = 500) {
    const client = await this._getClient();

    const proj = await client.findOne(tracker.class.Project, {
      identifier: project.toUpperCase()
    });

    if (!proj) {
      throw new Error(`Project not found: ${project}`);
    }

    const query = { space: proj._id };

    if (priority) {
      query.priority = PRIORITY_MAP[priority.toLowerCase()] ?? 0;
    }

    // Resolve status name to ID for server-side filtering
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        // No matching status — return empty rather than all issues
        return [];
      }
    }

    const milestones = await client.findAll(tracker.class.Milestone, { space: proj._id });
    const milestoneMap = new Map(milestones.map(m => [m._id, m.label]));

    if (milestone) {
      const found = milestones.find(m => nameMatch(m.label, milestone));
      if (found) {
        query.milestone = found._id;
      }
    }

    let issues = await this._paginatedFindAll(client, tracker.class.Issue, query, {
      limit,
      sort: { modifiedOn: -1 }
    });

    let labelFilter = null;
    if (label) {
      const tagElements = await client.findAll(tags.class.TagElement, {
        title: label,
        targetClass: tracker.class.Issue
      });
      if (tagElements.length > 0) {
        labelFilter = tagElements[0]._id;
      }
    }

    // Batch fetch lookup maps for efficiency (avoids N+1)
    const issueIds = issues.map(i => i._id);
    const allLabels = issueIds.length > 0
      ? await client.findAll(tags.class.TagReference, {})
      : [];
    const labelsByIssue = new Map();
    for (const label of allLabels) {
      if (!labelsByIssue.has(label.attachedTo)) {
        labelsByIssue.set(label.attachedTo, []);
      }
      labelsByIssue.get(label.attachedTo).push(label);
    }

    // Task type map (kind ID → type name)
    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeMap = new Map(taskTypes.map(t => [t._id, t.name]));

    // Component map (ID → name)
    const components = await client.findAll(tracker.class.Component, { space: proj._id });
    const componentMap = new Map(components.map(c => [c._id, c.label]));

    // Employee map (ID → name)
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));

    // Parent issue map for hierarchy (batch lookup)
    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${proj.identifier}-${p.number}`]));

    // Done status IDs for completedAt detection
    const doneStatuses = new Set(statuses
      .filter(s => s.category === 'task:statusCategory:Won')
      .map(s => s._id));

    const result = [];
    for (const issue of issues) {
      const issueLabels = labelsByIssue.get(issue._id) || [];

      if (labelFilter && !issueLabels.some(l => l.tag === labelFilter)) {
        continue;
      }

      const statusName = statusMap.get(issue.status);
      if (!statusName) console.warn(`Status lookup failed for ID: ${issue.status}`);
      const priorityName = PRIORITY_NAMES[issue.priority];
      if (!priorityName) console.warn(`Priority lookup failed for value: ${issue.priority}`);

      result.push(withExtra(issue, {
        id: `${proj.identifier}-${issue.number}`,
        title: issue.title,
        status: statusName || 'Unknown',
        priority: priorityName || 'Unknown',
        type: taskTypeMap.get(issue.kind) || null,
        assignee: issue.assignee ? employeeMap.get(issue.assignee) || null : null,
        component: issue.component ? componentMap.get(issue.component) || null : null,
        labels: issueLabels.map(l => l.title),
        parent: issue.attachedTo ? parentMap.get(issue.attachedTo) || null : null,
        childCount: issue.subIssues || 0,
        milestone: issue.milestone ? milestoneMap.get(issue.milestone) || null : null,
        dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
        estimation: issue.estimation || 0,
        reportedTime: issue.reportedTime || 0,
        createdOn: issue.createdOn,
        modifiedOn: issue.modifiedOn,
        completedAt: doneStatuses.has(issue.status) ? issue.modifiedOn : null
      }));
    }

    return result;
  }

  /**
   * Get a specific issue by its identifier with full details.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<Object>}
   */
  async getIssue(issueId) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const status = await client.findOne(tracker.class.IssueStatus, { _id: issue.status });

    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeMap = new Map(taskTypes.map(t => [t._id, t.name]));

    // Employee map (ID → name)
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));

    // Component map (ID → name)
    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const componentMap = new Map(components.map(c => [c._id, c.label]));

    const issueLabels = await client.findAll(tags.class.TagReference, {
      attachedTo: issue._id
    });

    // Read description from collaborator service (where the UI stores rich text)
    let descriptionContent = '';
    const rawDesc = issue.description;
    if (typeof rawDesc === 'string' && /^[a-f0-9]+-\w+-\d+$/.test(rawDesc)) {
      // Collaborator reference — read from collaborator service
      descriptionContent = await this._readCollaboratorField(issue._id, issue._class);
    } else {
      descriptionContent = fromMarkup(rawDesc);
    }

    let parentId = null;
    if (issue.attachedTo && issue.attachedToClass === tracker.class.Issue) {
      const parentIssue = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
      if (parentIssue) {
        const parentProject = await client.findOne(tracker.class.Project, { _id: parentIssue.space });
        if (parentProject) {
          parentId = `${parentProject.identifier}-${parentIssue.number}`;
        }
      }
    }

    let milestoneInfo = null;
    if (issue.milestone) {
      const ms = await client.findOne(tracker.class.Milestone, { _id: issue.milestone });
      if (ms) {
        milestoneInfo = {
          id: ms._id,
          name: ms.label,
          status: MILESTONE_STATUS_NAMES[ms.status] || 'Unknown'
        };
      }
    }

    return withExtra(issue, {
      id: `${project.identifier}-${issue.number}`,
      title: issue.title,
      description: descriptionContent,
      status: status?.name || 'Unknown',
      priority: PRIORITY_NAMES[issue.priority] || 'Unknown',
      type: taskTypeMap.get(issue.kind) || issue.kind,
      assignee: issue.assignee ? employeeMap.get(issue.assignee) || null : null,
      component: issue.component ? componentMap.get(issue.component) || null : null,
      labels: issueLabels.map(l => l.title),
      parent: parentId,
      childCount: issue.subIssues || 0,
      milestone: milestoneInfo,
      dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
      estimation: issue.estimation || 0,
      reportedTime: issue.reportedTime || 0,
      createdOn: issue.createdOn,
      modifiedOn: issue.modifiedOn
    });
  }

  /**
   * Create a new issue in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} title - Issue title
   * @param {string} [description] - Markdown description
   * @param {string} [priority] - Priority level
   * @param {string} [status] - Initial status name
   * @param {string[]} [labels] - Label names to apply
   * @param {string} [type] - Task type name
   * @param {Object} [extra] - Additional fields: assignee, component, milestone, dueDate, estimation
   * @returns {Promise<Object>}
   */
  async createIssue(projectIdent, title, description, priority, status, labels, type, extra = {}) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const nextNumber = (project.sequence || 0) + 1;

    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      sequence: nextNumber
    });

    // Resolve task type first — status lookup depends on it
    let taskTypeId;
    if (type) {
      taskTypeId = await this._findTaskTypeByName(client, projectIdent, type);
    } else {
      taskTypeId = await this._getDefaultTaskType(client, project);
    }

    // Resolve status scoped to the task type
    const statuses = await this._getScopedStatuses(client, project, taskTypeId);
    let statusId;
    if (status) {
      const found = statuses.find(s => nameMatch(s.name, status));
      statusId = found?._id;
    }
    if (!statusId) {
      statusId = project.defaultIssueStatus || statuses[0]._id;
    }

    // Resolve optional extra fields
    let assigneeId = null;
    if (extra.assignee) {
      assigneeId = await this._findEmployeeByName(client, extra.assignee);
    }

    let componentId = null;
    if (extra.component) {
      componentId = await this._findComponentByName(client, project._id, extra.component);
    }

    let milestoneId = null;
    if (extra.milestone) {
      milestoneId = await this._findMilestoneByName(client, project._id, extra.milestone);
    }

    const issueId = generateId();
    await client.addCollection(
      tracker.class.Issue,
      project._id,
      project._id,
      tracker.class.Project,
      'issues',
      {
        title,
        identifier: `${project.identifier}-${nextNumber}`,
        description: '',
        status: statusId,
        priority: PRIORITY_MAP[priority?.toLowerCase()] ?? 0,
        number: nextNumber,
        assignee: assigneeId,
        component: componentId,
        milestone: milestoneId,
        estimation: extra.estimation || 0,
        dueDate: extra.dueDate ? new Date(extra.dueDate).getTime() : null,
        remainingTime: 0,
        reportedTime: 0,
        childInfo: [],
        parents: [],
        kind: taskTypeId
      },
      issueId
    );

    if (description) {
      // Write description via collaborator for proper UI rendering.
      // For new issues, set a collaborator reference on the doc first,
      // then write content to the collaborator service.
      const refId = `${issueId}-description-${Date.now()}`;
      await client.updateDoc(tracker.class.Issue, project._id, issueId, {
        description: refId
      });
      await this._writeCollaboratorField(
        issueId, tracker.class.Issue, description, extra.descriptionFormat
      );
    }

    if (labels && labels.length > 0) {
      for (const labelName of labels) {
        await this._addLabelToIssue(client, issueId, project._id, labelName);
      }
    }

    return {
      id: `${project.identifier}-${nextNumber}`,
      internalId: issueId,
      title,
      status: status || 'Todo',
      priority: priority || 'none'
    };
  }

  /**
   * Update fields on an existing issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} [title] - New title
   * @param {string} [description] - New description
   * @param {string} [priority] - New priority
   * @param {string} [status] - New status name
   * @param {string} [type] - New task type name
   * @param {Object} [extra] - Additional fields: assignee, component, milestone, dueDate, estimation
   * @returns {Promise<Object>}
   */
  async updateIssue(issueId, title, description, priority, status, type, extra = {}) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const updates = {};
    const updatedFields = [];

    if (title !== undefined) {
      updates.title = title;
      updatedFields.push('title');
    }

    if (priority !== undefined) {
      updates.priority = PRIORITY_MAP[priority.toLowerCase()] ?? issue.priority;
      updatedFields.push('priority');
    }

    if (status !== undefined) {
      const taskTypeId = issue.kind || await this._getDefaultTaskType(client, project);
      const statuses = await this._getScopedStatuses(client, project, taskTypeId);
      const found = statuses.find(s => nameMatch(s.name, status));
      if (found) {
        updates.status = found._id;
        updatedFields.push('status');
      }
    }

    if (type !== undefined) {
      const taskTypeId = await this._findTaskTypeByName(client, project.identifier, type);
      updates.kind = taskTypeId;
      updatedFields.push('type');
    }

    if (extra.assignee !== undefined) {
      const assigneeId = await this._findEmployeeByName(client, extra.assignee);
      if (assigneeId) {
        updates.assignee = assigneeId;
        updatedFields.push('assignee');
      }
    }

    if (extra.component !== undefined) {
      const componentId = await this._findComponentByName(client, project._id, extra.component);
      if (componentId) {
        updates.component = componentId;
        updatedFields.push('component');
      }
    }

    if (extra.milestone !== undefined) {
      const milestoneId = await this._findMilestoneByName(client, project._id, extra.milestone);
      if (milestoneId) {
        updates.milestone = milestoneId;
        updatedFields.push('milestone');
      }
    }

    if (extra.dueDate !== undefined) {
      updates.dueDate = extra.dueDate ? new Date(extra.dueDate).getTime() : null;
      updatedFields.push('dueDate');
    }

    if (extra.estimation !== undefined) {
      updates.estimation = extra.estimation;
      updatedFields.push('estimation');
    }

    if (Object.keys(updates).length > 0) {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, updates);
    }

    if (description !== undefined) {
      // Write description via collaborator service for proper UI rendering
      await this._writeCollaboratorField(
        issue._id, issue._class, description, extra.descriptionFormat
      );
      updatedFields.push('description');
    }

    return {
      id: issueId,
      updated: updatedFields
    };
  }

  /**
   * Add a label to an issue by issue identifier.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} labelName - Label name to add
   * @returns {Promise<Object>}
   */
  async addLabel(issueId, labelName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    return await this._addLabelToIssue(client, issue._id, project._id, labelName);
  }

  /**
   * Remove a label from an issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} labelName - Label name to remove
   * @returns {Promise<Object>}
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

    await client.removeDoc(tags.class.TagReference, tagRef.space, tagRef._id);

    return { message: `Label "${labelName}" removed` };
  }

  /**
   * List all available labels for issues.
   * @returns {Promise<Object[]>}
   */
  async listLabels() {
    const client = await this._getClient();

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });

    return tagElements.map(t => ({
      name: t.title,
      color: t.color ? `#${t.color.toString(16).padStart(6, '0')}` : null
    }));
  }

  /**
   * Create a new label for issues.
   * @param {string} name - Label name
   * @param {number} [color] - Label color as hex number
   * @returns {Promise<Object>}
   */
  async createLabel(name, color) {
    const client = await this._getClient();

    const existing = await client.findOne(tags.class.TagElement, {
      title: name,
      targetClass: tracker.class.Issue
    });

    if (existing) {
      return { message: `Label "${name}" already exists`, id: existing._id };
    }

    const project = await client.findOne(tracker.class.Project, {});
    const space = project ? project._id : 'tracker:project:Default';

    const tagId = generateId();
    await client.createDoc(tags.class.TagElement, space, {
      title: name,
      targetClass: tracker.class.Issue,
      description: '',
      color: resolveColor(color),
      category: 'tracker:category:Other'
    }, tagId);

    return { message: `Label "${name}" created`, id: tagId, name, color: resolveColor(color) };
  }

  /**
   * Update an existing label's name, color, or description.
   * @param {string} name - Current label name to find
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateLabel(name, updates = {}) {
    const client = await this._getClient();

    const tagElement = await client.findOne(tags.class.TagElement, {
      title: name,
      targetClass: tracker.class.Issue
    });

    if (!tagElement) {
      throw new Error(`Label "${name}" not found`);
    }

    const ops = {};
    if (updates.newName !== undefined) ops.title = updates.newName;
    if (updates.color !== undefined) ops.color = resolveColor(updates.color);
    if (updates.description !== undefined) ops.description = updates.description;

    if (Object.keys(ops).length === 0) {
      return { message: 'No updates specified', id: tagElement._id };
    }

    await client.updateDoc(tags.class.TagElement, tagElement.space, tagElement._id, ops);

    return {
      message: `Label "${name}" updated`,
      id: tagElement._id,
      updated: Object.keys(ops)
    };
  }

  /**
   * Add a "related to" relationship between two issues.
   * @param {string} issueId - Issue identifier
   * @param {string} relatedToIssueId - Related issue identifier
   * @returns {Promise<Object>}
   */
  async addRelation(issueId, relatedToIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: relatedIssue } = await this._parseAndFindIssue(client, relatedToIssueId);

    const currentRelations = issue.relations || [];

    const alreadyRelated = currentRelations.some(r => r._id === relatedIssue._id);
    if (alreadyRelated) {
      return { message: `Issues are already related` };
    }

    const newRelations = [...currentRelations, { _id: relatedIssue._id, _class: relatedIssue._class }];

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      relations: newRelations
    });

    return {
      message: `Added relation: ${issueId} is now related to ${relatedToIssueId}`,
      issueId,
      relatedToIssueId
    };
  }

  /**
   * Add a "blocked by" dependency between two issues.
   * @param {string} issueId - Issue that is blocked
   * @param {string} blockedByIssueId - The blocking issue
   * @returns {Promise<Object>}
   */
  async addBlockedBy(issueId, blockedByIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: blockingIssue } = await this._parseAndFindIssue(client, blockedByIssueId);

    const currentBlockedBy = issue.blockedBy || [];

    const alreadyBlocked = currentBlockedBy.some(r => r._id === blockingIssue._id);
    if (alreadyBlocked) {
      return { message: `${issueId} is already blocked by ${blockedByIssueId}` };
    }

    const newBlockedBy = [...currentBlockedBy, { _id: blockingIssue._id, _class: blockingIssue._class }];

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      blockedBy: newBlockedBy
    });

    return {
      message: `Added dependency: ${issueId} is now blocked by ${blockedByIssueId}`,
      issueId,
      blockedByIssueId
    };
  }

  /**
   * Set the parent issue for a child issue.
   * @param {string} issueId - Child issue identifier
   * @param {string} parentIssueId - Parent issue identifier
   * @returns {Promise<Object>}
   */
  async setParent(issueId, parentIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { project: parentProject, issue: parentIssue } = await this._parseAndFindIssue(client, parentIssueId);

    const parentInfo = {
      parentId: parentIssue._id,
      identifier: `${parentProject.identifier}-${parentIssue.number}`,
      parentTitle: parentIssue.title,
      space: parentProject._id
    };

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      parentIssue._id,
      tracker.class.Issue,
      'subIssues',
      {
        parents: [parentInfo],
        attachedTo: parentIssue._id,
        attachedToClass: tracker.class.Issue,
        collection: 'subIssues'
      }
    );

    const childInfo = {
      childId: issue._id,
      estimation: issue.estimation || 0,
      reportedTime: issue.reportedTime || 0
    };

    const currentChildInfo = parentIssue.childInfo || [];

    const existingIndex = currentChildInfo.findIndex(c => c.childId === issue._id);
    let updatedChildInfo;
    if (existingIndex >= 0) {
      updatedChildInfo = [...currentChildInfo];
      updatedChildInfo[existingIndex] = childInfo;
    } else {
      updatedChildInfo = [...currentChildInfo, childInfo];
    }

    await client.updateDoc(tracker.class.Issue, parentProject._id, parentIssue._id, {
      childInfo: updatedChildInfo,
      subIssues: updatedChildInfo.length
    });

    return {
      message: `Set parent: ${issueId} is now a child of ${parentIssueId}`,
      issueId,
      parentIssueId,
      parentChildCount: updatedChildInfo.length
    };
  }

  /**
   * List all available task types for a project.
   * @param {string} projectIdent - Project identifier
   * @returns {Promise<Object[]>}
   */
  async listTaskTypes(projectIdent) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    // Scope task types to project via its ProjectType
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);

    let typesToReturn;
    if (projectType && projectType.tasks) {
      // Return only task types belonging to this project's type
      const taskTypeIds = new Set(projectType.tasks);
      typesToReturn = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    } else {
      // Fallback: return tracker-related task types
      typesToReturn = allTaskTypes.filter(tt =>
        tt.ofClass === tracker.class.Issue ||
        tt.targetClass === tracker.class.Issue
      );
    }

    return typesToReturn.map(tt => ({
      id: tt._id,
      name: tt.name || tt._id.split(':').pop(),
      description: fromMarkup(tt.description),
      ofClass: tt.ofClass,
      parent: tt.parent,
      statuses: tt.statuses || []
    }));
  }

  /**
   * List available issue statuses, optionally scoped to a project or task type.
   * @param {string} [projectIdent] - Project identifier to scope statuses
   * @param {string} [taskTypeName] - Task type name to scope statuses (e.g., "Task", "Epic")
   * @returns {Promise<Object[]>}
   */
  async listStatuses(projectIdent, taskTypeName) {
    const client = await this._getClient();

    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});

    // If no scoping requested, return all
    if (!projectIdent && !taskTypeName) {
      return allStatuses.map(s => ({
        id: s._id,
        name: s.name,
        category: s.category,
        color: s.color,
        description: fromMarkup(s.description)
      }));
    }

    // Get task types scoped to this project
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    let relevantTaskTypes = allTaskTypes;

    if (projectIdent) {
      const project = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (project) {
        const projectTypes = await client.findAll(task.class.ProjectType, {});
        const projectType = projectTypes.find(pt => pt._id === project.type);
        if (projectType && projectType.tasks) {
          const taskTypeIds = new Set(projectType.tasks);
          relevantTaskTypes = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
        }
      }
    }

    // Further filter by task type name
    if (taskTypeName) {
      relevantTaskTypes = relevantTaskTypes.filter(tt => nameMatch(tt.name, taskTypeName));
    }

    // Collect status IDs from matching task types
    const statusIds = new Set();
    for (const tt of relevantTaskTypes) {
      if (tt.statuses) {
        for (const sid of tt.statuses) {
          statusIds.add(sid);
        }
      }
    }

    // Filter statuses to only those in scope
    const scopedStatuses = statusIds.size > 0
      ? allStatuses.filter(s => statusIds.has(s._id))
      : allStatuses;

    return scopedStatuses.map(s => ({
      id: s._id,
      name: s.name,
      category: s.category,
      color: s.color,
      description: s.description || ''
    }));
  }

  /**
   * List all milestones in a project with optional status filtering.
   * @param {string} projectIdent - Project identifier
   * @param {string} [status] - Filter by status
   * @returns {Promise<Object[]>}
   */
  async listMilestones(projectIdent, status) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const query = { space: project._id };

    if (status) {
      const statusValue = MILESTONE_STATUS_MAP[status.toLowerCase()];
      if (statusValue !== undefined) {
        query.status = statusValue;
      }
    }

    const milestones = await client.findAll(tracker.class.Milestone, query, {
      sort: { targetDate: 1 }
    });

    return milestones.map(m => withExtra(m, {
      id: m._id,
      name: m.label,
      description: fromMarkup(m.description),
      status: MILESTONE_STATUS_NAMES[m.status] || 'Unknown',
      targetDate: m.targetDate ? new Date(m.targetDate).toISOString().split('T')[0] : null,
      comments: m.comments || 0
    }));
  }

  /**
   * Get a specific milestone by name with issue count.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Milestone name
   * @returns {Promise<Object>}
   */
  async getMilestone(projectIdent, name) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const milestones = await client.findAll(tracker.class.Milestone, {
      space: project._id
    });

    const milestone = milestones.find(m => nameMatch(m.label, name));

    if (!milestone) {
      throw new Error(`Milestone not found: ${name}`);
    }

    const issues = await client.findAll(tracker.class.Issue, {
      space: project._id,
      milestone: milestone._id
    });

    return withExtra(milestone, {
      id: milestone._id,
      name: milestone.label,
      description: fromMarkup(milestone.description),
      status: MILESTONE_STATUS_NAMES[milestone.status] || 'Unknown',
      targetDate: milestone.targetDate ? new Date(milestone.targetDate).toISOString().split('T')[0] : null,
      comments: milestone.comments || 0,
      issueCount: issues.length
    });
  }

  /**
   * Create a new milestone in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Milestone name
   * @param {string} [description] - Milestone description
   * @param {string} [targetDate] - Target date ISO 8601
   * @param {string} [status] - Initial status
   * @returns {Promise<Object>}
   */
  async createMilestone(projectIdent, name, description, targetDate, status, format) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const existing = await client.findOne(tracker.class.Milestone, {
      space: project._id,
      label: name
    });

    if (existing) {
      return {
        message: `Milestone "${name}" already exists`,
        id: existing._id,
        name: existing.label
      };
    }

    let targetTimestamp = Date.now() + (30 * 24 * 60 * 60 * 1000);
    if (targetDate) {
      const parsed = new Date(targetDate);
      if (!isNaN(parsed.getTime())) {
        targetTimestamp = parsed.getTime();
      }
    }

    let statusValue = 0;
    if (status) {
      const parsed = MILESTONE_STATUS_MAP[status.toLowerCase()];
      if (parsed !== undefined) {
        statusValue = parsed;
      }
    }

    const milestoneId = generateId();
    await client.createDoc(tracker.class.Milestone, project._id, {
      label: name,
      description: toMarkup(description || '', format),
      status: statusValue,
      targetDate: targetTimestamp,
      comments: 0,
      attachments: 0
    }, milestoneId);

    return {
      message: `Milestone "${name}" created`,
      id: milestoneId,
      name,
      description: description || '',
      status: MILESTONE_STATUS_NAMES[statusValue],
      targetDate: new Date(targetTimestamp).toISOString().split('T')[0]
    };
  }

  /**
   * Set or clear the milestone for an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} [milestoneName] - Milestone name or empty to clear
   * @returns {Promise<Object>}
   */
  async setMilestone(issueId, milestoneName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    if (!milestoneName || milestoneName.trim() === '') {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
        milestone: null
      });
      return {
        message: `Cleared milestone from ${issueId}`,
        issueId,
        milestone: null
      };
    }

    const milestones = await client.findAll(tracker.class.Milestone, {
      space: project._id
    });

    const milestone = milestones.find(m => nameMatch(m.label, milestoneName));

    if (!milestone) {
      const available = milestones.map(m => m.label).join(', ');
      throw new Error(`Milestone "${milestoneName}" not found. Available milestones: ${available || 'none'}`);
    }

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      milestone: milestone._id
    });

    return {
      message: `Set milestone "${milestone.label}" on ${issueId}`,
      issueId,
      milestone: {
        id: milestone._id,
        name: milestone.label
      }
    };
  }

  /**
   * List all active workspace members.
   * @returns {Promise<Object[]>}
   */
  async listMembers() {
    const client = await this._getClient();
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    return employees.map(e => withExtra(e, {
      id: e._id,
      name: e.name,
      email: e.channels?.[0]?.value || null,
      role: e.role || 'USER',
      position: e.position || null
    }));
  }

  /**
   * Assign an issue to a workspace member or unassign it.
   * @param {string} issueId - Issue identifier
   * @param {string} assigneeName - Member name or email, empty to unassign
   * @returns {Promise<Object>}
   */
  async assignIssue(issueId, assigneeName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    if (!assigneeName || assigneeName.trim() === '') {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
        assignee: null
      });
      return { message: `Unassigned ${issueId}`, issueId };
    }

    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const found = employees.find(e =>
      e.name?.toLowerCase().includes(assigneeName.toLowerCase())
    );

    if (!found) {
      const names = employees.map(e => e.name).join(', ');
      throw new Error(`Member "${assigneeName}" not found. Available: ${names}`);
    }

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      assignee: found._id
    });

    return { message: `Assigned ${issueId} to ${found.name}`, issueId, assignee: found.name };
  }

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
      { message: toMarkup(text, format), attachments: 0 },
      commentId
    );

    return { message: `Comment added to ${issueId}`, id: commentId };
  }

  /**
   * List all comments on an issue.
   * @param {string} issueId - Issue identifier
   * @returns {Promise<Object[]>}
   */
  async listComments(issueId) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const comments = await client.findAll(chunter.class.ChatMessage, {
      attachedTo: issue._id
    }, { sort: { createdOn: 1 } });

    return comments.map(c => withExtra(c, {
      id: c._id,
      text: fromMarkup(c.message),
      createdBy: c.createdBy || null,
      createdOn: c.createdOn,
      modifiedOn: c.modifiedOn
    }));
  }

  /**
   * Set or clear the due date on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} [dueDate] - Due date ISO 8601, or empty to clear
   * @returns {Promise<Object>}
   */
  async setDueDate(issueId, dueDate) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    let timestamp = null;
    if (dueDate && dueDate.trim() !== '') {
      const parsed = new Date(dueDate);
      if (isNaN(parsed.getTime())) {
        throw new Error(`Invalid date: ${dueDate}`);
      }
      timestamp = parsed.getTime();
    }

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      dueDate: timestamp
    });

    return {
      message: timestamp ? `Due date set to ${dueDate} on ${issueId}` : `Due date cleared on ${issueId}`,
      issueId,
      dueDate: dueDate || null
    };
  }

  /**
   * Set the time estimation on an issue.
   * @param {string} issueId - Issue identifier
   * @param {number} hours - Estimated hours
   * @returns {Promise<Object>}
   */
  async setEstimation(issueId, hours) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      estimation: hours
    });

    return { message: `Estimation set to ${hours}h on ${issueId}`, issueId, estimation: hours };
  }

  /**
   * Log time spent on an issue.
   * @param {string} issueId - Issue identifier
   * @param {number} hours - Hours spent
   * @param {string} [description] - Description of work done
   * @returns {Promise<Object>}
   */
  async logTime(issueId, hours, description, format) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const reportId = generateId();
    await client.addCollection(
      tracker.class.TimeSpendReport,
      project._id,
      issue._id,
      tracker.class.Issue,
      'reports',
      {
        employee: null,
        date: Date.now(),
        value: hours,
        description: toMarkup(description || '', format)
      },
      reportId
    );

    const newReported = (issue.reportedTime || 0) + hours;
    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      reportedTime: newReported
    });

    return {
      message: `Logged ${hours}h on ${issueId}`,
      issueId,
      reportedTime: newReported,
      id: reportId
    };
  }

  /**
   * Search issues by text across all projects.
   * @param {string} query - Search text
   * @param {string} [projectIdent] - Optional project to limit search
   * @param {number} [limit=200] - Maximum results
   * @returns {Promise<Object[]>}
   */
  async searchIssues(query, projectIdent, limit = 20) {
    const client = await this._getClient();

    const searchQuery = { $search: query };

    if (projectIdent) {
      const proj = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (proj) {
        searchQuery.space = proj._id;
      }
    }

    const issues = await client.findAll(tracker.class.Issue, searchQuery, { limit });

    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeMap = new Map(taskTypes.map(t => [t._id, t.name]));

    // Employee map (ID → name)
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));

    // Component map (ID → name) — gather all unique spaces from results
    const spaceIds = [...new Set(issues.map(i => i.space))];
    const allComponents = spaceIds.length > 0
      ? await client.findAll(tracker.class.Component, { space: { $in: spaceIds } })
      : [];
    const componentMap = new Map(allComponents.map(c => [c._id, c.label]));

    // Milestone map (ID → name)
    const allMilestones = spaceIds.length > 0
      ? await client.findAll(tracker.class.Milestone, { space: { $in: spaceIds } })
      : [];
    const milestoneMap = new Map(allMilestones.map(m => [m._id, m.label]));

    const doneStatuses = new Set(statuses
      .filter(s => s.category === 'task:statusCategory:Won')
      .map(s => s._id));

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) || '?'}-${p.number}`]));

    return issues.map(i => withExtra(i, {
      id: `${projMap.get(i.space) || '?'}-${i.number}`,
      title: i.title,
      status: statusMap.get(i.status) || 'Unknown',
      priority: PRIORITY_NAMES[i.priority] || 'Unknown',
      type: taskTypeMap.get(i.kind) || null,
      assignee: i.assignee ? employeeMap.get(i.assignee) || null : null,
      component: i.component ? componentMap.get(i.component) || null : null,
      milestone: i.milestone ? milestoneMap.get(i.milestone) || null : null,
      parent: i.attachedTo ? parentMap.get(i.attachedTo) || null : null,
      childCount: i.subIssues || 0,
      dueDate: i.dueDate ? new Date(i.dueDate).toISOString().split('T')[0] : null,
      createdOn: i.createdOn,
      modifiedOn: i.modifiedOn,
      completedAt: doneStatuses.has(i.status) ? i.modifiedOn : null
    }));
  }

  // ── New Methods (Tier 1–2) ─────────────────────────────────────

  /**
   * Get issues assigned to the currently authenticated user.
   * @param {string} [projectIdent] - Optional project filter
   * @param {string} [status] - Optional status filter
   * @param {number} [limit=500] - Maximum results
   * @returns {Promise<Object[]>}
   */
  async getMyIssues(projectIdent, status, limit = 500) {
    const client = await this._getClient();

    // Find the current user's employee record via email channels or account matching
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });

    // Try matching by email in channels
    let me = employees.find(e => {
      const channels = e.channels || [];
      return channels.some(ch => ch.value?.toLowerCase() === this.email?.toLowerCase());
    });

    // Fallback: if only one employee, assume it's the current user
    if (!me && employees.length === 1) {
      me = employees[0];
    }

    // Fallback: try matching by PersonAccount email
    if (!me) {
      try {
        const accounts = await client.findAll('contact:class:PersonAccount', {});
        const myAccount = accounts.find(a => a.email?.toLowerCase() === this.email?.toLowerCase());
        if (myAccount) {
          me = employees.find(e => e._id === myAccount.person);
        }
      } catch (e) {
        throw new Error(`Failed to look up PersonAccount: ${e.message}. The PersonAccount class may not exist in this workspace.`);
      }
    }

    if (!me) {
      throw new Error('Could not find current user. Ensure HULY_EMAIL matches your workspace member email, or use HULY_TOKEN.');
    }

    const query = { assignee: me._id };

    if (projectIdent) {
      const proj = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (proj) {
        query.space = proj._id;
      }
    }

    // Resolve status name to ID for server-side filtering
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        return [];
      }
    }

    let issues = await this._paginatedFindAll(client, tracker.class.Issue, query, {
      limit,
      sort: { modifiedOn: -1 }
    });

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    // Batch fetch all labels for efficiency (avoids N+1)
    const issueIds = issues.map(i => i._id);
    const allLabels = issueIds.length > 0
      ? await client.findAll(tags.class.TagReference, {})
      : [];
    const labelsByIssue = new Map();
    for (const label of allLabels) {
      if (!labelsByIssue.has(label.attachedTo)) {
        labelsByIssue.set(label.attachedTo, []);
      }
      labelsByIssue.get(label.attachedTo).push(label);
    }

    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeMap = new Map(taskTypes.map(t => [t._id, t.name]));

    // Employee map (ID → name) — reuse already-fetched employees list
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));

    // Component map (ID → name)
    const spaceIds = [...new Set(issues.map(i => i.space))];
    const allComponents = spaceIds.length > 0
      ? await client.findAll(tracker.class.Component, { space: { $in: spaceIds } })
      : [];
    const componentMap = new Map(allComponents.map(c => [c._id, c.label]));

    // Milestone map (ID → name)
    const allMilestones = spaceIds.length > 0
      ? await client.findAll(tracker.class.Milestone, { space: { $in: spaceIds } })
      : [];
    const milestoneMap = new Map(allMilestones.map(m => [m._id, m.label]));

    const doneStatuses = new Set(statuses
      .filter(s => s.category === 'task:statusCategory:Won')
      .map(s => s._id));

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) || '?'}-${p.number}`]));

    const result = [];
    for (const issue of issues) {
      const issueLabels = labelsByIssue.get(issue._id) || [];
      const statusName = statusMap.get(issue.status);
      if (!statusName) console.warn(`Status lookup failed for ID: ${issue.status}`);
      const priorityName = PRIORITY_NAMES[issue.priority];
      if (!priorityName) console.warn(`Priority lookup failed for value: ${issue.priority}`);

      result.push(withExtra(issue, {
        id: `${projMap.get(issue.space) || '?'}-${issue.number}`,
        title: issue.title,
        status: statusName || 'Unknown',
        priority: priorityName || 'Unknown',
        type: taskTypeMap.get(issue.kind) || null,
        assignee: issue.assignee ? employeeMap.get(issue.assignee) || null : null,
        component: issue.component ? componentMap.get(issue.component) || null : null,
        labels: issueLabels.map(l => l.title),
        parent: issue.attachedTo ? parentMap.get(issue.attachedTo) || null : null,
        childCount: issue.subIssues || 0,
        milestone: issue.milestone ? milestoneMap.get(issue.milestone) || null : null,
        dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
        estimation: issue.estimation || 0,
        reportedTime: issue.reportedTime || 0,
        createdOn: issue.createdOn,
        modifiedOn: issue.modifiedOn,
        completedAt: doneStatuses.has(issue.status) ? issue.modifiedOn : null
      }));
    }

    return result;
  }

  /**
   * Create multiple issues in a single batch.
   * @param {string} projectIdent - Project identifier
   * @param {Object[]} issues - Array of issue objects with { title, description, priority, status, labels, type }
   * @returns {Promise<Object>}
   */
  async batchCreateIssues(projectIdent, issues) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    if (!Array.isArray(issues) || issues.length === 0) {
      throw new Error('issues must be a non-empty array');
    }
    if (issues.length > 500) throw new Error('Batch size limited to 500 issues');

    // Cache lookups to avoid N+1 queries in the loop
    const cachedTaskTypes = await client.findAll(task.class.TaskType, {});
    const defaultTaskTypeId = await this._getDefaultTaskType(client, project);
    const scopedStatuses = await this._getScopedStatuses(client, project, defaultTaskTypeId);
    const defaultStatusId = project.defaultIssueStatus || scopedStatuses[0]._id;
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });

    const created = [];
    let currentSequence = project.sequence || 0;

    for (const item of issues) {
      if (!item.title) {
        created.push({ error: 'Missing title', input: item });
        continue;
      }

      currentSequence++;

      let statusId = defaultStatusId;
      if (item.status) {
        const found = scopedStatuses.find(s => nameMatch(s.name, item.status));
        if (found) statusId = found._id;
      }

      let taskTypeId;
      if (item.type) {
        taskTypeId = await this._findTaskTypeByName(client, projectIdent, item.type, cachedTaskTypes);
      } else {
        taskTypeId = defaultTaskTypeId;
      }

      // Resolve optional fields from cached lookups
      let assigneeId = null;
      if (item.assignee) {
        const found = employees.find(e => nameMatch(e.name, item.assignee));
        if (found) assigneeId = found._id;
      }

      let componentId = null;
      if (item.component) {
        const found = components.find(c => nameMatch(c.label, item.component));
        if (found) componentId = found._id;
      }

      let milestoneId = null;
      if (item.milestone) {
        const found = milestones.find(m => nameMatch(m.label, item.milestone));
        if (found) milestoneId = found._id;
      }

      const issueId = generateId();
      await client.addCollection(
        tracker.class.Issue,
        project._id,
        project._id,
        tracker.class.Project,
        'issues',
        {
          title: item.title,
          identifier: `${project.identifier}-${currentSequence}`,
          description: '',
          status: statusId,
          priority: PRIORITY_MAP[item.priority?.toLowerCase()] ?? 0,
          number: currentSequence,
          assignee: assigneeId,
          component: componentId,
          milestone: milestoneId,
          estimation: item.estimation || 0,
          dueDate: item.dueDate ? new Date(item.dueDate).getTime() : null,
          remainingTime: 0,
          reportedTime: 0,
          childInfo: [],
          parents: [],
          kind: taskTypeId
        },
        issueId
      );

      if (item.description) {
        await client.updateDoc(tracker.class.Issue, project._id, issueId, {
          description: toMarkup(item.description, item.descriptionFormat)
        });
      }

      if (item.labels && item.labels.length > 0) {
        for (const labelName of item.labels) {
          await this._addLabelToIssue(client, issueId, project._id, labelName);
        }
      }

      created.push({
        id: `${project.identifier}-${currentSequence}`,
        internalId: issueId,
        title: item.title,
        status: item.status || 'Todo',
        priority: item.priority || 'none'
      });
    }

    // Update sequence number
    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      sequence: currentSequence
    });

    return {
      project: project.identifier,
      created: created.filter(c => !c.error),
      errors: created.filter(c => c.error),
      total: created.filter(c => !c.error).length
    };
  }

  /**
   * Move an issue to a different project.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} targetProject - Target project identifier
   * @returns {Promise<Object>}
   */
  async moveIssue(issueId, targetProject) {
    const client = await this._getClient();

    const { project: sourceProject, issue } = await this._parseAndFindIssue(client, issueId);

    const destProject = await client.findOne(tracker.class.Project, {
      identifier: targetProject.toUpperCase()
    });

    if (!destProject) {
      throw new Error(`Target project not found: ${targetProject}`);
    }

    if (sourceProject._id === destProject._id) {
      return { message: `Issue ${issueId} is already in project ${targetProject}` };
    }

    // Get next number in target project
    const nextNumber = (destProject.sequence || 0) + 1;
    await client.updateDoc(tracker.class.Project, destProject.space || destProject._id, destProject._id, {
      sequence: nextNumber
    });

    // Update the issue's space and number
    await client.updateDoc(tracker.class.Issue, sourceProject._id, issue._id, {
      space: destProject._id,
      number: nextNumber,
      identifier: `${destProject.identifier}-${nextNumber}`
    });

    const newId = `${destProject.identifier}-${nextNumber}`;

    return {
      message: `Moved ${issueId} to ${newId}`,
      oldId: issueId,
      newId,
      sourceProject: sourceProject.identifier,
      targetProject: destProject.identifier
    };
  }

  /**
   * Get a project summary with issue counts by status, priority, and overdue info.
   * @param {string} projectIdent - Project identifier
   * @returns {Promise<Object>}
   */
  async summarizeProject(projectIdent) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const issues = await client.findAll(tracker.class.Issue, { space: project._id });
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });

    // Count by status
    const byStatus = {};
    for (const issue of issues) {
      const name = statusMap.get(issue.status);
      if (!name) console.warn(`Status lookup failed for ID: ${issue.status}`);
      byStatus[name || 'Unknown'] = (byStatus[name || 'Unknown'] || 0) + 1;
    }

    // Count by priority
    const byPriority = {};
    for (const issue of issues) {
      const name = PRIORITY_NAMES[issue.priority];
      if (!name) console.warn(`Priority lookup failed for value: ${issue.priority}`);
      byPriority[name || 'Unknown'] = (byPriority[name || 'Unknown'] || 0) + 1;
    }

    // Overdue issues
    const now = Date.now();
    const overdue = issues.filter(i => {
      if (!i.dueDate) return false;
      const statusName = (statusMap.get(i.status) || '').toLowerCase();
      return i.dueDate < now && statusName !== 'done' && statusName !== 'canceled';
    });

    const overdueList = overdue.map(i => ({
      id: `${project.identifier}-${i.number}`,
      title: i.title,
      dueDate: new Date(i.dueDate).toISOString().split('T')[0],
      priority: PRIORITY_NAMES[i.priority] || 'Unknown'
    }));

    // Unassigned count
    const unassigned = issues.filter(i => !i.assignee).length;

    // Estimation stats
    const totalEstimation = issues.reduce((sum, i) => sum + (i.estimation || 0), 0);
    const totalReported = issues.reduce((sum, i) => sum + (i.reportedTime || 0), 0);

    return {
      project: {
        identifier: project.identifier,
        name: project.name || project.identifier
      },
      totalIssues: issues.length,
      byStatus,
      byPriority,
      overdue: {
        count: overdueList.length,
        issues: overdueList
      },
      unassigned,
      milestones: milestones.map(m => ({
        name: m.label,
        status: MILESTONE_STATUS_NAMES[m.status] || 'Unknown',
        targetDate: m.targetDate ? new Date(m.targetDate).toISOString().split('T')[0] : null
      })),
      timeTracking: {
        totalEstimatedHours: totalEstimation,
        totalReportedHours: totalReported
      }
    };
  }

  /**
   * Get the modification history / activity for an issue.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<Object>}
   */
  async getIssueHistory(issueId) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // Get comments as activity
    const comments = await client.findAll(chunter.class.ChatMessage, {
      attachedTo: issue._id
    }, { sort: { createdOn: 1 } });

    // Get time reports
    const timeReports = await client.findAll(tracker.class.TimeSpendReport, {
      attachedTo: issue._id
    }, { sort: { date: 1 } });

    // Get sub-issues
    const subIssues = await client.findAll(tracker.class.Issue, {
      attachedTo: issue._id,
      attachedToClass: tracker.class.Issue
    });

    // Get labels
    const issueLabels = await client.findAll(tags.class.TagReference, {
      attachedTo: issue._id
    });

    // Build activity timeline
    const activity = [];

    for (const c of comments) {
      activity.push({
        type: 'comment',
        text: fromMarkup(c.message),
        date: c.createdOn,
        dateFormatted: c.createdOn ? new Date(c.createdOn).toISOString() : null
      });
    }

    for (const tr of timeReports) {
      activity.push({
        type: 'time_logged',
        hours: tr.value,
        description: fromMarkup(tr.description),
        date: tr.date,
        dateFormatted: tr.date ? new Date(tr.date).toISOString() : null
      });
    }

    // Sort by date
    activity.sort((a, b) => (a.date || 0) - (b.date || 0));

    return {
      issueId,
      title: issue.title,
      createdOn: issue.createdOn ? new Date(issue.createdOn).toISOString() : null,
      modifiedOn: issue.modifiedOn ? new Date(issue.modifiedOn).toISOString() : null,
      subIssues: subIssues.map(si => ({
        id: `${project.identifier}-${si.number}`,
        title: si.title
      })),
      labels: issueLabels.map(l => l.title),
      activity
    };
  }

  /**
   * Create a batch of issues from a template definition.
   * @param {string} projectIdent - Project identifier
   * @param {string} templateName - Template name (determines the structure)
   * @param {Object} [params] - Template parameters (e.g., { featureName, epicTitle })
   * @returns {Promise<Object>}
   */
  async createIssuesFromTemplate(projectIdent, templateName, params = {}) {
    const templates = {
      'feature': {
        description: 'Standard feature development workflow',
        issues: [
          { title: `[Feature] ${params.title || 'New Feature'}`, type: 'Epic', children: [
            { title: `Design: ${params.title || 'New Feature'}`, priority: 'high', labels: ['design'] },
            { title: `Implement: ${params.title || 'New Feature'}`, priority: 'high', labels: ['development'] },
            { title: `Write tests: ${params.title || 'New Feature'}`, priority: 'medium', labels: ['testing'] },
            { title: `Documentation: ${params.title || 'New Feature'}`, priority: 'low', labels: ['docs'] },
            { title: `Code review: ${params.title || 'New Feature'}`, priority: 'medium', labels: ['review'] }
          ]}
        ]
      },
      'bug': {
        description: 'Bug investigation and fix workflow',
        issues: [
          { title: `[Bug] ${params.title || 'Bug Report'}`, type: 'Bug', children: [
            { title: `Reproduce: ${params.title || 'Bug'}`, priority: 'high' },
            { title: `Root cause analysis: ${params.title || 'Bug'}`, priority: 'high' },
            { title: `Fix: ${params.title || 'Bug'}`, priority: 'urgent' },
            { title: `Regression test: ${params.title || 'Bug'}`, priority: 'medium', labels: ['testing'] }
          ]}
        ]
      },
      'sprint': {
        description: 'Sprint planning template with ceremonies',
        issues: [
          { title: `Sprint Planning: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] },
          { title: `Daily Standup Notes: ${params.title || 'Sprint'}`, priority: 'medium', labels: ['ceremony'] },
          { title: `Sprint Review: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] },
          { title: `Sprint Retrospective: ${params.title || 'Sprint'}`, priority: 'high', labels: ['ceremony'] }
        ]
      },
      'release': {
        description: 'Release checklist',
        issues: [
          { title: `[Release] ${params.title || params.version || 'Release'}`, type: 'Epic', children: [
            { title: `Feature freeze: ${params.title || params.version || 'Release'}`, priority: 'urgent' },
            { title: `QA sign-off: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['testing'] },
            { title: `Update changelog: ${params.title || params.version || 'Release'}`, priority: 'high', labels: ['docs'] },
            { title: `Deploy to staging: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] },
            { title: `Production deploy: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] },
            { title: `Post-deploy verification: ${params.title || params.version || 'Release'}`, priority: 'urgent', labels: ['devops'] }
          ]}
        ]
      }
    };

    const template = templates[templateName.toLowerCase()];
    if (!template) {
      return {
        error: `Unknown template: "${templateName}"`,
        availableTemplates: Object.entries(templates).map(([name, t]) => ({
          name,
          description: t.description
        }))
      };
    }

    const allCreated = [];
    const errors = [];

    for (const item of template.issues) {
      // Create parent issue
      const parent = await this.createIssue(
        projectIdent, item.title, item.description || '',
        item.priority || 'medium', item.status || 'Todo',
        item.labels || [], item.type
      );
      allCreated.push(parent);

      // Create children and link to parent
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          const childIssue = await this.createIssue(
            projectIdent, child.title, child.description || '',
            child.priority || 'medium', child.status || 'Todo',
            child.labels || [], child.type
          );
          allCreated.push(childIssue);

          try {
            await this.setParent(childIssue.id, parent.id);
          } catch (e) {
            errors.push({ childId: childIssue.id, parentId: parent.id, error: e.message });
          }
        }
      }
    }

    return {
      template: templateName,
      description: template.description,
      created: allCreated,
      errors,
      total: allCreated.length
    };
  }

  // ── Project Management ──────────────────────────────────────

  async createProject(identifier, name, description, isPrivate = false, format, projectType) {
    const client = await this._getClient();

    identifier = identifier.toUpperCase();
    const existing = await client.findOne(tracker.class.Project, { identifier });
    if (existing) {
      throw new Error(`Project with identifier "${identifier}" already exists`);
    }

    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!statuses.length) throw new Error('No statuses found for project');
    const todoStatus = statuses.find(s => s.name === 'Todo');
    const defaultStatusId = todoStatus?._id || statuses[0]._id;

    // Resolve project type
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    if (!projectTypes.length) {
      throw new Error('No project types found in workspace. Configure project types in workspace settings first.');
    }
    let resolvedProjectType;
    if (projectType) {
      resolvedProjectType = projectTypes.find(pt =>
        (pt.name && pt.name.toLowerCase() === projectType.toLowerCase()) || pt._id === projectType
      );
      if (!resolvedProjectType) {
        const available = projectTypes.map(pt => pt.name || pt._id).join(', ');
        throw new Error(`Project type "${projectType}" not found. Available: ${available}`);
      }
    } else if (projectTypes.length === 1) {
      resolvedProjectType = projectTypes[0];
    } else {
      const available = projectTypes.map(pt => pt.name || pt._id).join(', ');
      throw new Error(`Multiple project types found: ${available}. Specify projectType explicitly.`);
    }

    const owners = this._accountUuid ? [this._accountUuid] : [];

    const projectId = generateId();
    await client.createDoc(tracker.class.Project, projectId, {
      identifier,
      name: name || identifier,
      description: toMarkup(description || '', format),
      private: isPrivate,
      members: [],
      owners,
      archived: false,
      autoJoin: !isPrivate,
      sequence: 0,
      defaultIssueStatus: defaultStatusId,
      defaultTimeReportDay: 0,
      issues: 0,
      type: resolvedProjectType._id
    }, projectId);

    return {
      id: projectId,
      identifier,
      name: name || identifier,
      description: description || '',
      private: isPrivate
    };
  }

  /**
   * Update a project's name, description, default assignee, or privacy.
   * @param {string} projectIdent - Project identifier
   * @param {Object} updates - Fields to update
   * @returns {Promise<Object>}
   */
  async updateProject(projectIdent, updates = {}) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const ops = {};
    if (updates.name !== undefined) ops.name = updates.name;
    if (updates.description !== undefined) ops.description = updates.description;
    if (updates.isPrivate !== undefined) ops.private = updates.isPrivate;
    if (updates.defaultAssignee !== undefined) {
      if (updates.defaultAssignee === '') {
        ops.defaultAssignee = null;
      } else {
        ops.defaultAssignee = await this._findEmployeeByName(client, updates.defaultAssignee);
      }
    }

    if (Object.keys(ops).length === 0) {
      return { message: 'No updates specified', identifier: project.identifier };
    }

    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, ops);

    return {
      message: `Project ${projectIdent} updated`,
      identifier: project.identifier,
      updated: Object.keys(ops)
    };
  }

  async archiveProject(projectIdent, archived = true) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      archived
    });

    return {
      message: archived ? `Project ${projectIdent} archived` : `Project ${projectIdent} unarchived`,
      identifier: project.identifier,
      archived
    };
  }

  async deleteProject(projectIdent) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    await client.removeDoc(tracker.class.Project, project.space || project._id, project._id);

    return {
      message: `Project ${projectIdent} permanently deleted`,
      identifier: project.identifier
    };
  }

  // ── Issue Delete ────────────────────────────────────────────

  async deleteIssue(issueId) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    await client.removeDoc(tracker.class.Issue, project._id, issue._id);

    return {
      message: `Issue ${issueId} permanently deleted`,
      issueId
    };
  }

  // ── Milestone Management ────────────────────────────────────

  async updateMilestone(projectIdent, name, updates = {}) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const milestone = milestones.find(m => nameMatch(m.label, name));
    if (!milestone) throw new Error(`Milestone not found: ${name}`);

    const docUpdates = {};
    const updatedFields = [];

    if (updates.name !== undefined) {
      docUpdates.label = updates.name;
      updatedFields.push('name');
    }
    if (updates.description !== undefined) {
      docUpdates.description = toMarkup(updates.description, updates.descriptionFormat);
      updatedFields.push('description');
    }
    if (updates.status !== undefined) {
      const statusValue = MILESTONE_STATUS_MAP[updates.status.toLowerCase()];
      if (statusValue !== undefined) {
        docUpdates.status = statusValue;
        updatedFields.push('status');
      }
    }
    if (updates.targetDate !== undefined) {
      const parsed = new Date(updates.targetDate);
      if (!isNaN(parsed.getTime())) {
        docUpdates.targetDate = parsed.getTime();
        updatedFields.push('targetDate');
      }
    }

    if (Object.keys(docUpdates).length > 0) {
      await client.updateDoc(tracker.class.Milestone, project._id, milestone._id, docUpdates);
    }

    return {
      id: milestone._id,
      name: docUpdates.label || milestone.label,
      updated: updatedFields
    };
  }

  async deleteMilestone(projectIdent, name) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const milestone = milestones.find(m => nameMatch(m.label, name));
    if (!milestone) throw new Error(`Milestone not found: ${name}`);

    await client.removeDoc(tracker.class.Milestone, project._id, milestone._id);

    return {
      message: `Milestone "${name}" deleted from ${projectIdent}`,
      id: milestone._id
    };
  }

  // ── Components ──────────────────────────────────────────────

  async listComponents(projectIdent) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const components = await client.findAll(tracker.class.Component, { space: project._id });

    return components.map(c => withExtra(c, {
      id: c._id,
      name: c.label,
      description: fromMarkup(c.description),
      lead: c.lead || null
    }));
  }

  async createComponent(projectIdent, name, description, lead, format) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const existing = await client.findOne(tracker.class.Component, {
      space: project._id,
      label: name
    });
    if (existing) {
      return { message: `Component "${name}" already exists`, id: existing._id };
    }

    // Resolve lead name to employee ID
    let leadId = null;
    if (lead) {
      leadId = await this._findEmployeeByName(client, lead);
    }

    const componentId = generateId();
    await client.createDoc(tracker.class.Component, project._id, {
      label: name,
      description: toMarkup(description || '', format),
      lead: leadId,
      attachments: 0,
      comments: 0
    }, componentId);

    return {
      message: `Component "${name}" created`,
      id: componentId,
      name,
      description: description || '',
      lead: leadId
    };
  }

  async updateComponent(projectIdent, name, updates = {}) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) throw new Error(`Component not found: ${name}`);

    const docUpdates = {};
    const updatedFields = [];

    if (updates.name !== undefined) {
      docUpdates.label = updates.name;
      updatedFields.push('name');
    }
    if (updates.description !== undefined) {
      docUpdates.description = toMarkup(updates.description, updates.descriptionFormat);
      updatedFields.push('description');
    }
    if (updates.lead !== undefined) {
      if (updates.lead) {
        docUpdates.lead = await this._findEmployeeByName(client, updates.lead);
      } else {
        docUpdates.lead = null;
      }
      updatedFields.push('lead');
    }

    if (Object.keys(docUpdates).length > 0) {
      await client.updateDoc(tracker.class.Component, project._id, component._id, docUpdates);
    }

    return {
      id: component._id,
      name: docUpdates.label || component.label,
      updated: updatedFields
    };
  }

  async deleteComponent(projectIdent, name) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) throw new Error(`Component not found: ${name}`);

    await client.removeDoc(tracker.class.Component, project._id, component._id);

    return {
      message: `Component "${name}" deleted from ${projectIdent}`,
      id: component._id
    };
  }

  // ── Time Reports ────────────────────────────────────────────

  async listTimeReports(issueId) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const reports = await client.findAll(tracker.class.TimeSpendReport, {
      attachedTo: issue._id
    }, { sort: { date: -1 } });

    return reports.map(r => withExtra(r, {
      id: r._id,
      hours: r.value,
      description: fromMarkup(r.description),
      date: r.date ? new Date(r.date).toISOString() : null
    }));
  }

  async deleteTimeReport(reportId) {
    const client = await this._getClient();

    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report) throw new Error(`Time report not found: ${reportId}`);

    // Update the issue's reportedTime
    if (report.attachedTo) {
      const issue = await client.findOne(tracker.class.Issue, { _id: report.attachedTo });
      if (issue) {
        const newReported = Math.max(0, (issue.reportedTime || 0) - (report.value || 0));
        await client.updateDoc(tracker.class.Issue, issue.space, issue._id, {
          reportedTime: newReported
        });
      }
    }

    await client.removeDoc(tracker.class.TimeSpendReport, report.space, report._id);

    return {
      message: `Time report deleted`,
      id: reportId,
      hours: report.value
    };
  }

  // ── Comment Management ──────────────────────────────────────

  async updateComment(issueId, commentId, text, format) {
    const client = await this._getClient();
    const { project } = await this._parseAndFindIssue(client, issueId);

    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);

    await client.updateDoc(chunter.class.ChatMessage, project._id, commentId, {
      message: toMarkup(text, format)
    });

    return {
      message: `Comment updated on ${issueId}`,
      id: commentId
    };
  }

  async deleteComment(issueId, commentId) {
    const client = await this._getClient();
    const { project } = await this._parseAndFindIssue(client, issueId);

    const comment = await client.findOne(chunter.class.ChatMessage, { _id: commentId });
    if (!comment) throw new Error(`Comment not found: ${commentId}`);

    await client.removeDoc(chunter.class.ChatMessage, project._id, commentId);

    return {
      message: `Comment deleted from ${issueId}`,
      id: commentId
    };
  }
}
