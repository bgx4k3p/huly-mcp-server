/**
 * The advertised tool schema is the only argument surface v3 accepts, so a
 * parameter the dispatch layer reads but never advertises is unreachable
 * (rejected as unsupported), and one it advertises but never reads is silently
 * ignored. Both directions are release defects; assert neither can reappear.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.HULY_URL = 'https://huly.example.test';

const { accountTools, workspaceTools } = await import('../src/dispatch.mjs');
const { createMcpServer } = await import('../src/mcpShared.mjs');

const { TOOLS } = createMcpServer();
const handlers = { ...accountTools, ...workspaceTools };

// Injected by the CallTool handler after argument validation, never client-supplied.
const INTERNAL_ARGS = new Set(['__responseMode', '__toolProfile']);
// Applied to every tool by applyDefaultProject/handleToolCall rather than a handler.
const IMPLICIT_ARGS = new Set(['workspace']);

/** Property names a handler reads off its arguments object. */
function argumentsRead(handler) {
  const source = handler.toString();
  const parameter = source.match(/^\(?\s*([A-Za-z_$][\w$]*)\s*[,)]/);
  assert.ok(parameter, `cannot determine the arguments parameter of ${source.slice(0, 60)}`);
  const reads = new Set();
  const access = new RegExp(`\\b${parameter[1]}\\.([A-Za-z_$][\\w$]*)`, 'g');
  let match;
  while ((match = access.exec(source)) !== null) reads.add(match[1]);
  return reads;
}

describe('dispatch and tool schema alignment', () => {
  it('advertises every argument a handler reads', () => {
    const unreachable = [];
    for (const tool of TOOLS) {
      const handler = handlers[tool.name];
      if (!handler) continue;
      const advertised = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
      for (const name of argumentsRead(handler)) {
        if (!advertised.has(name) && !INTERNAL_ARGS.has(name)) {
          unreachable.push(`${tool.name}.${name}`);
        }
      }
    }
    assert.deepEqual(unreachable, [],
      `handlers read arguments the schema does not advertise, so callers cannot pass them: ${unreachable.join(', ')}`);
  });

  it('reads every argument it advertises', () => {
    const ignored = [];
    for (const tool of TOOLS) {
      const handler = handlers[tool.name];
      if (!handler) continue;
      const reads = argumentsRead(handler);
      for (const name of Object.keys(tool.inputSchema?.properties ?? {})) {
        if (!reads.has(name) && !IMPLICIT_ARGS.has(name)) ignored.push(`${tool.name}.${name}`);
      }
    }
    assert.deepEqual(ignored, [],
      `schema advertises arguments no handler reads, so callers are silently ignored: ${ignored.join(', ')}`);
  });

  it('requires only arguments the handler reads', () => {
    for (const tool of TOOLS) {
      const handler = handlers[tool.name];
      if (!handler) continue;
      const reads = argumentsRead(handler);
      const advertised = new Set(Object.keys(tool.inputSchema?.properties ?? {}));
      for (const name of tool.inputSchema?.required ?? []) {
        assert.ok(advertised.has(name), `${tool.name} requires unadvertised argument ${name}`);
        assert.ok(reads.has(name) || IMPLICIT_ARGS.has(name),
          `${tool.name} requires ${name} but never reads it`);
      }
    }
  });

  it('rejects an unadvertised argument rather than ignoring it', async () => {
    const { server } = createMcpServer();
    const call = server._requestHandlers.get('tools/call');
    const result = await call({
      method: 'tools/call',
      params: { name: 'create_milestone', arguments: { project: 'TEST', name: 'M', notAField: 1 } }
    }, {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Unsupported argument for create_milestone: notAField/);
  });
});
