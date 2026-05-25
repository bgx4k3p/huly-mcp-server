/**
 * Helpers for generating project-scoped MCP configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

const DEFAULT_SERVER_NAME = 'huly';

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

function flagValue(args, names) {
  for (const name of names) {
    const i = args.indexOf(name);
    if (i !== -1 && i + 1 < args.length) return args[i + 1];
  }
  return undefined;
}

function hasFlag(args, names) {
  return names.some(name => args.includes(name));
}

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

function isEnvReference(value) {
  return typeof value === 'string' && /^\$\{[A-Z0-9_]+\}$/.test(value);
}

function readHulyMcpConfig(mcpPath, serverName) {
  const raw = readFileSync(mcpPath, 'utf8');
  const parsed = JSON.parse(raw);
  const servers = parsed.mcpServers || {};
  return servers[serverName] || servers[DEFAULT_SERVER_NAME] || null;
}

function readMcpJson(mcpPath) {
  if (!existsSync(mcpPath)) return { mcpServers: {} };
  const raw = readFileSync(mcpPath, 'utf8');
  return JSON.parse(raw);
}

function envRefName(value) {
  return isEnvReference(value) ? value.slice(2, -1) : null;
}

function normalizeEnvName(value) {
  if (!value) return null;
  return envRefName(value) || value;
}

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

function inferCredentialEnvVars(hulyConfig) {
  return credentialRefs(hulyConfig).map(({ ref }) => ref);
}

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

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function tomlString(value) {
  return JSON.stringify(value);
}

function routingLiteral(routingValue) {
  return routingValue?.kind === 'literal' ? routingValue.value : null;
}

function routingEnvName(routingValue) {
  return routingValue?.kind === 'env' ? routingValue.name : null;
}

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

function codexHeaderName(line) {
  const match = line.trim().match(/^\[([^\]]+)\]$/);
  return match?.[1] || null;
}

function isCodexServerHeader(header, serverName) {
  const prefix = `mcp_servers.${serverName}`;
  return header === prefix || header.startsWith(`${prefix}.`);
}

function hasCodexServerConfig(content, serverName) {
  return content
    .split(/\r?\n/)
    .some(line => {
      const header = codexHeaderName(line);
      return header && isCodexServerHeader(header, serverName);
    });
}

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

function mergeCodexConfig(existing, serverName, serverConfig, force) {
  if (!existing.trim()) return serverConfig;

  const hasServer = hasCodexServerConfig(existing, serverName);
  if (hasServer && !force) {
    throw new Error(`.codex/config.toml already has mcp_servers.${serverName}. Re-run with --force to replace it.`);
  }

  const base = hasServer ? removeCodexServerConfig(existing, serverName) : existing.trimEnd();
  return `${base}\n\n${serverConfig}`;
}

function claudeRoutingValue(routingValue) {
  if (!routingValue) return undefined;
  return routingValue.kind === 'env' ? `\${${routingValue.name}}` : routingValue.value;
}

function routingDisplayValue(routingValue) {
  return claudeRoutingValue(routingValue);
}

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

function projectDirFromCwd(cwd) {
  const mcpPath = findUp('.mcp.json', cwd);
  return mcpPath ? dirname(mcpPath) : resolve(cwd);
}

function existingHulyConfig(projectDir, serverName) {
  const mcpPath = join(projectDir, '.mcp.json');
  return existsSync(mcpPath) ? readHulyMcpConfig(mcpPath, serverName) : null;
}

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
