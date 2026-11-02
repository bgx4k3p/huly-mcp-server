/**
 * Implements the --init-codex, --init-claude and --init-all CLI commands, which write a
 * project-scoped Huly MCP server entry to .codex/config.toml and/or .mcp.json. The project
 * directory is the nearest ancestor containing .mcp.json, or the working directory. Credentials
 * are written as environment references, never as literal secrets.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

const DEFAULT_SERVER_NAME = 'huly';

/**
 * Build the usage text for one init command.
 * @param {string} [command='all'] - 'codex', 'claude' or 'all'; unknown values use 'all'
 * @returns {string}
 */
function usage(command = 'all') {
  const commands = {
    codex: 'huly-mcp-server --init-codex [--url <url>|--url-env <var>] [--workspace <slug>|--workspace-env <var>] [--project <id>|--project-env <var>] [--server-name <name>] [--force]',
    claude: 'huly-mcp-server --init-claude [--url <url>|--url-env <var>] [--workspace <slug>|--workspace-env <var>] [--project <id>|--project-env <var>] [--server-name <name>] [--force]',
    all: 'huly-mcp-server --init-all [--url <url>|--url-env <var>] [--workspace <slug>|--workspace-env <var>] [--project <id>|--project-env <var>] [--server-name <name>] [--force]'
  };
  return [
    `Usage: ${commands[command] || commands.all}`,
    '',
    'Secrets are referenced from the user environment by default.',
    'Use --url/--workspace/--project to write literal routing values.',
    'Use --url-env/--workspace-env/--project-env to reference routing values from environment variables.',
    'HULY_PROJECT is optional and written only when --project, --project-env, or an existing config provides it.'
  ].join('\n');
}

/**
 * Return the argument following the first of the given flags that is present.
 * @param {string[]} args - CLI arguments
 * @param {string[]} names - Flag aliases, checked in order
 * @returns {string|undefined}
 */
export function flagValue(args, names) {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

/**
 * Report whether any of the given flags is present.
 * @param {string[]} args - CLI arguments
 * @param {string[]} names - Flag aliases
 * @returns {boolean}
 */
function hasFlag(args, names) {
  return names.some(name => args.includes(name));
}

/**
 * Find a file in a directory or its nearest ancestor.
 * @param {string} filename - File name to look for
 * @param {string} [startDir=process.cwd()] - Directory to start from
 * @returns {string|null} Absolute path, or null when not found up to the filesystem root
 */
function findUp(filename, startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, filename);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir || parse(dir).root === dir) return null;
    dir = parent;
  }
}

/**
 * Report whether a value is an environment reference of the form ${NAME} (A-Z, 0-9, _).
 * @param {*} value
 * @returns {boolean}
 */
function isEnvReference(value) {
  return typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value);
}

/**
 * Read the Huly server entry from a .mcp.json file, falling back to the default "huly" entry.
 * @param {string} mcpPath - Path to .mcp.json
 * @param {string} serverName - Server entry name
 * @returns {Object|null}
 * @throws {Error} When the file cannot be read or is not valid JSON
 */
function readHulyMcpConfig(mcpPath, serverName) {
  const raw = readFileSync(mcpPath, 'utf8');
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};
  return servers[serverName] || servers[DEFAULT_SERVER_NAME] || null;
}

/**
 * Read and parse a .mcp.json file, or return an empty config when it does not exist.
 * @param {string} mcpPath - Path to .mcp.json
 * @returns {Object}
 * @throws {Error} When the file exists but is not valid JSON
 */
function readMcpJson(mcpPath) {
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  const raw = readFileSync(mcpPath, 'utf8');
  return JSON.parse(raw);
}

/**
 * Return the variable name inside a ${NAME} reference.
 * @param {*} value
 * @returns {string|null} Name, or null when the value is not a reference
 */
function envRefName(value) {
  return isEnvReference(value) ? value.slice(2, -1) : null;
}

/**
 * Normalize an env-var flag value given as either NAME or ${NAME}.
 * @param {string|undefined} value
 * @returns {string|null} Bare variable name, or null when empty
 */
function normalizeEnvName(value) {
  if (!value) return null;
  return envRefName(value) || value;
}

/**
 * Resolve one routing setting. Precedence: literal flag, env-var flag, the existing .mcp.json
 * value (reference or literal), then defaultEnvName.
 * @param {Object|null} hulyConfig - Existing Huly server entry from .mcp.json
 * @param {string} key - Env key in the server entry, e.g. 'HULY_WORKSPACE'
 * @param {string} [literalValue] - Value from the literal flag
 * @param {string} [envValue] - Variable name from the env-var flag
 * @param {string|null} [defaultEnvName=null] - Variable referenced when nothing else applies
 * @returns {{kind: 'literal', value: string}|{kind: 'env', name: string}|null}
 */
function resolveRoutingValue(hulyConfig, key, literalValue, envValue, defaultEnvName = null) {
  if (literalValue) return { kind: 'literal', value: literalValue };

  const explicitEnv = normalizeEnvName(envValue);
  if (explicitEnv) return { kind: 'env', name: explicitEnv };

  const existing = hulyConfig?.env?.[key];
  const existingEnv = envRefName(existing);
  if (existingEnv) return { kind: 'env', name: existingEnv };
  if (typeof existing === 'string' && existing.length > 0) {
    return { kind: 'literal', value: existing };
  }

  if (defaultEnvName) return { kind: 'env', name: defaultEnvName };

  return null;
}

/**
 * Resolve the URL, workspace and project routing for a project. The URL defaults to a
 * ${HULY_URL} reference; the project is optional.
 * @param {string[]} args - CLI arguments
 * @param {string} projectDir - Project directory
 * @param {string} serverName - Server entry name
 * @returns {{hulyConfig: Object|null, routing: {url: Object, workspace: Object, project: Object|null}}}
 * @throws {Error} When no workspace can be determined
 */
function resolveRouting(args, projectDir, serverName) {
  const hulyConfig = existingHulyConfig(projectDir, serverName);
  const url = resolveRoutingValue(
    hulyConfig,
    'HULY_URL',
    flagValue(args, ['--url', '-u']),
    flagValue(args, ['--url-env']),
    'HULY_URL'
  );
  const workspace = resolveRoutingValue(
    hulyConfig,
    'HULY_WORKSPACE',
    flagValue(args, ['--workspace', '-w']),
    flagValue(args, ['--workspace-env'])
  );
  const project = resolveRoutingValue(
    hulyConfig,
    'HULY_PROJECT',
    flagValue(args, ['--project', '-p']),
    flagValue(args, ['--project-env'])
  );

  if (!workspace) {
    throw new Error('Could not determine HULY_WORKSPACE. Re-run with --workspace <slug> or --workspace-env <env-var>.');
  }

  return { hulyConfig, routing: { url, workspace, project } };
}

/**
 * List the credential variable names the generated config should pass through.
 * @param {Object|null} hulyConfig - Existing Huly server entry
 * @returns {string[]}
 */
function inferCredentialEnvVars(hulyConfig) {
  return credentialRefs(hulyConfig).map(({ ref }) => ref);
}

/**
 * Collect HULY_TOKEN, HULY_EMAIL and HULY_PASSWORD entries that are ${NAME} references in the
 * existing config; literal values are ignored. Defaults to a HULY_TOKEN reference.
 * @param {Object|null} hulyConfig - Existing Huly server entry
 * @returns {Array<{key: string, ref: string}>}
 */
function credentialRefs(hulyConfig) {
  const env = hulyConfig?.env || {};
  const refs = [];

  for (const key of ['HULY_TOKEN', 'HULY_EMAIL', 'HULY_PASSWORD']) {
    const value = env[key];
    if (isEnvReference(value)) {
      refs.push({ key, ref: value.slice(2, -1) });
    }
  }

  return refs.length > 0 ? refs : [{ key: 'HULY_TOKEN', ref: 'HULY_TOKEN' }];
}

/**
 * Drop falsy values and duplicates, preserving order.
 * @param {Array} values
 * @returns {Array}
 */
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Quote a string for TOML using JSON escaping.
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(value);
}

/**
 * Return the value of a literal routing setting.
 * @param {Object|null} routingValue
 * @returns {string|null} Value, or null for env references and missing settings
 */
function routingLiteral(routingValue) {
  return routingValue?.kind === 'literal' ? routingValue.value : null;
}

/**
 * Return the variable name of an env-reference routing setting.
 * @param {Object|null} routingValue
 * @returns {string|null} Name, or null for literals and missing settings
 */
function routingEnvName(routingValue) {
  return routingValue?.kind === 'env' ? routingValue.name : null;
}

/**
 * Render the Codex TOML block for the server. Env references go in env_vars (passed through
 * from the user environment); literal routing values go in an [mcp_servers.<name>.env] table.
 * @param {Object} options
 * @param {string} options.serverName - Server entry name
 * @param {string[]} options.credentialEnvVars - Credential variable names
 * @param {Object} options.routing - Resolved routing from resolveRouting
 * @returns {string} TOML text ending in a newline
 */
function renderCodexConfig({ serverName, credentialEnvVars, routing }) {
  const args = ['-y', '@bgx4k3p/huly-mcp-server'];
  const envVars = unique([
    ...credentialEnvVars,
    routingEnvName(routing.url),
    routingEnvName(routing.workspace),
    routingEnvName(routing.project)
  ]);
  const envLines = [
    ['HULY_URL', routingLiteral(routing.url)],
    ['HULY_WORKSPACE', routingLiteral(routing.workspace)],
    ['HULY_PROJECT', routingLiteral(routing.project)]
  ]
    .filter(([, value]) => value)
    .map(([key, value]) => `${key} = ${tomlString(value)}`);
  const lines = [
    `[mcp_servers.${serverName}]`,
    'command = "npx"',
    `args = [${args.map(tomlString).join(', ')}]`,
    `env_vars = [${envVars.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120'
  ];

  if (envLines.length > 0) {
    lines.push('', `[mcp_servers.${serverName}.env]`, ...envLines);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Return the table name of a TOML table header line.
 * @param {string} line
 * @returns {string|null} Name, or null when the line is not a [table] header
 */
function codexHeaderName(line) {
  const match = line.trim().match(/^\[([^\]]+)\]$/);
  return match?.[1] || null;
}

/**
 * Report whether a TOML table name belongs to the server (mcp_servers.<name> or a subtable).
 * @param {string} header - Table name
 * @param {string} serverName - Server entry name
 * @returns {boolean}
 */
function isCodexServerHeader(header, serverName) {
  const prefix = `mcp_servers.${serverName}`;
  return header === prefix || header.startsWith(`${prefix}.`);
}

/**
 * Report whether TOML content already defines the server.
 * @param {string} content - TOML text
 * @param {string} serverName - Server entry name
 * @returns {boolean}
 */
function hasCodexServerConfig(content, serverName) {
  return content
    .split(/\r?\n/)
    .some(line => {
      const header = codexHeaderName(line);
      return header && isCodexServerHeader(header, serverName);
    });
}

/**
 * Remove the server's tables from TOML content.
 * @param {string} content - TOML text
 * @param {string} serverName - Server entry name
 * @returns {string} Remaining text, trailing whitespace trimmed
 */
function removeCodexServerConfig(content, serverName) {
  const lines = content.split(/\r?\n/);
  const kept = [];
  let skipping = false;

  for (const line of lines) {
    const header = codexHeaderName(line);
    if (header) {
      skipping = isCodexServerHeader(header, serverName);
    }

    if (!skipping) kept.push(line);
  }

  return kept.join('\n').trimEnd();
}

/**
 * Append the server block to existing TOML content, replacing any earlier block when forced.
 * @param {string} existing - Current config.toml text
 * @param {string} serverName - Server entry name
 * @param {string} serverConfig - Rendered server block
 * @param {boolean} force - Replace an existing server block
 * @returns {string}
 * @throws {Error} When the server is already configured and force is false
 */
function mergeCodexConfig(existing, serverName, serverConfig, force) {
  if (!existing.trim()) return serverConfig;

  const hasServer = hasCodexServerConfig(existing, serverName);
  if (hasServer && !force) {
    throw new Error(`.codex/config.toml already has mcp_servers.${serverName}. Re-run with --force to replace it.`);
  }

  const base = hasServer ? removeCodexServerConfig(existing, serverName) : existing.trimEnd();
  return `${base}\n\n${serverConfig}`;
}

/**
 * Format a routing setting for a .mcp.json env entry.
 * @param {Object|null} routingValue
 * @returns {string|undefined} ${NAME} for env references, the literal value, or undefined when missing
 */
function claudeRoutingValue(routingValue) {
  if (!routingValue) return undefined;
  return routingValue.kind === 'env' ? `\${${routingValue.name}}` : routingValue.value;
}

/**
 * Format a routing setting for user-facing messages.
 * @param {Object|null} routingValue
 * @returns {string|undefined}
 */
function routingDisplayValue(routingValue) {
  return claudeRoutingValue(routingValue);
}

/**
 * Build the .mcp.json server entry. HULY_PROJECT is included only when resolved.
 * @param {Object} options
 * @param {Array<{key: string, ref: string}>} options.credentials - Credential references
 * @param {Object} options.routing - Resolved routing from resolveRouting
 * @returns {{type: string, command: string, args: string[], env: Object}}
 */
function renderClaudeServer({ credentials, routing }) {
  const env = {
    HULY_URL: claudeRoutingValue(routing.url),
    HULY_WORKSPACE: claudeRoutingValue(routing.workspace)
  };

  for (const { key, ref } of credentials) {
    env[key] = `\${${ref}}`;
  }

  const project = claudeRoutingValue(routing.project);
  if (project) {
    env.HULY_PROJECT = project;
  }

  return {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@bgx4k3p/huly-mcp-server'],
    env
  };
}

/**
 * Return the directory of the nearest .mcp.json, or the resolved cwd when there is none.
 * @param {string} cwd
 * @returns {string}
 */
function projectDirFromCwd(cwd) {
  const mcpPath = findUp('.mcp.json', cwd);
  return mcpPath ? dirname(mcpPath) : resolve(cwd);
}

/**
 * Read the existing Huly server entry from the project's .mcp.json.
 * @param {string} projectDir - Project directory
 * @param {string} serverName - Server entry name
 * @returns {Object|null} Entry, or null when the file or entry is absent
 */
function existingHulyConfig(projectDir, serverName) {
  const mcpPath = join(projectDir, '.mcp.json');
  return existsSync(mcpPath) ? readHulyMcpConfig(mcpPath, serverName) : null;
}

/**
 * Write the server entry to <project>/.codex/config.toml, creating the directory if needed.
 * With --help or -h, returns usage text without writing.
 * @param {string[]} [args=process.argv.slice(2)] - CLI arguments
 * @param {string} [cwd=process.cwd()] - Directory to start the .mcp.json search from
 * @returns {{ok: true, path?: string, message: string}}
 * @throws {Error} When no workspace can be determined, or the entry exists and --force is absent
 */
export function initCodexConfig(args = process.argv.slice(2), cwd = process.cwd()) {
  if (hasFlag(args, ['--help', '-h'])) {
    return { ok: true, message: usage('codex') };
  }

  const serverName = flagValue(args, ['--server-name']) || DEFAULT_SERVER_NAME;
  const force = hasFlag(args, ['--force']);
  const projectDir = projectDirFromCwd(cwd);
  const { hulyConfig, routing } = resolveRouting(args, projectDir, serverName);

  const codexDir = join(projectDir, '.codex');
  const configPath = join(codexDir, 'config.toml');

  mkdirSync(codexDir, { recursive: true });
  const serverConfig = renderCodexConfig({
    serverName,
    credentialEnvVars: inferCredentialEnvVars(hulyConfig),
    routing
  });
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const content = mergeCodexConfig(existing, serverName, serverConfig, force);
  writeFileSync(configPath, content, 'utf8');

  return {
    ok: true,
    path: configPath,
    message: `Wrote ${configPath} for Huly workspace "${routingDisplayValue(routing.workspace)}".`
  };
}

/**
 * Write the server entry to <project>/.mcp.json, keeping other entries. An existing identical
 * entry is rewritten without --force. With --help or -h, returns usage text without writing.
 * @param {string[]} [args=process.argv.slice(2)] - CLI arguments
 * @param {string} [cwd=process.cwd()] - Directory to start the .mcp.json search from
 * @returns {{ok: true, path?: string, message: string}}
 * @throws {Error} When no workspace can be determined, or a different entry exists and --force is absent
 */
export function initClaudeConfig(args = process.argv.slice(2), cwd = process.cwd()) {
  if (hasFlag(args, ['--help', '-h'])) {
    return { ok: true, message: usage('claude') };
  }

  const serverName = flagValue(args, ['--server-name']) || DEFAULT_SERVER_NAME;
  const force = hasFlag(args, ['--force']);
  const projectDir = projectDirFromCwd(cwd);
  const mcpPath = join(projectDir, '.mcp.json');
  const parsed = readMcpJson(mcpPath);
  parsed.mcpServers ||= {};

  const existing = parsed.mcpServers[serverName];
  const { hulyConfig, routing } = resolveRouting(args, projectDir, serverName);
  const nextServer = renderClaudeServer({ credentials: credentialRefs(hulyConfig), routing });

  if (existing && !force && JSON.stringify(existing) !== JSON.stringify(nextServer)) {
    throw new Error(`${mcpPath} already has mcpServers.${serverName}. Re-run with --force to replace it.`);
  }

  parsed.mcpServers[serverName] = nextServer;
  writeFileSync(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    path: mcpPath,
    message: `Wrote ${mcpPath} for Huly workspace "${routingDisplayValue(routing.workspace)}".`
  };
}

/**
 * Write both .mcp.json and .codex/config.toml (in that order). With --help or -h, returns
 * usage text without writing.
 * @param {string[]} [args=process.argv.slice(2)] - CLI arguments
 * @param {string} [cwd=process.cwd()] - Directory to start the .mcp.json search from
 * @returns {{ok: true, paths?: string[], message: string}}
 * @throws {Error} When either write fails; .mcp.json may already be written if the Codex step fails
 */
export function initAllConfigs(args = process.argv.slice(2), cwd = process.cwd()) {
  if (hasFlag(args, ['--help', '-h'])) {
    return { ok: true, message: usage('all') };
  }

  const claude = initClaudeConfig(args, cwd);
  const codex = initCodexConfig(args, cwd);

  return {
    ok: true,
    paths: [claude.path, codex.path],
    message: [claude.message, codex.message].join('\n')
  };
}
