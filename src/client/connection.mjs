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
   * Establish a client connection to Huly. Transport is chosen via the HULY_TRANSPORT env var: 'ws' (default) or
   * 'rest'. Concurrent callers share one attempt. An attempt that `disconnect()` supersedes closes what it opened
   * and rejects instead of installing a connection nothing would track or close.
   * @returns {Promise<void>}
   * @throws {Error} When config or auth is missing, the connection fails, or it is closed while being opened
   */
  async connect() {
    if (this._client) return;
    if (!this._connectionPromise) {
      const attempt = this._openConnection().then(connection => {
        if (this._connectionPromise !== attempt) {
          connection.platformClient?.close().catch(() => {});
          throw new Error('Connection was closed while it was being opened');
        }
        this._client = connection.client;
        this._platformClient = connection.platformClient;
        this._accountUuid = connection.accountUuid;
        this._workspaceId = connection.workspaceId;
        this._wsToken = connection.wsToken;
        this._serverConfig = connection.serverConfig;
        this._collabClient = connection.collabClient;
      }).finally(() => {
        if (this._connectionPromise === attempt) this._connectionPromise = null;
      });
      this._connectionPromise = attempt;
    }
    await this._connectionPromise;
  }

  /**
   * Open a connection without touching this client's state; `connect()` decides whether to install it.
   * @returns {Promise<Object>} client, platformClient, accountUuid, workspaceId, wsToken, serverConfig, collabClient
   * @throws {Error} When config or auth is missing or the connection fails
   */
  async _openConnection() {
    if (!this.workspace) {
      throw new Error('Missing required config: workspace');
    }
    if (!this.token && (!this.email || !this.password)) {
      throw new Error('Missing required auth: set HULY_TOKEN or HULY_EMAIL + HULY_PASSWORD');
    }

    const transport = (process.env.HULY_TRANSPORT || 'ws').toLowerCase();
    let client;
    let platformClient = null;
    let accountUuid;
    let connectionWorkspaceId;
    let wsToken;
    const authOpts = this.token
      ? { token: this.token, workspace: this.workspace }
      : { email: this.email, password: this.password, workspace: this.workspace };

    ensureOutboundHeaders(this.url);
    const serverConfig = await loadConfig(this.url);
    registerOriginsFromServerConfig(serverConfig, this.url);

    if (transport === 'ws') {
      // Resolve and register the transactor endpoint before connectWs opens
      // the socket; the SDK resolves it internally too, but too late for us
      // to update the outbound header allowlist.
      const { workspaceId, token, endpoint } = await getWorkspaceToken(this.url, authOpts, serverConfig);
      registerOutboundOrigin(endpoint, this.url);

      // WebSocket transport — full SDK support including Space creation
      const socketFactory = createOutboundSocketFactory();
      const wsOpts = socketFactory ? { ...authOpts, socketFactory } : authOpts;
      platformClient = await connectWs(this.url, wsOpts);
      client = platformClient.client;
      try {
        accountUuid = (await platformClient.getAccount()).uuid;
      } catch (error) {
        platformClient.close().catch(() => {});
        throw error;
      }
      connectionWorkspaceId = workspaceId;
      wsToken = token;
    } else {
      // REST transport — lightweight, no WebSocket dependency
      const { endpoint, token, workspaceId } = await getWorkspaceToken(this.url, authOpts, serverConfig);
      registerOutboundOrigin(endpoint, this.url);
      connectionWorkspaceId = workspaceId;
      wsToken = token;

      // Extract authenticated account UUID from JWT for ownership
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      accountUuid = payload.account;
      if (!accountUuid) {
        throw new Error('Workspace token missing account field');
      }

      client = await createRestTxOperations(endpoint, workspaceId, token);
    }

    // Initialize collaborator client for rich text (issue descriptions)
    const collabUrl = (serverConfig.COLLABORATOR_URL || '')
      .replace('wss://', 'https://').replace('ws://', 'http://');
    const collabClient = collabUrl ? getCollaboratorClient(connectionWorkspaceId, wsToken, collabUrl) : null;

    return {
      client, platformClient, accountUuid, workspaceId: connectionWorkspaceId, wsToken, serverConfig, collabClient
    };
  }

  disconnect() {
    if (this._platformClient) {
      this._platformClient.close().catch(() => {});
      this._platformClient = null;
    }
    this._client = null;
    this._connectionPromise = null;
    this._accountUuid = null;
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
   * Execute an operation and recover from a lost connection. The dead connection is always dropped so the
   * next call reconnects. Only a repeatable operation (one that changes nothing, such as a read) is retried,
   * up to twice: a write whose reply was lost may already be stored, so running it again could apply it twice.
   * @param {Function} operation - Async function to execute
   * @param {Object} [options]
   * @param {boolean} [options.repeatable=false] - Whether the operation is safe to run again
   * @returns {Promise<*>} The operation's result
   * @throws {Error} The operation's error; for a non-repeatable operation that lost its connection, an error
   *   saying the outcome is unknown
   */
  async withReconnect(operation, { repeatable = false } = {}) {
    const maxRetries = repeatable ? 2 : 0;
    for (let attempt = 0; ; attempt++) {
      try {
        return await operation();
      } catch (error) {
        const isConnectionError = error.message?.includes('ConnectionClosed') ||
            error.message?.includes('connection') ||
            error.message?.includes('ECONNREFUSED') ||
            error.message?.includes('socket') ||
            error.code === 'ECONNRESET';
        if (!isConnectionError) throw error;
        this.disconnect();
        if (!repeatable) {
          throw new Error(
            `Connection lost before Huly confirmed this change, so it may or may not have been applied. ` +
            `Check the current state before retrying. (${error.message})`,
            { cause: error }
          );
        }
        if (attempt >= maxRetries) throw error;
        console.error(`Connection lost, attempting reconnect (${attempt + 1}/${maxRetries})...`);
      }
    }
  }
}
