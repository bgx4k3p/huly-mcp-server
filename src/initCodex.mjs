/**
 * Helpers for generating project-scoped MCP configuration.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, parse, resolve } from 'path';

const DEFAULT_SERVER_NAME = 'huly';

function usage(command = 'all') {
  const commands = {
    codex: 'huly-mcp-server --init-codex [--workspace <slug>] [--project <identifier>] [--server-name <name>] [--force]',
    claude: 'huly-mcp-server --init-claude --workspace <slug> [--project <identifier>] [--server-name <name>] [--force]',
    all: 'huly-mcp-server --init-all --workspace <slug> [--project <identifier>] [--server-name <name>] [--force]'
  };
  return [
    `Usage: ${commands[command] || commands.all}`,
    '',
    'Secrets are referenced from the user environment.',
    'HULY_WORKSPACE is written literally per project.',
    'HULY_PROJECT is optional and written only when --project is provided or inferable.'
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

function inferLiteralEnv(hulyConfig, key, explicitValue) {
  if (explicitValue) return explicitValue;

  const value = hulyConfig?.env?.[key];
  if (typeof value === 'string' && value.length > 0 && !isEnvReference(value)) {
    return value;
  }

  return null;
}

function inferEnvVars(hulyConfig) {
  const env = hulyConfig?.env || {};
  const vars = [];

  for (const key of ['HULY_URL', 'HULY_TOKEN', 'HULY_EMAIL', 'HULY_PASSWORD']) {
    const value = env[key];
    if (isEnvReference(value)) {
      const name = value.slice(2, -1);
      if (!vars.includes(name)) vars.push(name);
    }
  }

  return vars.length > 0 ? vars : ['HULY_URL', 'HULY_TOKEN'];
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderCodexConfig({ serverName, envVars, workspace, project }) {
  const args = ['-y', '@bgx4k3p/huly-mcp-server'];
  const lines = [
    `[mcp_servers.${serverName}]`,
    'command = "npx"',
    `args = [${args.map(tomlString).join(', ')}]`,
    `env_vars = [${envVars.map(tomlString).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    '',
    `[mcp_servers.${serverName}.env]`,
    `HULY_WORKSPACE = ${tomlString(workspace)}`
  ];

  if (project) {
    lines.push(`HULY_PROJECT = ${tomlString(project)}`);
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

function renderClaudeServer({ workspace, project }) {
  const env = {
    HULY_URL: '${HULY_URL}',
    HULY_TOKEN: '${HULY_TOKEN}',
    HULY_WORKSPACE: workspace
  };

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

function resolveWorkspaceAndProject(args, projectDir, serverName) {
  const hulyConfig = existingHulyConfig(projectDir, serverName);
  const workspace = inferLiteralEnv(hulyConfig, 'HULY_WORKSPACE', flagValue(args, ['--workspace', '-w']));
  const project = inferLiteralEnv(hulyConfig, 'HULY_PROJECT', flagValue(args, ['--project', '-p']));

  if (!workspace) {
    throw new Error('Could not determine HULY_WORKSPACE. Re-run with --workspace <slug>.');
  }

  return { hulyConfig, workspace, project };
}

export function initCodexConfig(args = process.argv.slice(2), cwd = process.cwd()) {
  if (hasFlag(args, ['--help', '-h'])) {
    return { ok: true, message: usage('codex') };
  }

  const serverName = flagValue(args, ['--server-name']) || DEFAULT_SERVER_NAME;
  const force = hasFlag(args, ['--force']);
  const projectDir = projectDirFromCwd(cwd);
  const { hulyConfig, workspace, project } = resolveWorkspaceAndProject(args, projectDir, serverName);

  const codexDir = join(projectDir, '.codex');
  const configPath = join(codexDir, 'config.toml');

  mkdirSync(codexDir, { recursive: true });
  const serverConfig = renderCodexConfig({
    serverName,
    envVars: inferEnvVars(hulyConfig),
    workspace,
    project
  });
  const existing = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const content = mergeCodexConfig(existing, serverName, serverConfig, force);
  writeFileSync(configPath, content, 'utf8');

  return {
    ok: true,
    path: configPath,
    message: `Wrote ${configPath} for Huly workspace "${workspace}".`
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
  const { workspace, project } = resolveWorkspaceAndProject(args, projectDir, serverName);
  const nextServer = renderClaudeServer({ workspace, project });

  if (existing && !force && JSON.stringify(existing) !== JSON.stringify(nextServer)) {
    throw new Error(`${mcpPath} already has mcpServers.${serverName}. Re-run with --force to replace it.`);
  }

  parsed.mcpServers[serverName] = nextServer;
  writeFileSync(mcpPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');

  return {
    ok: true,
    path: mcpPath,
    message: `Wrote ${mcpPath} for Huly workspace "${workspace}".`
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
