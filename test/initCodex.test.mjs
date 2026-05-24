import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { initAllConfigs, initClaudeConfig, initCodexConfig } from '../src/initCodex.mjs';

function tempProject() {
  return mkdtempSync('/private/tmp/huly-mcp-init-');
}

function writeMcp(projectDir, workspaceValue = 'my-workspace') {
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      huly: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@bgx4k3p/huly-mcp-server'],
        env: {
          HULY_URL: '${HULY_URL}',
          HULY_TOKEN: '${HULY_TOKEN}',
          HULY_WORKSPACE: workspaceValue
        }
      }
    }
  }, null, 2));
}

describe('initCodexConfig', () => {
  it('generates project-scoped Codex MCP config from a literal .mcp.json workspace', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);

    const result = initCodexConfig([], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /\[mcp_servers\.huly\]/);
    assert.match(config, /command = "npx"/);
    assert.match(config, /env_vars = \["HULY_URL", "HULY_TOKEN"\]/);
    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
  });

  it('uses --workspace when .mcp.json workspace is an env reference', () => {
    const projectDir = tempProject();
    writeMcp(projectDir, '${HULY_WORKSPACE_MYAPP}');

    const result = initCodexConfig(['--workspace', 'my-workspace'], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
  });

  it('preserves existing Codex config when adding the Huly server', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);
    mkdirSync(join(projectDir, '.codex'));
    writeFileSync(join(projectDir, '.codex', 'config.toml'), 'model = "test"\n');

    const result = initCodexConfig([], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /model = "test"/);
    assert.match(config, /\[mcp_servers\.huly\]/);
  });

  it('refuses to replace an existing Codex huly server without --force', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);
    mkdirSync(join(projectDir, '.codex'));
    writeFileSync(join(projectDir, '.codex', 'config.toml'), [
      'model = "test"',
      '',
      '[mcp_servers.huly]',
      'command = "old"',
      ''
    ].join('\n'));

    assert.throws(
      () => initCodexConfig([], projectDir),
      /already has mcp_servers\.huly/
    );
  });

  it('replaces only the Codex huly server with --force', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);
    mkdirSync(join(projectDir, '.codex'));
    writeFileSync(join(projectDir, '.codex', 'config.toml'), [
      'model = "test"',
      '',
      '[mcp_servers.other]',
      'command = "other"',
      '',
      '[mcp_servers.huly]',
      'command = "old"',
      '',
      '[mcp_servers.huly.env]',
      'HULY_WORKSPACE = "old"',
      ''
    ].join('\n'));

    const result = initCodexConfig(['--force'], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /model = "test"/);
    assert.match(config, /\[mcp_servers\.other\]/);
    assert.doesNotMatch(config, /command = "old"/);
    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
  });

  it('writes optional HULY_PROJECT to Codex config when --project is provided', () => {
    const projectDir = tempProject();

    const result = initCodexConfig(['--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
    assert.match(config, /HULY_PROJECT = "PROJ"/);
  });

  it('creates .mcp.json for Claude while preserving existing servers', () => {
    const projectDir = tempProject();
    writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        other: {
          command: 'node',
          args: ['other-server.js']
        }
      }
    }, null, 2));

    const result = initClaudeConfig(['--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));

    assert.ok(parsed.mcpServers.other);
    assert.deepEqual(parsed.mcpServers.huly, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@bgx4k3p/huly-mcp-server'],
      env: {
        HULY_URL: '${HULY_URL}',
        HULY_TOKEN: '${HULY_TOKEN}',
        HULY_WORKSPACE: 'my-workspace',
        HULY_PROJECT: 'PROJ'
      }
    });
  });

  it('refuses to replace an existing Claude huly server without --force', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);

    assert.throws(
      () => initClaudeConfig(['--workspace', 'other-workspace'], projectDir),
      /already has mcpServers\.huly/
    );
  });

  it('creates both Claude and Codex config with --init-all helper', () => {
    const projectDir = tempProject();

    const result = initAllConfigs(['--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    const codex = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8');

    assert.equal(result.paths.length, 2);
    assert.equal(mcp.mcpServers.huly.env.HULY_PROJECT, 'PROJ');
    assert.match(codex, /HULY_PROJECT = "PROJ"/);
  });
});
