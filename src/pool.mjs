/**
 * ConnectionPool - Caches HulyClient instances by workspace slug.
 *
 * Supports multiple simultaneous workspace connections, all using the credentials from
 * config.mjs. The default workspace is the HULY_WORKSPACE value captured when config.mjs
 * loaded (not the live env). Connections idle longer than POOL_TTL_MS (HULY_POOL_TTL_MS)
 * are evicted on next use or by a periodic sweep.
 */

import { HulyClient } from './client.mjs';
import {
  HULY_URL, HULY_TOKEN, HULY_EMAIL, HULY_PASSWORD, HULY_WORKSPACE,
  POOL_TTL_MS, POOL_CLEANUP_INTERVAL_MS
} from './config.mjs';

export class ConnectionPool {
  /**
   * Create an empty pool and start the stale-connection sweep (an unref'd interval timer).
   */
  constructor() {
    /** @type {Map<string, { client: HulyClient|null, lastUsed: number, connecting: Promise<HulyClient>|null }>} */
    this._entries = new Map();

    // Periodic cleanup of stale connections
    this._cleanupTimer = setInterval(() => this._evictStale(), POOL_CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Get a HulyClient for the given workspace, creating and connecting if needed.
   * Concurrent calls for the same workspace share a single in-flight connection.
   *
   * @param {string} [workspace] - Workspace slug (optional, uses default if omitted)
   * @returns {Promise<HulyClient>}
   * @throws {Error} When no workspace is given or configured, the connection fails, or the
   *   workspace is cleared while the connection is being established
   */
  async getClient(workspace) {
    const ws = workspace || HULY_WORKSPACE;

    if (!ws) {
      throw new Error('No workspace specified and HULY_WORKSPACE env var is not set');
    }

    const entry = this._entries.get(ws);
    if (entry) {
      // Check if stale
      if (entry.client && Date.now() - entry.lastUsed > POOL_TTL_MS) {
        console.warn(`[pool] Evicting stale connection for workspace: ${ws}`);
        entry.client.disconnect();
        this._entries.delete(ws);
      } else if (entry.connecting) {
        // Another caller is already connecting — await their promise
        return entry.connecting;
      } else if (entry.client) {
        entry.lastUsed = Date.now();
        return entry.client;
      }
    }

    // Create connection and store promise so concurrent callers share it
    const connectPromise = (async () => {
      const client = new HulyClient({
        url: HULY_URL,
        token: HULY_TOKEN,
        email: HULY_EMAIL,
        password: HULY_PASSWORD,
        workspace: ws
      });
      await client.connect();
      // If clearClient/clearAll ran during this connect, the slot no longer
      // holds this promise. Writing it back would cache a connection the caller
      // asked to close and, since clearAll also stops the sweep timer, leak it
      // for the process lifetime. Only claim the slot if it is still ours.
      if (this._entries.get(ws)?.connecting !== connectPromise) {
        client.disconnect();
        // Returning the client here would hand the caller a disconnected
        // instance that fails on first use. The pool was cleared out from
        // under this connect, so the honest answer is to say so.
        throw new Error(
          `Connection for workspace "${ws}" was closed while it was being established; retry the request.`
        );
      }
      this._entries.set(ws, { client, lastUsed: Date.now(), connecting: null });
      return client;
    })();

    this._entries.set(ws, { client: null, lastUsed: Date.now(), connecting: connectPromise });

    try {
      return await connectPromise;
    } catch (err) {
      this._entries.delete(ws);
      throw err;
    }
  }

  /**
   * Force-disconnect and remove a cached client for the given workspace. An in-flight
   * connection for it is discarded when it completes.
   *
   * @param {string} [workspace] - Workspace slug (optional, uses default if omitted)
   */
  clearClient(workspace) {
    const ws = workspace || HULY_WORKSPACE;
    if (!ws) return;

    const entry = this._entries.get(ws);
    if (entry?.client) {
      entry.client.disconnect();
    }
    this._entries.delete(ws);
  }

  /**
   * Disconnect all cached clients and stop the stale-connection sweep. In-flight connections
   * are discarded when they complete.
   */
  clearAll() {
    clearInterval(this._cleanupTimer);
    for (const [, entry] of this._entries) {
      if (entry.client) entry.client.disconnect();
    }
    this._entries.clear();
  }

  /**
   * Evict connections that haven't been used within the TTL window.
   */
  _evictStale() {
    const now = Date.now();
    for (const [ws, entry] of this._entries) {
      if (entry.client && now - entry.lastUsed > POOL_TTL_MS) {
        console.warn(`[pool] Evicting stale connection for workspace: ${ws}`);
        entry.client.disconnect();
        this._entries.delete(ws);
      }
    }
  }
}

/** Singleton pool instance shared across MCP and HTTP entry points. */
export const pool = new ConnectionPool();
