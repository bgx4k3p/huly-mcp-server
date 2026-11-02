/**
 * Settings for the Streamable HTTP server, read from the environment and validated once at startup so a bad
 * value stops the server with a clear message instead of failing requests later.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Parse an integer setting within a range.
 * @param {Object} env - Environment
 * @param {string} name - Variable name
 * @param {number} fallback - Value when unset
 * @param {number} min - Smallest allowed value
 * @param {number} [max] - Largest allowed value
 * @returns {number}
 * @throws {Error} When the value is not an integer in range
 */
function integerSetting(env, name, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer from ${min} to ${max}, received "${raw}"`);
  }
  return value;
}

/**
 * Parse the MCP access tokens: `MCP_AUTH_TOKENS` as `name:token` pairs separated by commas, and the single
 * `MCP_AUTH_TOKEN`, which is named "default".
 * @param {Object} env - Environment
 * @returns {Array<{name: string, token: string}>}
 * @throws {Error} When an entry is malformed or a name repeats
 */
function parseTokens(env) {
  const tokens = [];
  for (const entry of (env.MCP_AUTH_TOKENS || '').split(',').map(part => part.trim()).filter(Boolean)) {
    const separator = entry.indexOf(':');
    const name = separator > 0 ? entry.slice(0, separator).trim() : '';
    const token = separator > 0 ? entry.slice(separator + 1).trim() : '';
    if (!/^[A-Za-z0-9_.-]+$/.test(name) || !token) {
      throw new Error('MCP_AUTH_TOKENS entries must look like name:token, with a name of letters, digits, _ . -');
    }
    tokens.push({ name, token });
  }
  if (env.MCP_AUTH_TOKEN) tokens.push({ name: 'default', token: env.MCP_AUTH_TOKEN });
  const names = tokens.map(entry => entry.name);
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated) throw new Error(`MCP access token name "${repeated}" is defined more than once`);
  return tokens;
}

/**
 * Build the validated HTTP server configuration.
 * @param {Object} [env=process.env] - Environment to read
 * @returns {Object} host, port, tokens, allowedOrigins ('*' or a Set), rateLimit, rateWindowMs, maxBodyBytes,
 *   trustProxy, sessionIdleMs, maxSessions
 * @throws {Error} When a setting is invalid, or the server would listen beyond loopback without a token
 */
export function loadHttpConfig(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const tokens = parseTokens(env);
  if (tokens.length === 0 && !LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `Refusing to listen on ${host} without authentication: set MCP_AUTH_TOKENS (or MCP_AUTH_TOKEN), ` +
      'or bind to 127.0.0.1.'
    );
  }

  const originSetting = (env.ALLOWED_ORIGINS || '').trim();
  const allowedOrigins = originSetting === '*'
    ? '*'
    : new Set(originSetting.split(',').map(origin => origin.trim()).filter(Boolean));

  const trustProxy = (env.HULY_TRUST_PROXY || '').trim().toLowerCase();
  if (trustProxy && !['true', '1', 'false', '0'].includes(trustProxy)) {
    throw new Error(`HULY_TRUST_PROXY must be true or false, received "${env.HULY_TRUST_PROXY}"`);
  }

  return {
    host,
    port: integerSetting(env, 'PORT', 3001, 0, 65535),
    tokens,
    allowedOrigins,
    rateLimit: integerSetting(env, 'HULY_RATE_LIMIT', 200, 1),
    rateWindowMs: 60000,
    maxBodyBytes: 1048576,
    trustProxy: trustProxy === 'true' || trustProxy === '1',
    sessionIdleMs: integerSetting(env, 'HULY_SESSION_IDLE_MS', 1800000, 1000),
    maxSessions: integerSetting(env, 'HULY_MAX_SESSIONS', 100, 1)
  };
}
