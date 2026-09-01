import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.HULY_URL = 'https://huly.example.test';
process.env.HULY_TOKEN = 'secret-token';
process.env.HULY_WORKSPACE = 'my-workspace';
process.env.HULY_PROJECT = 'PROJ';

const { handleToolCall, createMcpServer } = await import('../src/mcpShared.mjs');

describe('MCP shared runtime context', () => {
  function callHandler(server) {
    return server._requestHandlers.get('tools/call');
  }

  it('returns sanitized Huly context without credentials', async () => {
    const result = await handleToolCall('get_huly_context', {});

    assert.deepEqual(result, {
      defaultWorkspace: 'my-workspace',
      defaultProject: 'PROJ',
      hulyUrlHost: 'huly.example.test',
      authMode: 'token',
      packageName: '@bgx4k3p/huly-mcp-server',
      packageVersion: result.packageVersion,
      responseModes: ['compact', 'raw'],
      toolProfile: 'full'
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

  it('reports the workspace tool dispatch would actually use', async () => {
    // The reported workspace used to come from the module-load constant while
    // dispatch resolved from the live env, so a host that repointed the server
    // was told a workspace nothing was reading from.
    const original = process.env.HULY_WORKSPACE;
    process.env.HULY_WORKSPACE = 'repointed-workspace';
    try {
      const result = await handleToolCall('get_huly_context', {});
      assert.equal(result.defaultWorkspace, 'repointed-workspace');
    } finally {
      if (original === undefined) delete process.env.HULY_WORKSPACE;
      else process.env.HULY_WORKSPACE = original;
    }

    assert.equal((await handleToolCall('get_huly_context', {})).defaultWorkspace, 'my-workspace');
  });

  it('rejects every unadvertised tool argument', async () => {
    const { server } = createMcpServer();
    const call = callHandler(server);
    const result = await call({
      method: 'tools/call',
      params: { name: 'get_huly_context', arguments: { include_details: true } }
    }, {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unsupported argument/);
  });

  it('advertises get_huly_context in the MCP tool list', async () => {
    const { TOOLS } = createMcpServer();
    assert.ok(TOOLS.some(tool => tool.name === 'get_huly_context'));
  });

  it('supports smaller project and read tool profiles without changing full', () => {
    const full = createMcpServer({}, { toolProfile: 'full' }).TOOLS;
    const project = createMcpServer({}, { toolProfile: 'project' }).TOOLS;
    const read = createMcpServer({}, { toolProfile: 'read' }).TOOLS;

    assert.equal(full.length, 82);
    assert.ok(project.length < full.length);
    assert.ok(read.length < project.length);
    assert.ok(project.some(tool => tool.name === 'create_issue'));
    assert.equal(project.some(tool => tool.name === 'change_password'), false);
    assert.ok(read.some(tool => tool.name === 'get_issue'));
    assert.equal(read.some(tool => tool.name === 'create_issue'), false);
    assert.throws(() => createMcpServer({}, { toolProfile: 'tiny' }), /HULY_TOOL_PROFILE/);
  });

  it('rejects calls to tools outside the selected profile', async () => {
    const call = callHandler(createMcpServer({}, { toolProfile: 'read' }).server);
    const result = await call({
      method: 'tools/call',
      params: { name: 'create_issue', arguments: { project: 'PROJ', title: 'blocked' } }
    }, {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not enabled in the read profile/);
  });

  it('advertises bounded issue field and expansion controls', () => {
    const { TOOLS } = createMcpServer();
    for (const name of ['list_issues', 'get_issue']) {
      const properties = TOOLS.find(tool => tool.name === name).inputSchema.properties;
      assert.ok(properties.fields.items.enum.includes('title'));
      assert.ok(properties.include.items.enum.includes('activity'));
      assert.equal(properties.activity_limit.type, 'integer');
      assert.equal(properties.description_preview_chars.type, 'integer');
    }
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

  it('uses compact output by default and honors per-call raw metadata', async () => {
    const { server } = createMcpServer();
    const call = callHandler(server);
    const baseRequest = {
      method: 'tools/call',
      params: { name: 'get_huly_context', arguments: {} }
    };

    const compact = await call(baseRequest, {});
    const raw = await call({
      ...baseRequest,
      params: {
        ...baseRequest.params,
        _meta: { 'com.huly/responseMode': 'raw' }
      }
    }, {});

    assert.doesNotMatch(compact.content[0].text, /\n/);
    assert.doesNotMatch(raw.content[0].text, /\n/);
    assert.deepEqual(JSON.parse(compact.content[0].text), JSON.parse(raw.content[0].text));
  });

  it('keeps response defaults isolated across concurrent MCP sessions', async () => {
    const compactCall = callHandler(createMcpServer({}, { responseMode: 'compact' }).server);
    const rawCall = callHandler(createMcpServer({}, { responseMode: 'raw' }).server);
    const request = {
      method: 'tools/call',
      params: { name: 'get_huly_context', arguments: {} }
    };
    const [compact, raw] = await Promise.all([
      compactCall(request, {}),
      rawCall(request, {})
    ]);

    assert.doesNotMatch(compact.content[0].text, /\n/);
    assert.doesNotMatch(raw.content[0].text, /\n/);
  });
});
