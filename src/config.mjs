/**
 * Shared configuration — single source of truth for all env vars and defaults.
 */

// ── Huly Connection ──────────────────────────────────────────
export const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
export const HULY_TOKEN = process.env.HULY_TOKEN;
export const HULY_EMAIL = process.env.HULY_EMAIL;
export const HULY_PASSWORD = process.env.HULY_PASSWORD;
export const HULY_WORKSPACE = process.env.HULY_WORKSPACE;
export const HULY_CREDS = HULY_TOKEN
  ? { token: HULY_TOKEN }
  : { email: HULY_EMAIL, password: HULY_PASSWORD };

// ── Pool ─────────────────────────────────────────────────────
export const POOL_TTL_MS = parseInt(process.env.HULY_POOL_TTL_MS || '1800000', 10);
export const POOL_CLEANUP_INTERVAL_MS = 300000; // 5 min

// ── HTTP Server ──────────────────────────────────────────────
export const PORT = parseInt(process.env.PORT || '3001', 10);
export const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || null;
export const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS || '*';
export const RATE_LIMIT = parseInt(process.env.HULY_RATE_LIMIT || '200', 10);
export const RATE_WINDOW_MS = 60000;
export const MAX_BODY_SIZE = 1048576; // 1MB
