/**
 * ConnectionPool - Caches HulyClient instances by workspace slug.
 *
 * Supports multiple simultaneous workspace connections.
 * Default workspace comes from HULY_WORKSPACE env var.
 * Evicts stale connections after a configurable TTL.
 */

import { HulyClient } from './client.mjs';

const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
const HULY_TOKEN = process.env.HULY_TOKEN;
const HULY_EMAIL = process.env.HULY_EMAIL;
const HULY_PASSWORD = process.env.HULY_PASSWORD;
const HULY_WORKSPACE = process.env.HULY_WORKSPACE;
const POOL_TTL_MS = parseInt(process.env.HULY_POOL_TTL_MS || '1800000', 10); // 30 min default
const CLEANUP_INTERVAL_MS = 300000; // 5 min

class ConnectionPool {
  constructor() {
    /** @type {Map<string, { client: HulyClient, lastUsed: number }>} */
    this._entries = new Map();

    // Periodic cleanup of stale connections
    this._cleanupTimer = setInterval(() => this._evictStale(), CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /**
   * Get a HulyClient for the given workspace, creating and connecting if needed.
   * Falls back to HULY_WORKSPACE env var when no workspace is specified.
   *
   * @param {string} [workspace] - Workspace slug (optional, uses default if omitted)
   * @returns {Promise<HulyClient>}
   */
  async getClient(workspace) {
    const ws = workspace || HULY_WORKSPACE;

    if (!ws) {
      throw new Error('No workspace specified and HULY_WORKSPACE env var is not set');
    }

    const entry = this._entries.get(ws);
    if (entry) {
      // Check if stale
      if (Date.now() - entry.lastUsed > POOL_TTL_MS) {
        console.warn(`[pool] Evicting stale connection for workspace: ${ws}`);
        entry.client.disconnect();
        this._entries.delete(ws);
      } else {
        entry.lastUsed = Date.now();
        return entry.client;
      }
    }

    const client = new HulyClient({
      url: HULY_URL,
      token: HULY_TOKEN,
      email: HULY_EMAIL,
      password: HULY_PASSWORD,
      workspace: ws
    });

    await client.connect();
    this._entries.set(ws, { client, lastUsed: Date.now() });
    return client;
  }

  /**
   * Force-disconnect and remove a cached client for the given workspace.
   *
   * @param {string} [workspace] - Workspace slug (optional, uses default if omitted)
   */
  clearClient(workspace) {
    const ws = workspace || HULY_WORKSPACE;
    if (!ws) return;

    const entry = this._entries.get(ws);
    if (entry) {
      entry.client.disconnect();
      this._entries.delete(ws);
    }
  }

  /**
   * Disconnect all cached clients.
   */
  clearAll() {
    for (const [, entry] of this._entries) {
      entry.client.disconnect();
    }
    this._entries.clear();
  }

  /**
   * Evict connections that haven't been used within the TTL window.
   */
  _evictStale() {
    const now = Date.now();
    for (const [ws, entry] of this._entries) {
      if (now - entry.lastUsed > POOL_TTL_MS) {
        console.warn(`[pool] Evicting stale connection for workspace: ${ws}`);
        entry.client.disconnect();
        this._entries.delete(ws);
      }
    }
  }
}

/** Singleton pool instance shared across MCP and HTTP entry points. */
export const pool = new ConnectionPool();
