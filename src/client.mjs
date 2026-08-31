/**
 * HulyClient - All business logic for interacting with Huly issue tracking.
 *
 * Helpers, constants, and markup utilities are in helpers.mjs.
 * JSDOM polyfills are initialized there before any SDK imports.
 */
import {
  PRIORITY_MAP, PRIORITY_NAMES,
  MILESTONE_STATUS_MAP, MILESTONE_STATUS_NAMES,
  resolveColor,
  DONE_CATEGORY, LOST_CATEGORY, STATUS_CATEGORY_NAMES,
  DEFAULT_LABEL_CATEGORY, DEFAULT_LABEL_COLOR,
  PAGE_SIZE, MAX_BATCH_SIZE, AUTH_CACHE_TTL_MS, DEFAULT_MILESTONE_DAYS,
  DEFAULT_PAGE_SIZE, DEFAULT_DETAIL_PAGE_SIZE,
  MAX_PAGE_SIZE, MAX_DETAIL_PAGE_SIZE,
  FILTER_ID_BATCH_SIZE, FILTER_QUERY_CONCURRENCY, MAX_LABEL_FILTER_ISSUES,
  LOOKUP_CACHE_TTL_MS,
  encodeCursor, decodeCursor, cursorTuple, compareCursorTuple,
  isTupleAfter, normalizePageLimit, listEnvelope, normalizeReportDate, toIsoDate,
  normalizeDueDate, resolvePriority,
  nameMatch, strictGet, toHours, issueTimeFields, withExtra,
  toCollaboratorMarkup, fromCollaboratorMarkup,
  toMarkup, fromMarkup
} from './helpers.mjs';
import {
  boundedCollection,
  markdownPreview,
  normalizeIssueReadOptions,
  projectIssueFields
} from './projection.mjs';

export { PRIORITY_MAP, PRIORITY_NAMES, MILESTONE_STATUS_MAP, MILESTONE_STATUS_NAMES };

import { createRequire } from 'module';
import {
  createOutboundSocketFactory,
  ensureOutboundHeaders,
  registerOriginsFromServerConfig,
  registerOutboundOrigin
} from './outboundHeaders.mjs';
const require = createRequire(import.meta.url);

// Direct file requires to bypass package.json exports restrictions
const { getWorkspaceToken } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/utils.js'));
const { createRestTxOperations } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/rest/tx.js'));
const { connect: connectWs } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/client.js'));
const { getClient: getAccountClient } = require('@hcengineering/account-client');
const { loadServerConfig: loadConfig } = require(require.resolve('@hcengineering/api-client').replace(/lib[/\\]index\.js$/, 'lib/config.js'));
const coreSdk = require('@hcengineering/core');
const { generateId } = coreSdk;
const core = coreSdk.default;
const { makeRank } = require('@hcengineering/rank');
const { getClient: getCollaboratorClient } = require('@hcengineering/collaborator-client');

const tracker = require('@hcengineering/tracker').default;
const tags = require('@hcengineering/tags').default;
const contactPlugin = require('@hcengineering/contact').default;
const chunter = require('@hcengineering/chunter').default;
const task = require('@hcengineering/task').default;

function normalizeIncludeSet(value, allowed, name = 'include') {
  if (value === undefined) return new Set();
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      throw new Error(`Unsupported ${name} value: ${String(item)}`);
    }
    result.add(item);
  }
  return result;
}

const PROJECT_INCLUDE_FIELDS = Object.freeze(['milestones', 'components', 'labels', 'members']);
const MILESTONE_INCLUDE_FIELDS = Object.freeze(['issues']);

/**
 * HulyClient encapsulates all business logic for a single workspace connection.
 */
export class HulyClient {
  _issueTimeFields(issue) {
    return issueTimeFields(issue);
  }

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

    HulyClient._authCache = {
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
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.updateWorkspaceName(newName);
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
  static async changeUsername(url, creds, firstName, lastName) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    await authClient.changeUsername(firstName, lastName || '');
    return { message: `Username changed to "${firstName}${lastName ? ' ' + lastName : ''}"` };
  }

  // ── Invites ─────────────────────────────────────────────

  /**
   * Send an invite to join a workspace.
   */
  static async sendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.sendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite sent to ${inviteEmail} for workspace ${workspaceSlug}` };
  }

  /**
   * Resend a pending invite.
   */
  static async resendInvite(url, creds, workspaceSlug, inviteEmail, role) {
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
    await wsClient.resendInvite(inviteEmail, role || 'MEMBER');
    return { message: `Invite resent to ${inviteEmail}` };
  }

  /**
   * Create an invite link for a workspace.
   */
  static async createInviteLink(url, creds, workspaceSlug, email, role, firstName, lastName, expireHours) {
    const { wsClient } = await HulyClient._getWorkspaceAuthClient(url, creds, workspaceSlug);
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

  // ── Integrations ────────────────────────────────────────

  /**
   * List all integrations.
   */
  static async listIntegrations(url, creds, filter) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const integrations = await authClient.listIntegrations(filter || {});
    return integrations;
  }

  /**
   * Get a specific integration by key (socialId + kind + workspaceUuid).
   */
  static async getIntegration(url, creds, integrationKey) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const integration = await authClient.getIntegration(integrationKey);
    return integration;
  }

  /**
   * Create a new integration.
   * @param {object} integration - { socialId, kind, workspaceUuid, data?, disabled? }
   */
  static async createIntegration(url, creds, integration) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.createIntegration(integration);
    return result;
  }

  /**
   * Update an existing integration.
   * @param {object} integration - Full Integration object { socialId, kind, workspaceUuid, data?, disabled? }
   */
  static async updateIntegration(url, creds, integration) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.updateIntegration(integration);
    return result;
  }

  /**
   * Delete an integration by key.
   * @param {object} integrationKey - { socialId, kind, workspaceUuid }
   */
  static async deleteIntegration(url, creds, integrationKey) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    await authClient.deleteIntegration(integrationKey);
    return { message: 'Integration deleted' };
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
  static async createMailbox(url, creds, name, domain) {
    const { authClient } = await HulyClient._getAuthClient(url, creds);
    const result = await authClient.createMailbox(name, domain);
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
    this._platformClient = null;
    this._connectionPromise = null;
    this._collabClient = null;
    this._workspaceId = null;
    this._serverConfig = null;
    this._labelLookupCache = new Map();
  }

  /**
   * Establish a client connection to Huly.
   * Transport is chosen via HULY_TRANSPORT env var: 'ws' (default) or 'rest'.
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

      const transport = (process.env.HULY_TRANSPORT || 'ws').toLowerCase();
      const authOpts = this.token
        ? { token: this.token, workspace: this.workspace }
        : { email: this.email, password: this.password, workspace: this.workspace };

      ensureOutboundHeaders(this.url);
      this._serverConfig = await loadConfig(this.url);
      registerOriginsFromServerConfig(this._serverConfig, this.url);

      if (transport === 'ws') {
        // Resolve and register the transactor endpoint before connectWs opens
        // the socket; the SDK resolves it internally too, but too late for us
        // to update the outbound header allowlist.
        const { workspaceId, token, endpoint } = await getWorkspaceToken(this.url, authOpts, this._serverConfig);
        registerOutboundOrigin(endpoint, this.url);

        // WebSocket transport — full SDK support including Space creation
        const socketFactory = createOutboundSocketFactory();
        const wsOpts = socketFactory ? { ...authOpts, socketFactory } : authOpts;
        const platformClient = await connectWs(this.url, wsOpts);
        this._client = platformClient.client;
        this._platformClient = platformClient;

        // Extract account UUID from the platform client
        const account = await platformClient.getAccount();
        this._accountUuid = account.uuid;

        this._workspaceId = workspaceId;
        this._wsToken = token;
      } else {
        // REST transport — lightweight, no WebSocket dependency
        const { endpoint, token, workspaceId } = await getWorkspaceToken(this.url, authOpts, this._serverConfig);
        registerOutboundOrigin(endpoint, this.url);
        this._workspaceId = workspaceId;
        this._wsToken = token;

        // Extract authenticated account UUID from JWT for ownership
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        this._accountUuid = payload.account;
        if (!this._accountUuid) {
          throw new Error('Workspace token missing account field');
        }

        this._client = await createRestTxOperations(endpoint, workspaceId, token);
      }

      // Initialize collaborator client for rich text (issue descriptions)
      const collabUrl = (this._serverConfig.COLLABORATOR_URL || '')
        .replace('wss://', 'https://').replace('ws://', 'http://');
      if (collabUrl) {
        this._collabClient = getCollaboratorClient(this._workspaceId, this._wsToken, collabUrl);
      }
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
    if (this._platformClient) {
      this._platformClient.close().catch(() => {});
      this._platformClient = null;
    }
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
    if (typeof issueId !== 'string' || issueId.trim() === '') {
      throw new Error('Issue ID is required (expected format: PROJECT-NUMBER)');
    }

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
        color: DEFAULT_LABEL_COLOR,
        category: DEFAULT_LABEL_CATEGORY
      }, tagId);
      tagElement = { _id: tagId, title: labelName, color: DEFAULT_LABEL_COLOR };
      this._labelLookupCache.clear();
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
      if (scoped.length) {
        // Prefer the type named "Task" (the common default), not the first in list (often Epic)
        const taskType = scoped.find(tt => nameMatch(tt.name || tt._id.split(':').pop(), 'Task'));
        return (taskType || scoped[0])._id;
      }
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
  async _getScopedStatuses(client, _project, taskTypeId) {
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found in workspace');

    // Find the task type to get its scoped status list
    const taskTypes = await client.findAll(task.class.TaskType, {});
    const taskType = taskTypes.find(tt => tt._id === taskTypeId);

    if (taskType?.statuses?.length) {
      // Preserve workflow order from TaskType.statuses array
      const statusById = new Map(allStatuses.map(s => [s._id, s]));
      const scoped = taskType.statuses.map(id => statusById.get(id)).filter(Boolean);
      if (scoped.length) return scoped;
    }

    return allStatuses;
  }

  /**
   * Paginated findAll — fetches results in batches to avoid data loss.
   * The SDK's findAll has a server-side page limit. If limit exceeds
   * the page size, this fetches multiple pages using createdOn cursor.
   */
  /**
   * Paginated findAll with cursor support.
   * Fetches from the SDK in PAGE_SIZE batches, returns { items, nextCursor? }.
   * @param {Object} client - SDK client
   * @param {string} _class - Document class
   * @param {Object} query - Query filter
   * @param {Object} options - { limit, cursor, ...findAllOptions }
   * @returns {{ items: Object[], nextCursor?: string }}
   */
  async _paginatedFindAll(client, _class, query, options = {}) {
    const {
      cursor,
      cursorScope = { workspace: this.workspace, class: _class, query },
      maxLimit = MAX_PAGE_SIZE,
      after: internalAfter,
      watermark: internalWatermark,
      limit: requestedLimit,
      ...findAllOptions
    } = options;
    const limit = normalizePageLimit(requestedLimit, DEFAULT_PAGE_SIZE, maxLimit);
    const decoded = cursor ? decodeCursor(cursor, { scope: cursorScope }) : null;
    let after = decoded?.after ?? internalAfter;
    let watermark = decoded?.watermark ?? internalWatermark;

    const allResults = [];
    let remaining = limit + 1; // fetch one extra to detect next page

    while (remaining > 0) {
      const pageLimit = Math.min(remaining, PAGE_SIZE);
      let page;
      if (!after) {
        page = await client.findAll(_class, query, {
          ...findAllOptions,
          // Fetch a full SDK page so a timestamp tie at the caller's smaller
          // page boundary can be ordered deterministically in memory.
          limit: PAGE_SIZE,
          sort: { createdOn: -1 }
        });
      } else {
        const sameTimestamp = await client.findAll(_class, {
          ...query,
          createdOn: after.createdOn
        }, { ...findAllOptions, limit: PAGE_SIZE });
        const sameEligible = sameTimestamp
          .filter(item => isTupleAfter(item, after))
          .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));

        if (sameTimestamp.length === PAGE_SIZE && sameEligible.length < pageLimit) {
          throw new Error(
            `Pagination timestamp contains more than ${PAGE_SIZE} records; refine the query`
          );
        }

        const older = sameEligible.length >= pageLimit
          ? []
          : await client.findAll(_class, {
            ...query,
            createdOn: { $lt: after.createdOn }
          }, {
            ...findAllOptions,
            limit: PAGE_SIZE,
            sort: { createdOn: -1 }
          });
        page = [...sameEligible, ...older]
          .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));
      }

      page = page
        .sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)))
        .slice(0, pageLimit);

      if (page.length === 0) break;

      allResults.push(...page);
      remaining -= page.length;
      after = cursorTuple(page[page.length - 1]);
      watermark ??= cursorTuple(page[0]);

      if (page.length < pageLimit) break;
    }

    // If we got more than limit, there are more results
    if (allResults.length > limit) {
      const items = allResults.slice(0, limit);
      return listEnvelope(items, encodeCursor(items[items.length - 1], {
        scope: cursorScope,
        watermark
      }));
    }

    return listEnvelope(allResults);
  }

  /**
   * In-memory cursor pagination for small collections fetched via findAll.
   * Filters by cursor, sorts by createdOn desc, slices to limit.
   * @param {Object[]} allResults - Full result set from findAll
   * @param {Object} options - { cursor?, limit? }
   * @returns {{ items: Object[], nextCursor?: string }}
   */
  _cursoredFindAll(allResults, options = {}) {
    const {
      cursor,
      cursorScope = { workspace: this.workspace, collection: 'generic' },
      maxLimit = MAX_PAGE_SIZE
    } = options;
    const limit = normalizePageLimit(options.limit, DEFAULT_PAGE_SIZE, maxLimit);
    let items = [...allResults];

    if (cursor) {
      const decoded = decodeCursor(cursor, { scope: cursorScope });
      items = items.filter(item => isTupleAfter(item, decoded.after));
    }

    items.sort((a, b) => compareCursorTuple(cursorTuple(a), cursorTuple(b)));

    if (items.length > limit) {
      const page = items.slice(0, limit);
      const decoded = cursor ? decodeCursor(cursor, { scope: cursorScope }) : null;
      return listEnvelope(page, encodeCursor(page[page.length - 1], {
        scope: cursorScope,
        watermark: decoded?.watermark ?? page[0]
      }));
    }

    return listEnvelope(items);
  }

  async _findEmployeeByName(client, name) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const found = employees.find(e => nameMatch(e.name, name));
    if (!found) {
      throw new Error(`Employee not found: ${name}`);
    }
    return found._id;
  }

  async _findMilestoneByName(client, projectId, name) {
    const ms = await client.findOne(tracker.class.Milestone, {
      space: projectId,
      label: name
    });
    if (!ms) {
      throw new Error(`Milestone not found: ${name}`);
    }
    return ms._id;
  }

  async _findComponentByName(client, projectId, name) {
    const comp = await client.findOne(tracker.class.Component, {
      space: projectId,
      label: name
    });
    if (!comp) {
      throw new Error(`Component not found: ${name}`);
    }
    return comp._id;
  }

  // ── Shared map builders (DRY) ─────────────────────────────

  async _buildStatusMaps(client) {
    const statuses = await client.findAll(tracker.class.IssueStatus, {});
    const statusMap = new Map(statuses.map(s => [s._id, s.name]));
    const doneStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY)
      .map(s => s._id));
    return { statuses, statusMap, doneStatuses };
  }

  async _buildTaskTypeMap(client) {
    const taskTypes = await client.findAll(task.class.TaskType, {});
    return new Map(taskTypes.map(t => [t._id, t.name]));
  }

  async _buildEmployeeMap(client) {
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(e => [e._id, e.name]));
    return { employees, employeeMap };
  }

  _groupLabelsByIssue(allLabels) {
    const labelsByIssue = new Map();
    for (const label of allLabels) {
      if (!labelsByIssue.has(label.attachedTo)) {
        labelsByIssue.set(label.attachedTo, []);
      }
      labelsByIssue.get(label.attachedTo).push(label);
    }
    return labelsByIssue;
  }

  async _mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from(
      { length: Math.min(concurrency, items.length) },
      async () => {
        while (nextIndex < items.length) {
          const index = nextIndex;
          nextIndex += 1;
          results[index] = await mapper(items[index], index);
        }
      }
    );
    await Promise.all(workers);
    return results;
  }

  async _findLabelByName(client, labelName) {
    const key = labelName.toLowerCase();
    const cached = this._labelLookupCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });
    const expiresAt = Date.now() + LOOKUP_CACHE_TTL_MS;
    for (const tagElement of tagElements) {
      this._labelLookupCache.set(tagElement.title.toLowerCase(), {
        value: tagElement,
        expiresAt
      });
    }
    const matched = tagElements.find(tagElement => nameMatch(tagElement.title, labelName)) ?? null;
    if (matched) this._labelLookupCache.set(key, { value: matched, expiresAt });
    return matched;
  }

  async _findIssueIdsForLabel(client, tagId) {
    const references = await this._paginatedFindAll(
      client,
      tags.class.TagReference,
      { tag: tagId },
      {
        limit: MAX_LABEL_FILTER_ISSUES + 1,
        maxLimit: MAX_LABEL_FILTER_ISSUES + 1,
        cursorScope: { workspace: this.workspace, internal: 'label_references', tagId }
      }
    );
    if (references.nextCursor || references.items.length > MAX_LABEL_FILTER_ISSUES) {
      throw new Error(
        `Label matches more than ${MAX_LABEL_FILTER_ISSUES} issues; add another filter or use search`
      );
    }
    return [...new Set(references.items
      .map(reference => reference.attachedTo)
      .filter(Boolean))];
  }

  async _paginatedIssuesByIds(client, query, issueIds, options) {
    const cursorScope = options.cursorScope ?? {
      workspace: this.workspace,
      class: tracker.class.Issue,
      query,
      issueIds: [...issueIds].sort()
    };
    const decoded = options.cursor
      ? decodeCursor(options.cursor, { scope: cursorScope })
      : null;
    const batches = [];
    for (let offset = 0; offset < issueIds.length; offset += FILTER_ID_BATCH_SIZE) {
      batches.push(issueIds.slice(offset, offset + FILTER_ID_BATCH_SIZE));
    }
    const perBatch = await this._mapWithConcurrency(
      batches,
      FILTER_QUERY_CONCURRENCY,
      batch => this._paginatedFindAll(client, tracker.class.Issue, {
        ...query,
        _id: { $in: batch }
      }, {
        limit: options.limit + 1,
        maxLimit: MAX_PAGE_SIZE + 1,
        after: decoded?.after,
        watermark: decoded?.watermark,
        cursorScope: { ...cursorScope, batch }
      })
    );
    const merged = perBatch
      .flatMap(page => page.items)
      .sort((a, b) => (b.createdOn - a.createdOn) || compareCursorTuple(
        { createdOn: a.createdOn, id: String(a._id) },
        { createdOn: b.createdOn, id: String(b._id) }
      ));
    if (merged.length > options.limit) {
      const items = merged.slice(0, options.limit);
      return listEnvelope(items, encodeCursor(items[items.length - 1], {
        scope: cursorScope,
        watermark: decoded?.watermark ?? items[0]
      }));
    }
    return listEnvelope(merged);
  }

  async _buildRelatedIssueMap(client, issues) {
    const allRelIds = [...new Set(issues.flatMap(issue => [
      ...(issue.relations || []).map(r => r._id),
      ...(issue.blockedBy || []).map(r => r._id)
    ]))];
    if (allRelIds.length === 0) return new Map();
    const relIssues = await client.findAll(tracker.class.Issue, { _id: { $in: allRelIds } });
    const relSpaceIds = [...new Set(relIssues.map(i => i.space))];
    const relProjects = await client.findAll(tracker.class.Project, { _id: { $in: relSpaceIds } });
    const relProjectMap = new Map(relProjects.map(p => [p._id, p.identifier]));
    return new Map(relIssues.map(i => [i._id, {
      id: `${relProjectMap.get(i.space) ?? '?'}-${i.number}`,
      title: i.title
    }]));
  }

  _projectRelations(issue, relIssueMap, limit) {
    const relationRefs = issue.relations || [];
    const blockedByRefs = issue.blockedBy || [];
    const relationValues = relationRefs.map(r => relIssueMap.get(r._id)).filter(Boolean);
    const blockedByValues = blockedByRefs.map(r => relIssueMap.get(r._id)).filter(Boolean);
    const relations = boundedCollection(relationValues, limit);
    const blockedBy = boundedCollection(blockedByValues, limit);
    return {
      relations: relations.items,
      relationsCount: relations.count,
      relationsTruncated: relations.truncated,
      blockedBy: blockedBy.items,
      blockedByCount: blockedBy.count,
      blockedByTruncated: blockedBy.truncated
    };
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * List all projects with issue counts.
   * @returns {Promise<Object[]>}
   */
  async listProjects(options = {}) {
    const client = await this._getClient();
    const projects = await client.findAll(tracker.class.Project, {});

    const include = normalizeIncludeSet(options.include, PROJECT_INCLUDE_FIELDS);
    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_projects',
      include: [...include].sort()
    };
    const page = this._cursoredFindAll(projects, { ...options, cursorScope });
    const selectedProjects = page.items;
    const projectIds = selectedProjects.map(project => project._id);
    const needsEmployees = include.has('members') || include.has('components');
    const [allMilestones, allComponents, allLabels, employees] = await Promise.all([
      include.has('milestones') && projectIds.length > 0
        ? client.findAll(tracker.class.Milestone, { space: { $in: projectIds } })
        : [],
      include.has('components') && projectIds.length > 0
        ? client.findAll(tracker.class.Component, { space: { $in: projectIds } })
        : [],
      include.has('labels')
        ? client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue })
        : [],
      needsEmployees
        ? client.findAll(contactPlugin.mixin.Employee, { active: true })
        : []
    ]);
    const employeeMap = new Map(employees.map(employee => [employee._id, employee.name]));
    const milestonesByProject = new Map();
    for (const milestone of allMilestones) {
      if (!milestonesByProject.has(milestone.space)) milestonesByProject.set(milestone.space, []);
      milestonesByProject.get(milestone.space).push(milestone);
    }
    const componentsByProject = new Map();
    for (const component of allComponents) {
      if (!componentsByProject.has(component.space)) componentsByProject.set(component.space, []);
      componentsByProject.get(component.space).push(component);
    }

    const items = selectedProjects.map(project => {
      const base = {
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
      };
      if (include.has('milestones')) {
        base.milestones = (milestonesByProject.get(project._id) || []).map(milestone => ({
          name: milestone.label,
          status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status'),
          targetDate: milestone.targetDate
            ? new Date(milestone.targetDate).toISOString().split('T')[0]
            : null
        }));
      }
      if (include.has('components')) {
        base.components = (componentsByProject.get(project._id) || []).map(component => ({
          name: component.label,
          description: fromMarkup(component.description),
          lead: component.lead ? employeeMap.get(component.lead) ?? null : null
        }));
      }
      if (include.has('labels')) {
        base.labels = allLabels.map(label => ({
          name: label.title,
          color: label.color ?? null
        }));
      }
      if (include.has('members')) {
        base.members = (project.members || [])
          .map(memberId => employeeMap.get(memberId))
          .filter(Boolean);
      }
      return withExtra(project, base);
    });
    return listEnvelope(items, page.nextCursor);
  }

  /**
   * Get a project by its identifier.
   * @param {string} identifier - Project identifier (e.g., "PROJ")
   * @returns {Promise<Object>}
   */
  async getProject(identifier, options = {}) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: identifier.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${identifier}`);
    }

    const base = {
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
    };

    const include = normalizeIncludeSet(options.include, PROJECT_INCLUDE_FIELDS);
    if (include.size === 0) {
      return withExtra(project, base);
    }

    const needsEmployees = include.has('members') || include.has('components');
    const [milestones, components, allLabels, employees] = await Promise.all([
      include.has('milestones') ? client.findAll(tracker.class.Milestone, { space: project._id }) : [],
      include.has('components') ? client.findAll(tracker.class.Component, { space: project._id }) : [],
      include.has('labels')
        ? client.findAll(tags.class.TagElement, { targetClass: tracker.class.Issue })
        : [],
      needsEmployees ? client.findAll(contactPlugin.mixin.Employee, { active: true }) : []
    ]);

    const employeeMap = new Map(employees.map(e => [e._id, e.name]));

    if (include.has('milestones')) base.milestones = milestones.map(m => ({
      name: m.label,
      status: strictGet(MILESTONE_STATUS_NAMES, m.status, 'Milestone status'),
      targetDate: m.targetDate ? new Date(m.targetDate).toISOString().split('T')[0] : null
    }));
    if (include.has('components')) base.components = components.map(c => ({
      name: c.label,
      description: fromMarkup(c.description),
      lead: c.lead ? employeeMap.get(c.lead) ?? null : null
    }));
    if (include.has('labels')) base.labels = allLabels.map(t => ({
      name: t.title,
      color: t.color ?? null
    }));
    if (include.has('members')) {
      base.members = (project.members || []).map(mId => employeeMap.get(mId)).filter(Boolean);
    }

    return withExtra(project, base);
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
  async listIssues(project, status, priority, label, milestone, limit, cursor, readOptions = {}) {
    const projection = normalizeIssueReadOptions(readOptions, 'list');
    const detailedRead = projection.include.size > 0;
    limit = normalizePageLimit(
      limit,
      detailedRead ? DEFAULT_DETAIL_PAGE_SIZE : DEFAULT_PAGE_SIZE,
      detailedRead ? MAX_DETAIL_PAGE_SIZE : MAX_PAGE_SIZE
    );
    const client = await this._getClient();

    const proj = await client.findOne(tracker.class.Project, {
      identifier: project.toUpperCase()
    });

    if (!proj) {
      throw new Error(`Project not found: ${project}`);
    }

    const query = { space: proj._id };

    if (priority) {
      const priorityKey = priority.toLowerCase();
      if (!Object.hasOwn(PRIORITY_MAP, priorityKey)) {
        throw new Error(`Priority not found: ${priority}`);
      }
      query.priority = PRIORITY_MAP[priorityKey];
    }

    const needsStatus = Boolean(status) || projection.fields.has('status') ||
      projection.fields.has('completedAt') || projection.include.has('children');
    const needsMilestone = Boolean(milestone) || projection.fields.has('milestone');
    const [statusData, milestones] = await Promise.all([
      needsStatus
        ? this._buildStatusMaps(client)
        : Promise.resolve({ statuses: [], statusMap: new Map(), doneStatuses: new Set() }),
      needsMilestone
        ? client.findAll(tracker.class.Milestone, { space: proj._id })
        : Promise.resolve([])
    ]);
    const { statuses, statusMap, doneStatuses } = statusData;

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        throw new Error(`Status not found: ${status}`);
      }
    }

    const milestoneMap = new Map(milestones.map(m => [m._id, m.label]));

    if (milestone) {
      const found = milestones.find(m => nameMatch(m.label, milestone));
      if (!found) {
        throw new Error(`Milestone not found: ${milestone}`);
      }
      query.milestone = found._id;
    }

    // Resolve labels to issue IDs before pagination. Filtering after pagination
    // can return short/empty pages even when later matching issues exist.
    let labelIssueIds = null;
    if (label) {
      const tagElement = await this._findLabelByName(client, label);
      if (!tagElement) {
        throw new Error(`Label not found: ${label}`);
      }
      labelIssueIds = await this._findIssueIdsForLabel(client, tagElement._id);
      if (labelIssueIds.length === 0) {
        return listEnvelope([]);
      }
    }

    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_issues',
      project: project.toUpperCase(),
      status: status?.toLowerCase() ?? null,
      priority: priority?.toLowerCase() ?? null,
      label: label?.toLowerCase() ?? null,
      milestone: milestone?.toLowerCase() ?? null,
      fields: [...projection.fields].sort(),
      include: [...projection.include].sort(),
      limits: projection.limits,
      descriptionPreviewChars: projection.descriptionPreviewChars
    };
    const fetchResult = labelIssueIds
      ? await this._paginatedIssuesByIds(client, query, labelIssueIds, { limit, cursor, cursorScope })
      : await this._paginatedFindAll(client, tracker.class.Issue, query, { limit, cursor, cursorScope });
    const issues = fetchResult.items;
    const nextCursor = fetchResult.nextCursor;

    if (issues.length === 0) {
      return listEnvelope([]);
    }

    // Fetch only lookup tables required by the requested projection.
    const issueIds = issues.map(i => i._id);
    const needsType = projection.fields.has('type') || projection.include.has('children');
    const [allLabels, taskTypeMap, components, employeeData] = await Promise.all([
      projection.fields.has('labels')
        ? client.findAll(tags.class.TagReference, { attachedTo: { $in: issueIds } })
        : Promise.resolve([]),
      needsType ? this._buildTaskTypeMap(client) : Promise.resolve(new Map()),
      projection.fields.has('component')
        ? client.findAll(tracker.class.Component, { space: proj._id })
        : Promise.resolve([]),
      projection.fields.has('assignee')
        ? this._buildEmployeeMap(client)
        : Promise.resolve({ employeeMap: new Map() })
    ]);
    const labelsByIssue = this._groupLabelsByIssue(allLabels);
    const componentMap = new Map(components.map(c => [c._id, c.label]));
    const { employeeMap } = employeeData;

    // Parent issue map for hierarchy (batch lookup)
    const parentIds = projection.fields.has('parent')
      ? [...new Set(issues
        .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
        .map(i => i.attachedTo))]
      : [];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentSpaceIds = [...new Set(parentIssues.map(p => p.space))];
    const parentProjects = parentSpaceIds.length > 0
      ? await client.findAll(tracker.class.Project, { _id: { $in: parentSpaceIds } })
      : [];
    const parentProjMap = new Map(parentProjects.map(p => [p._id, p.identifier]));
    const parentMap = new Map(parentIssues.map(p => [
      p._id,
      `${parentProjMap.get(p.space) ?? '?'}-${p.number}`
    ]));

    const groupByAttachedTo = values => {
      const grouped = new Map();
      for (const value of values) {
        if (!grouped.has(value.attachedTo)) grouped.set(value.attachedTo, []);
        grouped.get(value.attachedTo).push(value);
      }
      return grouped;
    };
    const [allComments, allTimeReports, allChildren, relatedIssueMap, descriptions] = await Promise.all([
      projection.include.has('comments') || projection.include.has('activity')
        ? client.findAll(chunter.class.ChatMessage, { attachedTo: { $in: issueIds } }, { sort: { createdOn: 1 } })
        : Promise.resolve([]),
      projection.include.has('timeReports') || projection.include.has('activity')
        ? client.findAll(tracker.class.TimeSpendReport, { attachedTo: { $in: issueIds } }, { sort: { date: -1 } })
        : Promise.resolve([]),
      projection.include.has('children')
        ? client.findAll(tracker.class.Issue, {
          attachedTo: { $in: issueIds },
          attachedToClass: tracker.class.Issue,
          space: proj._id
        })
        : Promise.resolve([]),
      projection.include.has('relations') || projection.include.has('blockedBy')
        ? this._buildRelatedIssueMap(client, issues)
        : Promise.resolve(new Map()),
      projection.include.has('description')
        ? Promise.all(issues.map(async issue => {
          const rawDesc = issue.description;
          const text = typeof rawDesc === 'string' && /^[a-f0-9]+-\w+-\d+$/.test(rawDesc)
            ? await this._readCollaboratorField(issue._id, issue._class, 'description', rawDesc)
            : fromMarkup(rawDesc);
          return [issue._id, text];
        }))
        : Promise.resolve([])
    ]);
    const commentsByIssue = groupByAttachedTo(allComments);
    const timeReportsByIssue = groupByAttachedTo(allTimeReports);
    const childrenByIssue = groupByAttachedTo(allChildren);
    const descriptionByIssue = new Map(descriptions);

    const assignBounded = (entry, key, values, maximum) => {
      const bounded = boundedCollection(values, maximum);
      entry[key] = bounded.items;
      if (projection.emitExpansionMetadata || bounded.truncated) {
        entry[`${key}Count`] = bounded.count;
        entry[`${key}Truncated`] = bounded.truncated;
      }
    };

    const field = name => projection.fields.has(name);
    const included = name => projection.include.has(name);

    const result = issues.map(issue => {
      const entry = { id: `${proj.identifier}-${issue.number}` };
      if (field('title')) entry.title = issue.title;
      if (field('status')) entry.status = strictGet(statusMap, issue.status, 'Status');
      if (field('priority')) entry.priority = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
      if (field('type')) entry.type = strictGet(taskTypeMap, issue.kind, 'Task type');
      if (field('assignee')) entry.assignee = issue.assignee ? employeeMap.get(issue.assignee) ?? null : null;
      if (field('component')) entry.component = issue.component ? componentMap.get(issue.component) ?? null : null;
      if (field('labels')) entry.labels = (labelsByIssue.get(issue._id) || []).map(item => item.title);
      if (field('parent')) {
        entry.parent = issue.attachedTo && issue.attachedToClass === tracker.class.Issue
          ? parentMap.get(issue.attachedTo) ?? null
          : null;
      }
      if (field('childCount')) entry.childCount = issue.subIssues || 0;
      if (field('milestone')) entry.milestone = issue.milestone ? milestoneMap.get(issue.milestone) ?? null : null;
      if (field('dueDate')) entry.dueDate = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
      const timeFields = this._issueTimeFields(issue);
      if (field('estimation')) entry.estimation = timeFields.estimation;
      if (field('reportedTime')) entry.reportedTime = timeFields.reportedTime;
      if (field('createdOn')) entry.createdOn = issue.createdOn;
      if (field('modifiedOn')) entry.modifiedOn = issue.modifiedOn;
      if (field('completedAt')) entry.completedAt = doneStatuses.has(issue.status) ? issue.modifiedOn : null;

      if (included('description')) {
        const preview = markdownPreview(descriptionByIssue.get(issue._id) ?? '', projection.descriptionPreviewChars);
        entry.description = preview.text;
        if (projection.emitExpansionMetadata || preview.truncated) {
          entry.descriptionTruncated = preview.truncated;
        }
      }
      if (included('comments')) {
        const comments = (commentsByIssue.get(issue._id) || []).map(comment => ({
          id: comment._id,
          text: fromMarkup(comment.message),
          createdBy: comment.createdBy || null,
          createdOn: comment.createdOn,
          modifiedOn: comment.modifiedOn
        }));
        assignBounded(entry, 'comments', comments, projection.limits.comments);
      }
      if (included('activity')) {
        const activity = [
          ...(commentsByIssue.get(issue._id) || []).map(comment => ({
            type: 'comment',
            text: fromMarkup(comment.message),
            date: comment.createdOn,
            dateFormatted: comment.createdOn ? new Date(comment.createdOn).toISOString() : null
          })),
          ...(timeReportsByIssue.get(issue._id) || []).map(report => ({
            type: 'time_logged',
            hours: report.value,
            description: fromMarkup(report.description),
            date: report.date,
            dateFormatted: toIsoDate(report.date)
          }))
        ].sort((a, b) => (a.date || 0) - (b.date || 0));
        assignBounded(entry, 'activity', activity, projection.limits.activity);
      }
      if (included('timeReports')) {
        const reports = (timeReportsByIssue.get(issue._id) || []).map(report => ({
          id: report._id,
          hours: report.value,
          description: fromMarkup(report.description),
          date: toIsoDate(report.date)
        }));
        assignBounded(entry, 'timeReports', reports, projection.limits.timeReports);
      }
      if (included('relations') || included('blockedBy')) {
        const relationData = this._projectRelations(issue, relatedIssueMap, projection.limits.relations);
        for (const key of ['relations', 'blockedBy']) {
          if (!included(key)) continue;
          entry[key] = relationData[key];
          if (projection.emitExpansionMetadata || relationData[`${key}Truncated`]) {
            entry[`${key}Count`] = relationData[`${key}Count`];
            entry[`${key}Truncated`] = relationData[`${key}Truncated`];
          }
        }
      }
      if (included('children')) {
        const children = (childrenByIssue.get(issue._id) || []).map(child => ({
          id: `${proj.identifier}-${child.number}`,
          title: child.title,
          status: strictGet(statusMap, child.status, 'Status'),
          type: strictGet(taskTypeMap, child.kind, 'Task type')
        }));
        assignBounded(entry, 'children', children, projection.limits.children);
      }

      return projectIssueFields(withExtra(issue, entry), projection);
    });

    return listEnvelope(result, nextCursor);
  }

  /**
   * Get a specific issue by its identifier with full details.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @returns {Promise<Object>}
   */
  async getIssue(issueId, options = {}) {
    const projection = normalizeIssueReadOptions(options, 'single');
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const field = name => projection.fields.has(name);
    const included = name => projection.include.has(name);
    const needsStatus = field('status') || field('completedAt') || included('children');
    const needsType = field('type') || included('children');
    const [statusData, taskTypeMap, employeeData, components, issueLabels] = await Promise.all([
      needsStatus
        ? this._buildStatusMaps(client)
        : Promise.resolve({ statusMap: new Map(), doneStatuses: new Set() }),
      needsType ? this._buildTaskTypeMap(client) : Promise.resolve(new Map()),
      field('assignee') ? this._buildEmployeeMap(client) : Promise.resolve({ employeeMap: new Map() }),
      field('component')
        ? client.findAll(tracker.class.Component, { space: project._id })
        : Promise.resolve([]),
      field('labels')
        ? client.findAll(tags.class.TagReference, { attachedTo: issue._id })
        : Promise.resolve([])
    ]);
    const { statusMap, doneStatuses } = statusData;
    const { employeeMap } = employeeData;
    const componentMap = new Map(components.map(c => [c._id, c.label]));

    const descriptionPromise = included('description')
      ? (async () => {
        const rawDesc = issue.description;
        return typeof rawDesc === 'string' && /^[a-f0-9]+-\w+-\d+$/.test(rawDesc)
          ? this._readCollaboratorField(issue._id, issue._class, 'description', rawDesc)
          : fromMarkup(rawDesc);
      })()
      : Promise.resolve(undefined);
    const parentPromise = field('parent') && issue.attachedTo && issue.attachedToClass === tracker.class.Issue
      ? (async () => {
        const parentIssue = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
        if (!parentIssue) return null;
        const parentProject = await client.findOne(tracker.class.Project, { _id: parentIssue.space });
        return parentProject ? `${parentProject.identifier}-${parentIssue.number}` : null;
      })()
      : Promise.resolve(null);
    const milestonePromise = field('milestone') && issue.milestone
      ? client.findOne(tracker.class.Milestone, { _id: issue.milestone })
      : Promise.resolve(null);
    const [descriptionContent, parentId, milestone, comments, timeReports, children, relatedIssueMap] = await Promise.all([
      descriptionPromise,
      parentPromise,
      milestonePromise,
      included('comments') || included('activity')
        ? client.findAll(chunter.class.ChatMessage, { attachedTo: issue._id }, { sort: { createdOn: 1 } })
        : Promise.resolve([]),
      included('timeReports') || included('activity')
        ? client.findAll(tracker.class.TimeSpendReport, { attachedTo: issue._id }, { sort: { date: -1 } })
        : Promise.resolve([]),
      included('children')
        ? client.findAll(tracker.class.Issue, {
          space: project._id,
          attachedTo: issue._id,
          attachedToClass: tracker.class.Issue
        })
        : Promise.resolve([]),
      included('relations') || included('blockedBy')
        ? this._buildRelatedIssueMap(client, [issue])
        : Promise.resolve(new Map())
    ]);

    const result = { id: `${project.identifier}-${issue.number}` };
    if (field('title')) result.title = issue.title;
    if (field('status')) result.status = strictGet(statusMap, issue.status, 'Status');
    if (field('priority')) result.priority = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
    if (field('type')) result.type = strictGet(taskTypeMap, issue.kind, 'Task type');
    if (field('assignee')) result.assignee = issue.assignee ? employeeMap.get(issue.assignee) ?? null : null;
    if (field('component')) result.component = issue.component ? componentMap.get(issue.component) ?? null : null;
    if (field('labels')) result.labels = issueLabels.map(item => item.title);
    if (field('parent')) result.parent = parentId;
    if (field('childCount')) result.childCount = issue.subIssues || 0;
    if (field('milestone')) {
      result.milestone = milestone ? {
        id: milestone._id,
        name: milestone.label,
        status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status')
      } : null;
    }
    if (field('dueDate')) result.dueDate = issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null;
    const issueTimes = this._issueTimeFields(issue);
    if (field('estimation')) result.estimation = issueTimes.estimation;
    if (field('reportedTime')) result.reportedTime = issueTimes.reportedTime;
    if (field('createdOn')) result.createdOn = issue.createdOn;
    if (field('modifiedOn')) result.modifiedOn = issue.modifiedOn;
    if (field('completedAt')) result.completedAt = doneStatuses.has(issue.status) ? issue.modifiedOn : null;

    if (included('description')) {
      const preview = markdownPreview(descriptionContent ?? '', projection.descriptionPreviewChars);
      result.description = preview.text;
      if (projection.emitExpansionMetadata || preview.truncated) {
        result.descriptionTruncated = preview.truncated;
      }
    }
    const assignBounded = (key, values, maximum) => {
      const bounded = boundedCollection(values, maximum);
      result[key] = bounded.items;
      if (projection.emitExpansionMetadata || bounded.truncated) {
        result[`${key}Count`] = bounded.count;
        result[`${key}Truncated`] = bounded.truncated;
      }
    };
    if (included('comments')) {
      assignBounded('comments', comments.map(comment => ({
        id: comment._id,
        text: fromMarkup(comment.message),
        createdBy: comment.createdBy || null,
        createdOn: comment.createdOn,
        modifiedOn: comment.modifiedOn
      })), projection.limits.comments);
    }
    if (included('activity')) {
      const activity = [
        ...comments.map(comment => ({
          type: 'comment',
          text: fromMarkup(comment.message),
          date: comment.createdOn,
          dateFormatted: comment.createdOn ? new Date(comment.createdOn).toISOString() : null
        })),
        ...timeReports.map(report => ({
          type: 'time_logged',
          hours: report.value,
          description: fromMarkup(report.description),
          date: report.date,
          dateFormatted: toIsoDate(report.date)
        }))
      ].sort((a, b) => (a.date || 0) - (b.date || 0));
      assignBounded('activity', activity, projection.limits.activity);
    }
    if (included('timeReports')) {
      assignBounded('timeReports', timeReports.map(report => ({
        id: report._id,
        hours: report.value,
        description: fromMarkup(report.description),
        date: toIsoDate(report.date)
      })), projection.limits.timeReports);
    }
    if (included('relations') || included('blockedBy')) {
      const relationData = this._projectRelations(issue, relatedIssueMap, projection.limits.relations);
      for (const key of ['relations', 'blockedBy']) {
        if (!included(key)) continue;
        result[key] = relationData[key];
        if (projection.emitExpansionMetadata || relationData[`${key}Truncated`]) {
          result[`${key}Count`] = relationData[`${key}Count`];
          result[`${key}Truncated`] = relationData[`${key}Truncated`];
        }
      }
    }
    if (included('children')) {
      assignBounded('children', children.map(child => ({
        id: `${project.identifier}-${child.number}`,
        title: child.title,
        status: strictGet(statusMap, child.status, 'Status'),
        type: strictGet(taskTypeMap, child.kind, 'Task type')
      })), projection.limits.children);
    }

    return projectIssueFields(withExtra(issue, result), projection);
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

    // Atomically increment sequence to avoid duplicate issue numbers under concurrent creates
    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      $inc: { sequence: 1 }
    });
    const updatedProject = await client.findOne(tracker.class.Project, { _id: project._id });
    const nextNumber = updatedProject.sequence;

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
      if (!found) {
        const available = statuses.map(s => s.name).join(', ');
        throw new Error(`Status "${status}" not found. Available: ${available}`);
      }
      statusId = found._id;
    } else {
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
        priority: resolvePriority(priority),
        number: nextNumber,
        assignee: assigneeId,
        component: componentId,
        milestone: milestoneId,
        estimation: toHours(extra.estimation),
        dueDate: normalizeDueDate(extra.dueDate),
        remainingTime: 0,
        reportedTime: 0,
        childInfo: [],
        parents: [],
        kind: taskTypeId,
        rank: makeRank(undefined, undefined)
      },
      issueId
    );

    if (description) {
      // Write description via collaborator for proper UI rendering.
      // Set a collaborator reference on the doc first, then write content
      // via updateMarkup which updates the live document.
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
      updates.priority = resolvePriority(priority, issue.priority);
      updatedFields.push('priority');
    }

    // Resolve type first so status can be scoped to the new type
    let resolvedTaskTypeId = issue.kind;
    if (type !== undefined) {
      resolvedTaskTypeId = await this._findTaskTypeByName(client, project.identifier, type);
      updates.kind = resolvedTaskTypeId;
      updatedFields.push('type');
    }

    if (status !== undefined) {
      const taskTypeId = resolvedTaskTypeId || await this._getDefaultTaskType(client, project);
      const statuses = await this._getScopedStatuses(client, project, taskTypeId);
      const found = statuses.find(s => nameMatch(s.name, status));
      if (!found) {
        const available = statuses.map(s => s.name).join(', ');
        throw new Error(`Status "${status}" not found. Available: ${available}`);
      }
      updates.status = found._id;
      updatedFields.push('status');
    }

    if (extra.assignee !== undefined) {
      updates.assignee = await this._findEmployeeByName(client, extra.assignee);
      updatedFields.push('assignee');
    }

    if (extra.component !== undefined) {
      updates.component = await this._findComponentByName(client, project._id, extra.component);
      updatedFields.push('component');
    }

    if (extra.milestone !== undefined) {
      updates.milestone = await this._findMilestoneByName(client, project._id, extra.milestone);
      updatedFields.push('milestone');
    }

    if (extra.dueDate !== undefined) {
      updates.dueDate = normalizeDueDate(extra.dueDate);
      updatedFields.push('dueDate');
    }

    if (extra.estimation !== undefined) {
      updates.estimation = toHours(extra.estimation);
      updatedFields.push('estimation');
    }

    if (Object.keys(updates).length > 0) {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, updates);
    }

    if (description !== undefined) {
      // Write description via collaborator service for proper UI rendering.
      // updateMarkup writes to the live document, which getMarkup reads back.
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

    await client.removeCollection(tags.class.TagReference, tagRef.space, tagRef._id, tagRef.attachedTo, tagRef.attachedToClass, tagRef.collection);

    return { message: `Label "${labelName}" removed` };
  }

  /**
   * List all available labels for issues.
   * @returns {Promise<Object[]>}
   */
  async listLabels(options = {}) {
    const client = await this._getClient();

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });

    const enriched = tagElements.map(t => withExtra(t, {
      id: t._id,
      name: t.title,
      description: t.description || '',
      color: t.color ?? null,
      category: t.category || null
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_labels' }
    });
  }

  /**
   * Create a new label for issues.
   * @param {string} name - Label name
   * @param {number} [color] - Label color as hex number
   * @returns {Promise<Object>}
   */
  async createLabel(name, color, description) {
    const client = await this._getClient();

    const existing = await client.findOne(tags.class.TagElement, {
      title: name,
      targetClass: tracker.class.Issue
    });

    if (existing) {
      return { message: `Label "${name}" already exists`, id: existing._id };
    }

    // A built-in project such as tracker:project:DefaultProject is a
    // model-level space, and a TagElement created there is silently not
    // persisted. Own the label with a real, database-created project.
    const projects = await client.findAll(tracker.class.Project, {});
    const project = projects.find(candidate => !String(candidate._id).includes(':')) ?? null;
    if (!project) {
      throw new Error('Cannot create a label: the workspace has no project to own it');
    }
    const space = project._id;

    const tagId = generateId();
    await client.createDoc(tags.class.TagElement, space, {
      title: name,
      targetClass: tracker.class.Issue,
      description: description || '',
      color: resolveColor(color),
      category: DEFAULT_LABEL_CATEGORY
    }, tagId);
    this._labelLookupCache.clear();

    // createDoc resolves even when the server discards the document, which is
    // how a label written to a model-level space used to report success while
    // persisting nothing. Confirm the write before claiming it happened.
    const persisted = await client.findOne(tags.class.TagElement, {
      _id: tagId,
      targetClass: tracker.class.Issue
    });
    if (!persisted) {
      throw new Error(
        `Label "${name}" was not persisted by the server. This usually means the owning space is not a real project space.`
      );
    }

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

    // Issue reads and removeLabel match on the denormalised TagReference.title.
    // Renaming only the element leaves the label answering to its old name
    // there and its new name in label filters.
    let renamedReferences = 0;
    if (ops.title !== undefined) {
      const references = await client.findAll(tags.class.TagReference, { tag: tagElement._id });
      for (const reference of references) {
        await client.updateDoc(tags.class.TagReference, reference.space, reference._id, {
          title: ops.title
        });
        renamedReferences += 1;
      }
    }
    this._labelLookupCache.clear();

    return {
      message: `Label "${name}" updated`,
      id: tagElement._id,
      updated: Object.keys(ops),
      ...(ops.title !== undefined ? { renamedReferences } : {})
    };
  }

  async deleteLabel(name) {
    const client = await this._getClient();
    const tagElement = await client.findOne(tags.class.TagElement, {
      title: name,
      targetClass: tracker.class.Issue
    });
    if (!tagElement) throw new Error(`Label "${name}" not found`);
    await client.removeDoc(tags.class.TagElement, tagElement.space, tagElement._id);
    this._labelLookupCache.clear();
    return { message: `Label "${name}" deleted`, id: tagElement._id };
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

    // Write reverse relation on the target issue
    const { project: relProject } = await this._parseAndFindIssue(client, relatedToIssueId);
    const targetRelations = relatedIssue.relations || [];
    if (!targetRelations.some(r => r._id === issue._id)) {
      await client.updateDoc(tracker.class.Issue, relProject._id, relatedIssue._id, {
        relations: [...targetRelations, { _id: issue._id, _class: issue._class }]
      });
    }

    return {
      message: `Added relation: ${issueId} ↔ ${relatedToIssueId}`,
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
   * Detach a sub-issue from its parent, returning it to the project's own
   * issue collection. Mirrors the attach path in setParent.
   */
  async _detachParent(client, project, issue, issueId) {
    if (issue.attachedToClass !== tracker.class.Issue || !issue.attachedTo) {
      return { message: `${issueId} has no parent`, issueId, parentId: null };
    }

    const oldParent = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
    if (oldParent) {
      const remaining = (oldParent.childInfo || []).filter(c => c.childId !== issue._id);
      await client.updateDoc(tracker.class.Issue, oldParent.space, oldParent._id, {
        childInfo: remaining,
        subIssues: remaining.length
      });
    }

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      project._id,
      tracker.class.Project,
      'issues',
      {
        parents: [],
        attachedTo: project._id,
        attachedToClass: tracker.class.Project,
        collection: 'issues'
      }
    );

    return { message: `Removed parent from ${issueId}`, issueId, parentId: null };
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

    // The tool advertises an empty parentId as "remove parent". Without this
    // branch that call reached _parseAndFindIssue and threw, leaving no way to
    // detach a sub-issue through the advertised API.
    if (parentIssueId === undefined || parentIssueId === null || String(parentIssueId).trim() === '') {
      return await this._detachParent(client, project, issue, issueId);
    }

    const { project: parentProject, issue: parentIssue } = await this._parseAndFindIssue(client, parentIssueId);

    // Clean up old parent if the child already has one
    if (issue.attachedTo && issue.attachedToClass === tracker.class.Issue && issue.attachedTo !== parentIssue._id) {
      const oldParent = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
      if (oldParent) {
        const oldChildInfo = (oldParent.childInfo || []).filter(c => c.childId !== issue._id);
        const oldParentProject = await client.findOne(tracker.class.Project, { _id: oldParent.space });
        if (oldParentProject) {
          await client.updateDoc(tracker.class.Issue, oldParentProject._id, oldParent._id, {
            childInfo: oldChildInfo,
            subIssues: oldChildInfo.length
          });
        }
      }
    }

    // Build full ancestor chain for breadcrumbs
    const parentInfo = {
      parentId: parentIssue._id,
      identifier: `${parentProject.identifier}-${parentIssue.number}`,
      parentTitle: parentIssue.title,
      space: parentProject._id
    };
    const ancestors = [...(parentIssue.parents || []), parentInfo];

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      parentIssue._id,
      tracker.class.Issue,
      'subIssues',
      {
        parents: ancestors,
        attachedTo: parentIssue._id,
        attachedToClass: tracker.class.Issue,
        collection: 'subIssues'
      }
    );

    const childInfo = {
      childId: issue._id,
      ...this._issueTimeFields(issue)
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
  async listTaskTypes(projectIdent, options = {}) {
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

    const enriched = typesToReturn.map(tt => ({
      id: tt._id,
      name: tt.name || tt._id.split(':').pop(),
      description: fromMarkup(tt.description),
      kind: tt.kind || null,
      ofClass: tt.ofClass,
      parent: tt.parent,
      allowedAsChildOf: tt.allowedAsChildOf || [],
      statusCategories: tt.statusCategories || [],
      statuses: tt.statuses || []
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_task_types', project: projectIdent.toUpperCase() }
    });
  }

  /**
   * List the project types configured in the workspace. These are the valid
   * values for the `projectType` argument of createProject. Returns the names
   * of the task types scoped to each, for convenience.
   * @returns {Promise<Object>} { items, nextCursor? }
   */
  async listProjectTypes(options = {}) {
    const client = await this._getClient();

    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const taskTypeById = new Map(allTaskTypes.map(tt => [tt._id, tt]));

    const enriched = projectTypes.map(pt => ({
      id: pt._id,
      name: pt.name || pt._id.split(':').pop(),
      description: fromMarkup(pt.description) || pt.shortDescription || null,
      taskTypes: (pt.tasks || [])
        .map(id => taskTypeById.get(id))
        .filter(Boolean)
        .map(tt => tt.name || tt._id.split(':').pop())
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_project_types' }
    });
  }

  /**
   * List available issue statuses, optionally scoped to a project or task type.
   * @param {string} [projectIdent] - Project identifier to scope statuses
   * @param {string} [taskTypeName] - Task type name to scope statuses (e.g., "Task", "Epic")
   * @returns {Promise<Object[]>}
   */
  async listStatuses(projectIdent, taskTypeName, options = {}) {
    const client = await this._getClient();

    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});

    // If no scoping requested, return all
    if (!projectIdent && !taskTypeName) {
      const enriched = allStatuses.map(s => ({
        id: s._id,
        name: s.name,
        category: STATUS_CATEGORY_NAMES[s.category] || s.category,
        color: s.color,
        description: fromMarkup(s.description)
      }));
      return this._cursoredFindAll(enriched, {
        ...options,
        cursorScope: { workspace: this.workspace, tool: 'list_statuses', project: null, taskType: null }
      });
    }

    // Get task types scoped to this project
    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    let relevantTaskTypes = allTaskTypes;

    if (projectIdent) {
      const project = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (!project) throw new Error(`Project not found: ${projectIdent}`);
      const projectTypes = await client.findAll(task.class.ProjectType, {});
      const projectType = projectTypes.find(pt => pt._id === project.type);
      // An unresolvable project type is a data problem, not a licence to return
      // every status in the workspace as though it were project-scoped. A type
      // that simply declares no task types legitimately scopes to nothing.
      if (!projectType) {
        throw new Error(`Project type not found for project ${projectIdent}`);
      }
      const taskTypeIds = new Set(projectType.tasks ?? []);
      relevantTaskTypes = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    }

    // Further filter by task type name. An unknown name must fail rather than
    // fall through to the unscoped status list below.
    if (taskTypeName) {
      relevantTaskTypes = relevantTaskTypes.filter(tt => nameMatch(tt.name, taskTypeName));
      if (relevantTaskTypes.length === 0) {
        throw new Error(`Task type not found: ${taskTypeName}`);
      }
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
    const scopedStatuses = allStatuses.filter(s => statusIds.has(s._id));

    const enriched = scopedStatuses.map(s => ({
      id: s._id,
      name: s.name,
      category: STATUS_CATEGORY_NAMES[s.category] || s.category,
      color: s.color,
      description: s.description || ''
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: {
        workspace: this.workspace,
        tool: 'list_statuses',
        project: projectIdent?.toUpperCase() ?? null,
        taskType: taskTypeName?.toLowerCase() ?? null
      }
    });
  }

  /**
   * List all milestones in a project with optional status filtering.
   * @param {string} projectIdent - Project identifier
   * @param {string} [status] - Filter by status
   * @returns {Promise<Object[]>}
   */
  async listMilestones(projectIdent, status, options = {}) {
    const client = await this._getClient();
    const include = normalizeIncludeSet(options.include, MILESTONE_INCLUDE_FIELDS);
    const issuesLimit = normalizePageLimit(options.issuesLimit, 20, 100);

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });

    if (!project) {
      throw new Error(`Project not found: ${projectIdent}`);
    }

    const query = { space: project._id };

    if (status) {
      const statusValue = MILESTONE_STATUS_MAP[status.toLowerCase()];
      if (statusValue === undefined) throw new Error(`Milestone status not found: ${status}`);
      query.status = statusValue;
    }

    const milestones = await client.findAll(tracker.class.Milestone, query, {
      sort: { targetDate: 1 }
    });

    const cursorScope = {
      workspace: this.workspace,
      tool: 'list_milestones',
      project: projectIdent.toUpperCase(),
      status: status?.toLowerCase() ?? null,
      include: [...include].sort(),
      issuesLimit
    };
    const page = this._cursoredFindAll(milestones, { ...options, cursorScope });
    const selectedMilestones = page.items;
    let issuesByMilestone = new Map();
    let statusMap;
    let taskTypeMap;
    if (include.has('issues') && selectedMilestones.length > 0) {
      const milestoneIds = selectedMilestones.map(milestone => milestone._id);
      const [allIssues, statusMaps, fetchedTaskTypeMap] = await Promise.all([
        client.findAll(tracker.class.Issue, {
          space: project._id,
          milestone: { $in: milestoneIds }
        }),
        this._buildStatusMaps(client),
        this._buildTaskTypeMap(client)
      ]);
      statusMap = statusMaps.statusMap;
      taskTypeMap = fetchedTaskTypeMap;
      issuesByMilestone = new Map();
      for (const issue of allIssues) {
        if (!issuesByMilestone.has(issue.milestone)) issuesByMilestone.set(issue.milestone, []);
        issuesByMilestone.get(issue.milestone).push(issue);
      }
    }

    const items = selectedMilestones.map(milestone => {
      const base = {
        id: milestone._id,
        name: milestone.label,
        description: fromMarkup(milestone.description),
        status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status'),
        targetDate: milestone.targetDate
          ? new Date(milestone.targetDate).toISOString().split('T')[0]
          : null,
        comments: milestone.comments || 0
      };
      if (include.has('issues')) {
        const projected = (issuesByMilestone.get(milestone._id) || []).map(issue => ({
          id: `${project.identifier}-${issue.number}`,
          title: issue.title,
          status: strictGet(statusMap, issue.status, 'Status'),
          type: strictGet(taskTypeMap, issue.kind, 'Task type')
        }));
        const bounded = boundedCollection(projected, issuesLimit);
        base.issues = bounded.items;
        base.issuesCount = bounded.count;
        base.issuesTruncated = bounded.truncated;
      }
      return withExtra(milestone, base);
    });
    return listEnvelope(items, page.nextCursor);
  }

  /**
   * Get a specific milestone by name with issue count.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Milestone name
   * @returns {Promise<Object>}
   */
  async getMilestone(projectIdent, name, options = {}) {
    const client = await this._getClient();
    const include = normalizeIncludeSet(options.include, MILESTONE_INCLUDE_FIELDS);
    const issuesLimit = normalizePageLimit(options.issuesLimit, 20, 100);

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

    const base = {
      id: milestone._id,
      name: milestone.label,
      description: fromMarkup(milestone.description),
      status: strictGet(MILESTONE_STATUS_NAMES, milestone.status, 'Milestone status'),
      targetDate: milestone.targetDate ? new Date(milestone.targetDate).toISOString().split('T')[0] : null,
      comments: milestone.comments || 0,
      issueCount: issues.length
    };

    if (include.has('issues')) {
      const { statusMap } = await this._buildStatusMaps(client);
      const taskTypeMap = await this._buildTaskTypeMap(client);

      const projected = issues.map(i => ({
        id: `${project.identifier}-${i.number}`,
        title: i.title,
        status: strictGet(statusMap, i.status, 'Status'),
        type: strictGet(taskTypeMap, i.kind, 'Task type')
      }));
      const bounded = boundedCollection(projected, issuesLimit);
      base.issues = bounded.items;
      base.issuesCount = bounded.count;
      base.issuesTruncated = bounded.truncated;
    }

    return withExtra(milestone, base);
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

    const allMilestones = await client.findAll(tracker.class.Milestone, { space: project._id });
    const existing = allMilestones.find(m => nameMatch(m.label, name));

    if (existing) {
      return {
        message: `Milestone "${name}" already exists`,
        id: existing._id,
        name: existing.label
      };
    }

    const targetTimestamp = normalizeDueDate(targetDate) ??
      Date.now() + (DEFAULT_MILESTONE_DAYS * 24 * 60 * 60 * 1000);

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
    const found = employees.find(e => nameMatch(e.name, assigneeName));

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

  /**
   * Set or clear the due date on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} [dueDate] - Due date ISO 8601, or empty to clear
   * @returns {Promise<Object>}
   */
  async setDueDate(issueId, dueDate) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    const timestamp = normalizeDueDate(dueDate);

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

    const normalizedHours = toHours(hours);

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      estimation: normalizedHours
    });

    return { message: `Estimation set to ${normalizedHours}h on ${issueId}`, issueId, estimation: normalizedHours };
  }

  /**
   * Log time spent on an issue.
   * @param {string} issueId - Issue identifier
   * @param {number} hours - Hours spent
   * @param {string} [description] - Description of work done
   * @returns {Promise<Object>}
   */
  async logTime(issueId, hours, description, date, employeeName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // Resolve employee — default to current user's Employee ref if possible
    let employeeId = null;
    if (employeeName) {
      employeeId = await this._findEmployeeByName(client, employeeName);
    }

    const normalizedHours = toHours(hours);
    const reportId = generateId();
    await client.addCollection(
      tracker.class.TimeSpendReport,
      project._id,
      issue._id,
      tracker.class.Issue,
      'reports',
      {
        employee: employeeId,
        date: normalizeReportDate(date),
        value: normalizedHours,
        description: description || ''
      },
      reportId
    );

    const newReported = toHours(issue.reportedTime) + normalizedHours;
    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      reportedTime: newReported
    });

    return {
      message: `Logged ${normalizedHours}h on ${issueId}`,
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
  async searchIssues(query, projectIdent, limit = 20, cursor) {
    const client = await this._getClient();
    limit = normalizePageLimit(limit, 20, MAX_PAGE_SIZE);

    const searchQuery = { $search: query };

    if (projectIdent) {
      const proj = await client.findOne(tracker.class.Project, {
        identifier: projectIdent.toUpperCase()
      });
      if (!proj) throw new Error(`Project not found: ${projectIdent}`);
      searchQuery.space = proj._id;
    }

    const fetchResult = await this._paginatedFindAll(client, tracker.class.Issue, searchQuery, {
      limit,
      cursor,
      cursorScope: {
        workspace: this.workspace,
        tool: 'search_issues',
        query: query.trim().toLowerCase(),
        project: projectIdent?.toUpperCase() ?? null
      }
    });
    const issues = fetchResult.items;

    const { statusMap, doneStatuses } = await this._buildStatusMaps(client);

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    const taskTypeMap = await this._buildTaskTypeMap(client);
    const { employeeMap } = await this._buildEmployeeMap(client);

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

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) ?? '?'}-${p.number}`]));

    const items = issues.map(i => withExtra(i, {
      id: `${strictGet(projMap, i.space, 'Issue project')}-${i.number}`,
      title: i.title,
      status: strictGet(statusMap, i.status, 'Status'),
      priority: strictGet(PRIORITY_NAMES, i.priority, 'Priority'),
      type: strictGet(taskTypeMap, i.kind, 'Task type'),
      assignee: i.assignee ? employeeMap.get(i.assignee) ?? null : null,
      component: i.component ? componentMap.get(i.component) ?? null : null,
      milestone: i.milestone ? milestoneMap.get(i.milestone) ?? null : null,
      parent: (i.attachedTo && i.attachedToClass === tracker.class.Issue) ? parentMap.get(i.attachedTo) ?? null : null,
      childCount: i.subIssues || 0,
      dueDate: i.dueDate ? new Date(i.dueDate).toISOString().split('T')[0] : null,
      createdOn: i.createdOn,
      modifiedOn: i.modifiedOn,
      completedAt: doneStatuses.has(i.status) ? i.modifiedOn : null
    }));
    return listEnvelope(items, fetchResult.nextCursor);
  }

  // ── New Methods (Tier 1–2) ─────────────────────────────────────

  /**
   * Get issues assigned to the currently authenticated user.
   * @param {string} [projectIdent] - Optional project filter
   * @param {string} [status] - Optional status filter
   * @param {number} [limit=500] - Maximum results
   * @returns {Promise<Object[]>}
   */
  async getMyIssues(projectIdent, status, limit = DEFAULT_PAGE_SIZE, cursor) {
    const client = await this._getClient();
    limit = normalizePageLimit(limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

    // Find the current user's employee record via email channels or account matching
    const { employees, employeeMap } = await this._buildEmployeeMap(client);

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
      if (!proj) throw new Error(`Project not found: ${projectIdent}`);
      query.space = proj._id;
    }

    // Resolve status name to ID for server-side filtering
    const { statuses, statusMap, doneStatuses } = await this._buildStatusMaps(client);

    if (status) {
      const matchingStatuses = statuses.filter(s => nameMatch(s.name, status));
      if (matchingStatuses.length > 0) {
        query.status = matchingStatuses.length === 1
          ? matchingStatuses[0]._id
          : { $in: matchingStatuses.map(s => s._id) };
      } else {
        throw new Error(`Status not found: ${status}`);
      }
    }

    const fetchResult = await this._paginatedFindAll(client, tracker.class.Issue, query, {
      limit,
      cursor,
      cursorScope: {
        workspace: this.workspace,
        tool: 'get_my_issues',
        project: projectIdent?.toUpperCase() ?? null,
        status: status?.toLowerCase() ?? null,
        assignee: me._id
      }
    });
    const issues = fetchResult.items;

    const projects = await client.findAll(tracker.class.Project, {});
    const projMap = new Map(projects.map(p => [p._id, p.identifier]));

    // Batch fetch all labels for efficiency (avoids N+1)
    const issueIds = issues.map(i => i._id);
    const allLabels = issueIds.length > 0
      ? await client.findAll(tags.class.TagReference, { attachedTo: { $in: issueIds } })
      : [];
    const labelsByIssue = this._groupLabelsByIssue(allLabels);

    const taskTypeMap = await this._buildTaskTypeMap(client);

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

    const parentIds = [...new Set(issues
      .filter(i => i.attachedTo && i.attachedToClass === tracker.class.Issue)
      .map(i => i.attachedTo))];
    const parentIssues = parentIds.length > 0
      ? await client.findAll(tracker.class.Issue, { _id: { $in: parentIds } })
      : [];
    const parentMap = new Map(parentIssues.map(p => [p._id, `${projMap.get(p.space) ?? '?'}-${p.number}`]));

    const result = [];
    for (const issue of issues) {
      const issueLabels = labelsByIssue.get(issue._id) || [];

      result.push(withExtra(issue, {
        id: `${strictGet(projMap, issue.space, 'Issue project')}-${issue.number}`,
        title: issue.title,
        status: strictGet(statusMap, issue.status, 'Status'),
        priority: strictGet(PRIORITY_NAMES, issue.priority, 'Priority'),
        type: strictGet(taskTypeMap, issue.kind, 'Task type'),
        assignee: issue.assignee ? employeeMap.get(issue.assignee) ?? null : null,
        component: issue.component ? componentMap.get(issue.component) ?? null : null,
        labels: issueLabels.map(l => l.title),
        parent: (issue.attachedTo && issue.attachedToClass === tracker.class.Issue) ? parentMap.get(issue.attachedTo) ?? null : null,
        childCount: issue.subIssues || 0,
        milestone: issue.milestone ? milestoneMap.get(issue.milestone) ?? null : null,
        dueDate: issue.dueDate ? new Date(issue.dueDate).toISOString().split('T')[0] : null,
        ...this._issueTimeFields(issue),
        createdOn: issue.createdOn,
        modifiedOn: issue.modifiedOn,
        completedAt: doneStatuses.has(issue.status) ? issue.modifiedOn : null
      }));
    }

    return listEnvelope(result, fetchResult.nextCursor);
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
    if (issues.length > MAX_BATCH_SIZE) throw new Error(`Batch size limited to ${MAX_BATCH_SIZE} issues`);

    // Cache lookups to avoid N+1 queries in the loop
    const cachedTaskTypes = await client.findAll(task.class.TaskType, {});
    const defaultTaskTypeId = await this._getDefaultTaskType(client, project);
    const scopedStatuses = await this._getScopedStatuses(client, project, defaultTaskTypeId);
    const defaultStatusId = project.defaultIssueStatus || scopedStatuses[0]._id;
    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });

    const created = [];

    // Atomically reserve sequence range for the entire batch
    const validCount = issues.filter(i => i.title).length;
    await client.updateDoc(tracker.class.Project, project.space || project._id, project._id, {
      $inc: { sequence: validCount }
    });
    const updatedProject = await client.findOne(tracker.class.Project, { _id: project._id });
    // Assign numbers from the reserved range: (end - count + 1) to end
    let currentSequence = updatedProject.sequence - validCount;

    for (const item of issues) {
      if (!item.title) {
        created.push({ error: 'Missing title', input: item });
        continue;
      }

      currentSequence++;

      let statusId = defaultStatusId;
      if (item.status) {
        const found = scopedStatuses.find(s => nameMatch(s.name, item.status));
        if (!found) {
          const available = scopedStatuses.map(s => s.name).join(', ');
          created.push({ error: `Status "${item.status}" not found. Available: ${available}`, input: item });
          continue;
        }
        statusId = found._id;
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
        if (!found) {
          const available = employees.map(e => e.name).join(', ');
          created.push({ error: `Assignee "${item.assignee}" not found. Available: ${available}`, input: item });
          continue;
        }
        assigneeId = found._id;
      }

      let componentId = null;
      if (item.component) {
        const found = components.find(c => nameMatch(c.label, item.component));
        if (!found) {
          const available = components.map(c => c.label).join(', ');
          created.push({ error: `Component "${item.component}" not found. Available: ${available}`, input: item });
          continue;
        }
        componentId = found._id;
      }

      let milestoneId = null;
      if (item.milestone) {
        const found = milestones.find(m => nameMatch(m.label, item.milestone));
        if (!found) {
          const available = milestones.map(m => m.label).join(', ');
          created.push({ error: `Milestone "${item.milestone}" not found. Available: ${available}`, input: item });
          continue;
        }
        milestoneId = found._id;
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
          estimation: toHours(item.estimation),
          dueDate: normalizeDueDate(item.dueDate),
          remainingTime: 0,
          reportedTime: 0,
          childInfo: [],
          parents: [],
          kind: taskTypeId,
          rank: makeRank(undefined, undefined)
        },
        issueId
      );

      if (item.description) {
        try {
          await this._writeCollaboratorField(issueId, tracker.class.Issue, item.description, item.descriptionFormat);
        } catch {
          // Fallback to markup if collaborator unavailable
          await client.updateDoc(tracker.class.Issue, project._id, issueId, {
            description: toMarkup(item.description, item.descriptionFormat)
          });
        }
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

    // Atomic sequence increment in target project
    await client.updateDoc(tracker.class.Project, destProject.space || destProject._id, destProject._id, {
      $inc: { sequence: 1 }
    });
    const updatedDest = await client.findOne(tracker.class.Project, { _id: destProject._id });
    const nextNumber = updatedDest.sequence;

    // Validate status availability and remap when the target project lacks the same status
    const issueUpdates = {
      space: destProject._id,
      number: nextNumber,
      identifier: `${destProject.identifier}-${nextNumber}`
    };

    // Fix attachedTo for top-level issues (attached to source project)
    if (issue.attachedTo === sourceProject._id || issue.attachedToClass === tracker.class.Project) {
      issueUpdates.attachedTo = destProject._id;
    }

    // Remap status if needed
    const destTaskTypeId = issue.kind ?? await this._getDefaultTaskType(client, destProject);
    const destStatuses = await this._getScopedStatuses(client, destProject, destTaskTypeId);
    const srcStatusMap = await this._buildStatusMaps(client, sourceProject);
    const currentStatusName = srcStatusMap.statusMap.get(issue.status);
    if (currentStatusName) {
      const destStatus = destStatuses.find(s => nameMatch(s.name, currentStatusName));
      if (destStatus) {
        issueUpdates.status = destStatus._id;
      } else {
        // Fall back to target project's default status
        issueUpdates.status = destProject.defaultIssueStatus || destStatuses[0]?._id;
      }
    }

    await client.updateDoc(tracker.class.Issue, sourceProject._id, issue._id, issueUpdates);

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
    const { statuses, statusMap } = await this._buildStatusMaps(client);
    const closedStatuses = new Set(statuses
      .filter(s => s.category === DONE_CATEGORY || s.category === LOST_CATEGORY)
      .map(s => s._id));
    const milestones = await client.findAll(tracker.class.Milestone, { space: project._id });

    // Count by status
    const byStatus = {};
    for (const issue of issues) {
      const name = strictGet(statusMap, issue.status, 'Status');
      byStatus[name] = (byStatus[name] || 0) + 1;
    }

    // Count by priority
    const byPriority = {};
    for (const issue of issues) {
      const name = strictGet(PRIORITY_NAMES, issue.priority, 'Priority');
      byPriority[name] = (byPriority[name] || 0) + 1;
    }

    // Overdue issues
    const now = Date.now();
    const overdue = issues.filter(i => {
      if (!i.dueDate) return false;
      return i.dueDate < now && !closedStatuses.has(i.status);
    });

    const overdueList = overdue.map(i => ({
      id: `${project.identifier}-${i.number}`,
      title: i.title,
      dueDate: new Date(i.dueDate).toISOString().split('T')[0],
      priority: strictGet(PRIORITY_NAMES, i.priority, 'Priority')
    }));

    // Unassigned count
    const unassigned = issues.filter(i => !i.assignee).length;

    // Estimation stats
    const totalEstimation = issues.reduce((sum, i) => sum + toHours(i.estimation), 0);
    const totalReported = issues.reduce((sum, i) => sum + toHours(i.reportedTime), 0);

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
        status: strictGet(MILESTONE_STATUS_NAMES, m.status, 'Milestone status'),
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
        dateFormatted: toIsoDate(tr.date)
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
    const client = await this._getClient();
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

    const taskTypes = await client.findAll(task.class.TaskType, {});
    const availableTypes = new Set(taskTypes.map(t => t.name));

    for (const item of template.issues) {
      // Create parent issue
      const resolvedType = (item.type && availableTypes.has(item.type)) ? item.type : undefined;
      const parent = await this.createIssue(
        projectIdent, item.title, item.description || '',
        item.priority || 'medium', item.status || 'Todo',
        item.labels || [], resolvedType
      );
      allCreated.push(parent);

      // Create children and link to parent
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          const resolvedChildType = (child.type && availableTypes.has(child.type)) ? child.type : undefined;
          const childIssue = await this.createIssue(
            projectIdent, child.title, child.description || '',
            child.priority || 'medium', child.status || 'Todo',
            child.labels || [], resolvedChildType
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

  async createProject(identifier, name, description, isPrivate = false, projectType) {
    const client = await this._getClient();

    identifier = identifier.toUpperCase();
    const existing = await client.findOne(tracker.class.Project, { identifier });
    if (existing) {
      throw new Error(`Project with identifier "${identifier}" already exists`);
    }

    // Resolve project type first — needed to scope statuses
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

    // Scope default status to the resolved ProjectType's task types
    const allStatuses = await client.findAll(tracker.class.IssueStatus, {});
    if (!allStatuses.length) throw new Error('No statuses found for project');
    let defaultStatusId;
    if (resolvedProjectType.statuses?.length) {
      const ptStatusIds = new Set(resolvedProjectType.statuses.map(s => s.taskType ? s._id : s));
      const scopedStatuses = allStatuses.filter(s => ptStatusIds.has(s._id));
      const todoStatus = scopedStatuses.find(s => s.name === 'Todo') || scopedStatuses[0];
      defaultStatusId = todoStatus?._id || allStatuses.find(s => s.name === 'Todo')?._id || allStatuses[0]._id;
    } else {
      defaultStatusId = allStatuses.find(s => s.name === 'Todo')?._id || allStatuses[0]._id;
    }

    if (!this._accountUuid) {
      throw new Error('Cannot create project: authenticated account UUID is unavailable');
    }

    // Huly's project creation flow always makes the creator both a member and
    // an owner. Private spaces are invisible when owners is populated but
    // members is empty.
    const members = [this._accountUuid];
    const owners = [this._accountUuid];

    const projectId = generateId();
    let projectCreated = false;

    try {
      await client.createDoc(tracker.class.Project, core.space.Space, {
        identifier,
        name: name || identifier,
        description: description || '',
        private: isPrivate,
        members,
        owners,
        archived: false,
        autoJoin: !isPrivate,
        sequence: 0,
        defaultIssueStatus: defaultStatusId,
        defaultTimeReportDay: 0,
        type: resolvedProjectType._id
      }, projectId);
      projectCreated = true;

      // Project types may define a mixin for role assignments and custom
      // fields. Match Huly's canonical creation flow even when no roles have
      // been assigned yet.
      if (resolvedProjectType.targetClass) {
        await client.createMixin(
          projectId,
          tracker.class.Project,
          core.space.Space,
          resolvedProjectType.targetClass,
          {}
        );
      }

      // Never report success for a project the creating identity cannot read.
      const createdProject = await client.findOne(tracker.class.Project, { identifier });
      if (!createdProject || createdProject._id !== projectId) {
        throw new Error('project is not readable by the creating account');
      }
      if (!createdProject.members?.includes(this._accountUuid) ||
          !createdProject.owners?.includes(this._accountUuid)) {
        throw new Error('creator membership or ownership was not persisted');
      }
    } catch (error) {
      if (!projectCreated) throw error;

      let rollbackError;
      try {
        await client.removeDoc(tracker.class.Project, core.space.Space, projectId);
      } catch (cleanupError) {
        rollbackError = cleanupError;
      }

      const reason = error instanceof Error ? error.message : String(error);
      if (rollbackError) {
        const cleanupReason = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(
          `Project "${identifier}" creation failed after write (${reason}); ` +
          `automatic rollback failed (${cleanupReason}). Manual cleanup may be required for internal ID ${projectId}.`,
          { cause: error }
        );
      }

      throw new Error(
        `Project "${identifier}" creation failed after write (${reason}); partial project was rolled back.`,
        { cause: error }
      );
    }

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

    await client.removeCollection(tracker.class.Issue, project._id, issue._id, issue.attachedTo, issue.attachedToClass, issue.collection);

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
      if (statusValue === undefined) {
        throw new Error(`Milestone status not found: ${updates.status}`);
      }
      docUpdates.status = statusValue;
      updatedFields.push('status');
    }
    if (updates.targetDate !== undefined) {
      docUpdates.targetDate = normalizeDueDate(updates.targetDate);
      updatedFields.push('targetDate');
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

  async listComponents(projectIdent, options = {}) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const components = await client.findAll(tracker.class.Component, { space: project._id });

    const enriched = components.map(c => withExtra(c, {
      id: c._id,
      name: c.label,
      description: fromMarkup(c.description),
      lead: c.lead || null
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_components', project: projectIdent.toUpperCase() }
    });
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

  async listTimeReports(issueId, options = {}) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const reports = await client.findAll(tracker.class.TimeSpendReport, {
      attachedTo: issue._id
    }, { sort: { date: -1 } });

    const enriched = reports.map(r => withExtra(r, {
      id: r._id,
      hours: toHours(r.value),
      description: fromMarkup(r.description),
      date: toIsoDate(r.date)
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_time_reports', issueId: issueId.toUpperCase() }
    });
  }

  async deleteTimeReport(reportId) {
    const client = await this._getClient();

    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report) throw new Error(`Time report not found: ${reportId}`);

    // The transactor automatically decrements reportedTime on the issue
    // when a TimeSpendReport is removed via removeCollection — do NOT
    // manually update reportedTime here or it gets decremented twice.
    await client.removeCollection(tracker.class.TimeSpendReport, report.space, report._id, report.attachedTo, report.attachedToClass, report.collection);

    return {
      message: `Time report deleted`,
      id: reportId,
      hours: toHours(report.value)
    };
  }

  // ── Comment Management ──────────────────────────────────────

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

  // ── Single-Item Lookups ─────────────────────────────────────

  /**
   * Find a label by name.
   * @param {string} name - Label name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getLabel(name) {
    const client = await this._getClient();

    const tagElements = await client.findAll(tags.class.TagElement, {
      targetClass: tracker.class.Issue
    });

    const label = tagElements.find(t => nameMatch(t.title, name));
    if (!label) throw new Error(`Label not found: ${name}`);

    return withExtra(label, {
      id: label._id,
      name: label.title,
      color: label.color ?? null,
      description: fromMarkup(label.description)
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

  /**
   * Find a status by name within a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Status name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getStatus(projectIdent, name) {
    const result = await this.listStatuses(projectIdent);
    const status = result.items.find(s => nameMatch(s.name, name));
    if (!status) {
      const names = result.items.map(s => s.name).join(', ');
      throw new Error(`Status not found: "${name}". Available: ${names}`);
    }
    return status;
  }

  /**
   * Find a component by name in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Component name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getComponent(projectIdent, name) {
    const client = await this._getClient();
    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const components = await client.findAll(tracker.class.Component, { space: project._id });
    const component = components.find(c => nameMatch(c.label, name));
    if (!component) {
      const names = components.map(c => c.label).join(', ');
      throw new Error(`Component not found: "${name}". Available: ${names}`);
    }

    return withExtra(component, {
      id: component._id,
      name: component.label,
      description: fromMarkup(component.description),
      lead: component.lead || null
    });
  }

  /**
   * Find a task type by name in a project.
   * @param {string} projectIdent - Project identifier
   * @param {string} name - Task type name (fuzzy match)
   * @returns {Promise<Object>}
   */
  async getTaskType(projectIdent, name) {
    const client = await this._getClient();

    const project = await client.findOne(tracker.class.Project, {
      identifier: projectIdent.toUpperCase()
    });
    if (!project) throw new Error(`Project not found: ${projectIdent}`);

    const allTaskTypes = await client.findAll(task.class.TaskType, {});
    const projectTypes = await client.findAll(task.class.ProjectType, {});
    const projectType = projectTypes.find(pt => pt._id === project.type);

    let typesToSearch;
    if (projectType && projectType.tasks) {
      const taskTypeIds = new Set(projectType.tasks);
      typesToSearch = allTaskTypes.filter(tt => taskTypeIds.has(tt._id));
    } else {
      typesToSearch = allTaskTypes.filter(tt =>
        tt.ofClass === tracker.class.Issue ||
        tt.targetClass === tracker.class.Issue
      );
    }

    const found = typesToSearch.find(tt => nameMatch(tt.name, name));
    if (!found) {
      const names = typesToSearch.map(tt => tt.name || tt._id.split(':').pop()).join(', ');
      throw new Error(`Task type not found: "${name}". Available: ${names}`);
    }

    return withExtra(found, {
      id: found._id,
      name: found.name || found._id.split(':').pop(),
      kind: found.kind || null,
      ofClass: found.ofClass || null,
      allowedAsChildOf: found.allowedAsChildOf || [],
      statusCategories: found.statusCategories || [],
      statuses: found.statuses || []
    });
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

  /**
   * Get a specific time report by ID on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} reportId - Time report ID
   * @returns {Promise<Object>}
   */
  async getTimeReport(issueId, reportId) {
    const client = await this._getClient();
    await this._parseAndFindIssue(client, issueId);

    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report) throw new Error(`Time report not found: ${reportId}`);

    return withExtra(report, {
      id: report._id,
      hours: toHours(report.value),
      description: fromMarkup(report.description),
      date: toIsoDate(report.date)
    });
  }
}
