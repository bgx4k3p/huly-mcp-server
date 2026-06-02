import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { initAllConfigs, initClaudeConfig, initCodexConfig } from '../src/initCodex.mjs';

const PINNED_PACKAGE_RE = /@bgx4k3p\/huly-mcp-server@\d/;

function tempProject() {
  return mkdtempSync(join(tmpdir(), 'huly-mcp-init-'));
}

function writeMcp(projectDir, workspaceValue = 'my-workspace', tokenValue = '${HULY_TOKEN}') {
  writeFileSync(join(projectDir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      huly: {
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@bgx4k3p/huly-mcp-server'],
        env: {
          HULY_URL: 'https://huly.example.test',
          HULY_TOKEN: tokenValue,
          HULY_WORKSPACE: workspaceValue
        }
      }
    }
  }, null, 2));
}

describe('initCodexConfig', () => {
  it('documents routing env flags in help output', () => {
    const codex = initCodexConfig(['--help']);
    const claude = initClaudeConfig(['--help']);

    assert.match(codex.message, /--url-env <var>/);
    assert.match(codex.message, /--workspace-env <var>/);
    assert.match(claude.message, /--project-env <var>/);
  });

  it('generates project-scoped Codex MCP config from a literal .mcp.json workspace', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);

    const result = initCodexConfig([], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /\[mcp_servers\.huly\]/);
    assert.match(config, /command = "npx"/);
    assert.match(config, /env_vars = \["HULY_TOKEN"\]/);
    assert.match(config, /HULY_URL = "https:\/\/huly\.example\.test"/);
    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
    assert.doesNotMatch(config, PINNED_PACKAGE_RE);
  });

  it('supports --url when no .mcp.json exists', () => {
    const projectDir = tempProject();

    const result = initCodexConfig(['--url', 'https://huly.example.test', '--workspace', 'my-workspace'], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /env_vars = \["HULY_TOKEN"\]/);
    assert.match(config, /HULY_URL = "https:\/\/huly\.example\.test"/);
    assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
  });

  it('supports env routing refs in Codex config', () => {
    const projectDir = tempProject();

    const result = initCodexConfig([
      '--url-env', 'HULY_URL',
      '--workspace-env', 'HULY_WORKSPACE',
      '--project-env', 'HULY_PROJECT'
    ], projectDir);
    const config = readFileSync(result.path, 'utf8');

    assert.match(config, /env_vars = \["HULY_TOKEN", "HULY_URL", "HULY_WORKSPACE", "HULY_PROJECT"\]/);
    assert.doesNotMatch(config, /\[mcp_servers\.huly\.env\]/);
    assert.doesNotMatch(config, /HULY_URL = /);
    assert.doesNotMatch(config, /HULY_WORKSPACE = /);
  });

  it('keeps default Codex URL routing as an env ref without copying ambient HULY_URL', () => {
    const projectDir = tempProject();
    const previousUrl = process.env.HULY_URL;
    process.env.HULY_URL = 'http://localhost:8087';

    try {
      const result = initCodexConfig(['--workspace', 'my-workspace'], projectDir);
      const config = readFileSync(result.path, 'utf8');

      assert.match(config, /env_vars = \["HULY_TOKEN", "HULY_URL"\]/);
      assert.doesNotMatch(config, /HULY_URL = "http:\/\/localhost:8087"/);
      assert.match(config, /HULY_WORKSPACE = "my-workspace"/);
    } finally {
      if (previousUrl === undefined) {
        delete process.env.HULY_URL;
      } else {
        process.env.HULY_URL = previousUrl;
      }
    }
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

    const result = initCodexConfig(['--url', 'https://huly.example.test', '--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
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

    const result = initClaudeConfig(['--url', 'https://huly.example.test', '--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));

    assert.ok(parsed.mcpServers.other);
    assert.deepEqual(parsed.mcpServers.huly, {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@bgx4k3p/huly-mcp-server'],
      env: {
        HULY_URL: 'https://huly.example.test',
        HULY_WORKSPACE: 'my-workspace',
        HULY_TOKEN: '${HULY_TOKEN}',
        HULY_PROJECT: 'PROJ'
      }
    });
    assert.doesNotMatch(JSON.stringify(parsed.mcpServers.huly), PINNED_PACKAGE_RE);
  });

  it('keeps default Claude URL routing as an env ref', () => {
    const projectDir = tempProject();

    const result = initClaudeConfig(['--workspace', 'my-workspace'], projectDir);
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));

    assert.equal(parsed.mcpServers.huly.env.HULY_URL, '${HULY_URL}');
    assert.equal(parsed.mcpServers.huly.env.HULY_WORKSPACE, 'my-workspace');
    assert.equal(parsed.mcpServers.huly.env.HULY_TOKEN, '${HULY_TOKEN}');
  });

  it('preserves standard Claude credential keys when using renamed env refs', () => {
    const projectDir = tempProject();
    writeMcp(projectDir, 'my-workspace', '${HULY_AUTH_TOKEN}');

    const result = initClaudeConfig(['--force'], projectDir);
    const parsed = JSON.parse(readFileSync(result.path, 'utf8'));

    assert.equal(parsed.mcpServers.huly.env.HULY_TOKEN, '${HULY_AUTH_TOKEN}');
    assert.equal(parsed.mcpServers.huly.env.HULY_AUTH_TOKEN, undefined);
  });

  it('refuses to replace an existing Claude huly server without --force', () => {
    const projectDir = tempProject();
    writeMcp(projectDir);

    assert.throws(
      () => initClaudeConfig(['--workspace', 'other-workspace'], projectDir),
      /already has mcpServers\.huly/
    );
  });

  it('supports env routing refs in Claude config without ambient env values', () => {
    const projectDir = tempProject();
    const previousUrl = process.env.HULY_URL;
    const previousWorkspace = process.env.HULY_WORKSPACE;
    delete process.env.HULY_URL;
    delete process.env.HULY_WORKSPACE;

    try {
      const result = initClaudeConfig(['--url-env', 'HULY_URL', '--workspace-env', 'HULY_WORKSPACE'], projectDir);
      const parsed = JSON.parse(readFileSync(result.path, 'utf8'));

      assert.equal(parsed.mcpServers.huly.env.HULY_URL, '${HULY_URL}');
      assert.equal(parsed.mcpServers.huly.env.HULY_WORKSPACE, '${HULY_WORKSPACE}');
    } finally {
      if (previousUrl === undefined) {
        delete process.env.HULY_URL;
      } else {
        process.env.HULY_URL = previousUrl;
      }
      if (previousWorkspace === undefined) {
        delete process.env.HULY_WORKSPACE;
      } else {
        process.env.HULY_WORKSPACE = previousWorkspace;
      }
    }
  });

  it('creates both Claude and Codex config with --init-all helper', () => {
    const projectDir = tempProject();

    const result = initAllConfigs(['--url', 'https://huly.example.test', '--workspace', 'my-workspace', '--project', 'PROJ'], projectDir);
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    const codex = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8');

    assert.equal(result.paths.length, 2);
    assert.equal(mcp.mcpServers.huly.env.HULY_URL, 'https://huly.example.test');
    assert.equal(mcp.mcpServers.huly.env.HULY_WORKSPACE, 'my-workspace');
    assert.equal(mcp.mcpServers.huly.env.HULY_PROJECT, 'PROJ');
    assert.match(codex, /HULY_URL = "https:\/\/huly\.example\.test"/);
    assert.match(codex, /HULY_PROJECT = "PROJ"/);
  });

  it('creates both configs with routing values from env refs', () => {
    const projectDir = tempProject();

    const result = initAllConfigs([
      '--url-env', 'HULY_URL',
      '--workspace-env', 'HULY_WORKSPACE',
      '--project-env', 'HULY_PROJECT'
    ], projectDir);
    const mcp = JSON.parse(readFileSync(join(projectDir, '.mcp.json'), 'utf8'));
    const codex = readFileSync(join(projectDir, '.codex', 'config.toml'), 'utf8');

    assert.equal(result.paths.length, 2);
    assert.equal(mcp.mcpServers.huly.env.HULY_URL, '${HULY_URL}');
    assert.equal(mcp.mcpServers.huly.env.HULY_WORKSPACE, '${HULY_WORKSPACE}');
    assert.equal(mcp.mcpServers.huly.env.HULY_PROJECT, '${HULY_PROJECT}');
    assert.match(codex, /env_vars = \["HULY_TOKEN", "HULY_URL", "HULY_WORKSPACE", "HULY_PROJECT"\]/);
    assert.doesNotMatch(codex, /\[mcp_servers\.huly\.env\]/);
  });
});
