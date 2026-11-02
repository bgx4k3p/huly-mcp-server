/**
 * Workspace connection lifecycle: connect, disconnect, lazy client access and reconnect handling.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import {
  createOutboundSocketFactory,
  ensureOutboundHeaders,
  registerOriginsFromServerConfig,
  registerOutboundOrigin
} from '../outboundHeaders.mjs';
import {
  connectWs,
  createRestTxOperations,
  getCollaboratorClient,
  getWorkspaceToken,
  loadConfig
} from './sdk.mjs';

export class ConnectionMethods {
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
}
