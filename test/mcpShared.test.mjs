import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.HULY_URL = 'https://huly.example.test';
process.env.HULY_TOKEN = 'secret-token';
process.env.HULY_WORKSPACE = 'my-workspace';
process.env.HULY_PROJECT = 'PROJ';

const { handleToolCall, createMcpServer } = await import('../src/mcpShared.mjs');

describe('MCP shared runtime context', () => {
  it('returns sanitized Huly context without credentials', async () => {
    const result = await handleToolCall('get_huly_context', {});

    assert.deepEqual(result, {
      defaultWorkspace: 'my-workspace',
      defaultProject: 'PROJ',
      hulyUrlHost: 'huly.example.test',
      authMode: 'token',
      packageName: '@bgx4k3p/huly-mcp-server',
      packageVersion: result.packageVersion
    });
    assert.ok(result.packageVersion);
    assert.equal(Object.hasOwn(result, 'token'), false);
    assert.equal(Object.hasOwn(result, 'password'), false);
  });

  it('handles missing tool arguments for zero-argument tools', async () => {
    const result = await handleToolCall('get_huly_context');

    assert.equal(result.defaultWorkspace, 'my-workspace');
    assert.equal(result.defaultProject, 'PROJ');
  });

  it('advertises get_huly_context in the MCP tool list', async () => {
    const { TOOLS } = createMcpServer();
    assert.ok(TOOLS.some(tool => tool.name === 'get_huly_context'));
  });

  it('makes project optional in project-scoped schemas when HULY_PROJECT is set', async () => {
    const { TOOLS } = createMcpServer();
    const getProject = TOOLS.find(tool => tool.name === 'get_project');
    const createIssue = TOOLS.find(tool => tool.name === 'create_issue');

    assert.ok(!getProject.inputSchema.required.includes('project'));
    assert.ok(!createIssue.inputSchema.required.includes('project'));
    assert.match(getProject.inputSchema.properties.project.description, /defaults to "PROJ"/);
    assert.ok(createIssue.inputSchema.required.includes('title'));
  });
});
