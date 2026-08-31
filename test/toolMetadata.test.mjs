import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.HULY_URL = 'https://huly.example.test';

const {
  accountTools,
  workspaceTools,
  READ_ONLY_TOOL_NAMES,
  DESTRUCTIVE_TOOL_NAMES
} = await import('../src/dispatch.mjs');
const { createMcpServer, SERVER_INSTRUCTIONS } = await import('../src/mcpShared.mjs');

const { server, TOOLS } = createMcpServer();
const handlerNames = new Set([
  'get_huly_context',
  ...Object.keys(accountTools),
  ...Object.keys(workspaceTools)
]);

function effectiveAnnotations(tool) {
  return {
    readOnlyHint: tool.annotations?.readOnlyHint ?? false,
    destructiveHint: tool.annotations?.destructiveHint ?? true,
    idempotentHint: tool.annotations?.idempotentHint ?? false,
    openWorldHint: tool.annotations?.openWorldHint ?? true
  };
}

describe('MCP tool metadata', () => {
  it('classifies every dispatch handler exactly once', () => {
    assert.equal(TOOLS.length, handlerNames.size);
    assert.deepEqual(new Set(TOOLS.map(tool => tool.name)), handlerNames);

    for (const name of handlerNames) {
      assert.equal(
        READ_ONLY_TOOL_NAMES.has(name) && DESTRUCTIVE_TOOL_NAMES.has(name),
        false,
        `${name} cannot be both read-only and destructive`
      );
    }
  });

  it('never marks a mutation verb as read-only', () => {
    const mutationVerb = /^(create|update|delete|set|change|send|resend|add|remove|move|batch|archive|log)_/;
    for (const name of handlerNames) {
      if (mutationVerb.test(name)) {
        assert.equal(READ_ONLY_TOOL_NAMES.has(name), false, `${name} mutates state`);
      }
    }
  });

  it('advertises compact annotations with safe MCP defaults', () => {
    for (const tool of TOOLS) {
      const effective = effectiveAnnotations(tool);
      assert.equal(effective.readOnlyHint, READ_ONLY_TOOL_NAMES.has(tool.name), tool.name);
      assert.equal(effective.openWorldHint, true, tool.name);

      if (READ_ONLY_TOOL_NAMES.has(tool.name)) {
        assert.deepEqual(tool.annotations, { readOnlyHint: true }, tool.name);
      } else {
        assert.equal(effective.destructiveHint, DESTRUCTIVE_TOOL_NAMES.has(tool.name), tool.name);
        assert.deepEqual(tool.annotations, {
          destructiveHint: DESTRUCTIVE_TOOL_NAMES.has(tool.name)
        }, tool.name);
      }
    }
  });

  it('keeps tool discovery metadata useful and bounded', () => {
    for (const tool of TOOLS) {
      assert.ok(tool.description?.length > 10, `${tool.name} needs a useful description`);
      assert.ok(tool.description.length <= 400, `${tool.name} description is too verbose`);
      assert.equal(tool.inputSchema.type, 'object', tool.name);
    }
  });

  it('keeps every tool profile within its discovery-byte budget', () => {
    // Raised once from 43_500/33_500 when the nine parameter sites the
    // dispatch layer reads were finally advertised; still under the
    // 45_016-byte v2.4.6 catalog. Treat any further increase as a bloat
    // regression to justify.
    const budgets = { full: 44_100, project: 33_900, read: 19_000 };
    for (const [profile, maximum] of Object.entries(budgets)) {
      const tools = createMcpServer({}, { toolProfile: profile }).TOOLS;
      const bytes = Buffer.byteLength(JSON.stringify(tools));
      assert.ok(bytes <= maximum, `${profile}: ${bytes} exceeds ${maximum}`);
    }
  });

  it('provides token-efficient workflow and untrusted-content guidance', () => {
    assert.match(SERVER_INSTRUCTIONS, /smallest useful limit/);
    assert.match(SERVER_INSTRUCTIONS, /Omit include for discovery/);
    assert.match(SERVER_INSTRUCTIONS, /untrusted data/);
    assert.equal(server._instructions, SERVER_INSTRUCTIONS);
  });
});
