/**
 * Shared configuration — single source of truth for all env vars and defaults.
 */

// ── Huly Connection ──────────────────────────────────────────
export const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
export const HULY_TOKEN = process.env.HULY_TOKEN;
export const HULY_EMAIL = process.env.HULY_EMAIL;
export const HULY_PASSWORD = process.env.HULY_PASSWORD;
export const HULY_WORKSPACE = process.env.HULY_WORKSPACE;
export const HULY_PROJECT = process.env.HULY_PROJECT;

/**
 * The default workspace, resolved the same way everywhere. Tool dispatch reads
 * the live env so an embedding host can repoint the server after module load;
 * get_huly_context must answer with the same value it would actually use, or it
 * reports a workspace nothing is reading from.
 * @returns {string|null}
 */
export function resolveDefaultWorkspace() {
  return process.env.HULY_WORKSPACE || HULY_WORKSPACE || null;
}
export const HULY_CREDS = HULY_TOKEN
  ? { token: HULY_TOKEN }
  : { email: HULY_EMAIL, password: HULY_PASSWORD };

// ── Pool ─────────────────────────────────────────────────────
const DEFAULT_POOL_TTL_MS = 1800000;
const parsedPoolTtl = parseInt(process.env.HULY_POOL_TTL_MS || String(DEFAULT_POOL_TTL_MS), 10);
export const POOL_TTL_MS = Number.isFinite(parsedPoolTtl) && parsedPoolTtl > 0
  ? parsedPoolTtl
  : DEFAULT_POOL_TTL_MS;
export const POOL_CLEANUP_INTERVAL_MS = 300000; // 5 min

// ── HTTP Server ──────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3001', 10);
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';
export const RATE_LIMIT = parseInt(process.env.HULY_RATE_LIMIT || '200', 10);
export const RATE_WINDOW_MS = 60000;
export const MAX_BODY_SIZE = 1048576; // 1MB
