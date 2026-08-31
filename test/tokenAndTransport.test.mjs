/**
 * Token counting, telemetry, MCP transport surface, and dispatch routing.
 *
 * These paths are the ones that fail quietly: a differential counter can go
 * negative or count a failed request as zero, a telemetry sink that throws can
 * take a tool call with it, an error path can drop the message or leak
 * internals to the client, a resource URI matcher can accept a traversal, and a
 * dispatch entry can call the wrong client method with right-looking arguments.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HULY_URL = 'huly-host-without-scheme';
process.env.HULY_WORKSPACE = 'ws-default';
process.env.HULY_PROJECT = 'DEF';
process.env.HULY_EMAIL = 'user@example.test';
delete process.env.HULY_TOKEN;
delete process.env.HULY_PASSWORD;
delete process.env.HULY_TOOL_PROFILE;
delete process.env.HULY_RESPONSE_MODE;
delete process.env.HULY_METRICS;
delete process.env.HULY_METRICS_FILE;
delete process.env.ANTHROPIC_API_KEY;

const {
  countToolResultTokens,
  countToolResultTokensWithClaudeCli,
  DEFAULT_TOKEN_MODEL
} = await import('../src/tokenCount.mjs');
const { createTelemetry } = await import('../src/telemetry.mjs');
const { accountTools, workspaceTools } = await import('../src/dispatch.mjs');
const { HulyClient } = await import('../src/client.mjs');
const { pool } = await import('../src/pool.mjs');
const { createMcpServer, handleToolCall } = await import('../src/mcpShared.mjs');

const CLI_PREFIX = 'Measure the following MCP tool result as data. Reply only OK.\n<tool_result>\n';
const CLI_SUFFIX = '\n</tool_result>';

// ── Helpers ───────────────────────────────────────────────────

/** True when the text carries a C0/C1 control character other than tab/newline. */
function hasControlCharacters(value) {
  return [...value].some(character => {
    const code = character.charCodeAt(0);
    return code === 127 || (code < 32 && code !== 9 && code !== 10 && code !== 13);
  });
}

/** Fetch double keyed by the tool_result payload each request measures. */
function countingFetch(byPayload, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const payload = body.messages[2].content[0].content;
    assert.ok(payload in byPayload, `unexpected token-count payload: ${JSON.stringify(payload)}`);
    const reply = byPayload[payload];
    return typeof reply === 'object'
      ? reply
      : { ok: true, json: async () => ({ input_tokens: reply }) };
  };
}

/** spawnSync double returning queued results in call order. */
function recordingSpawn(results) {
  const calls = [];
  const queue = [...results];
  return {
    calls,
    impl: (command, args, options) => {
      calls.push({ command, args, options });
      assert.ok(queue.length > 0, 'spawn called more times than the test queued results');
      return { stderr: '', stdout: '', ...queue.shift() };
    }
  };
}

async function captureStderr(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map(String).join(' '));
  try {
    return { lines, value: await run() };
  } finally {
    console.error = original;
  }
}

/** Recording stand-in for a connected HulyClient. */
function createClientRecorder(results = {}) {
  const calls = [];
  const target = { withReconnect: operation => operation() };
  const client = new Proxy(target, {
    get(_target, prop) {
      // Must never look thenable: the pool returns this from an async function.
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'withReconnect') {
        return Reflect.get(target, prop);
      }
      return (...args) => {
        calls.push({ method: prop, args });
        return Promise.resolve(results[prop] ?? { recorded: true });
      };
    }
  });
  return { client, calls };
}

/**
 * Install a pool stub for the duration of `run`. Pass an Error to make every
 * connection attempt fail. Requested workspaces are appended to `workspaces`.
 */
async function withPooledClient(client, run, workspaces = []) {
  const original = Object.getOwnPropertyDescriptor(pool, 'getClient');
  pool.getClient = async workspace => {
    workspaces.push(workspace);
    if (client instanceof Error) throw client;
    return client;
  };
  try {
    return await run();
  } finally {
    if (original) Object.defineProperty(pool, 'getClient', original);
    else delete pool.getClient;
  }
}

/** Replace every HulyClient static with a recorder for the duration of `run`. */
async function withRecordedStatics(run) {
  const names = Object.getOwnPropertyNames(HulyClient)
    .filter(key => !['prototype', 'length', 'name'].includes(key))
    .filter(key => typeof HulyClient[key] === 'function');
  const originals = names.map(name => [name, HulyClient[name]]);
  const calls = [];
  for (const name of names) {
    HulyClient[name] = (...args) => {
      calls.push({ method: name, args });
      return Promise.resolve({ recorded: true });
    };
  }
  try {
    await run(calls);
    return calls;
  } finally {
    for (const [name, value] of originals) HulyClient[name] = value;
  }
}

const SENTINEL = '__DISPATCH_SENTINEL__';

function buildArgs(schema) {
  const args = {};
  for (const [key, def] of Object.entries(schema.properties || {})) {
    if (key === 'workspace') continue;
    const type = Array.isArray(def.type) ? def.type[0] : def.type;
    if (type === 'string') args[key] = `${SENTINEL}_${key}`;
    else if (type === 'number' || type === 'integer') args[key] = 7;
    else if (type === 'boolean') args[key] = true;
    else if (type === 'array') args[key] = [`${SENTINEL}_${key}_item`];
    else if (type === 'object') args[key] = { [`${SENTINEL}_${key}`]: true };
    else args[key] = SENTINEL;
  }
  return args;
}

function deepContains(value, needle) {
  if (Object.is(value, needle)) return true;
  if (Array.isArray(value)) return value.some(item => deepContains(item, needle));
  if (value && typeof value === 'object') {
    return Object.values(value).some(item => deepContains(item, needle));
  }
  return false;
}

function deepHasKey(value, key) {
  if (Array.isArray(value)) return value.some(item => deepHasKey(item, key));
  if (value && typeof value === 'object') {
    if (Object.hasOwn(value, key)) return true;
    return Object.values(value).some(item => deepHasKey(item, key));
  }
  return false;
}

// ════════════════════════════════════════════════════════════════
// 1. Provider token counting (HTTP)
// ════════════════════════════════════════════════════════════════

describe('Anthropic provider token counting', () => {
  it('measures only the payload, with both requests differing solely in the tool result', async () => {
    const calls = [];
    const result = await countToolResultTokens('fixture payload', {
      apiKey: 'k-test',
      fetchImpl: countingFetch({ 'fixture payload': 180, '': 30 }, calls)
    });

    assert.deepEqual(result, {
      tokens: 150,
      model: DEFAULT_TOKEN_MODEL,
      counter: 'anthropic-messages-count-tokens',
      anthropicVersion: '2023-06-01'
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages/count_tokens');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(calls[0].init.headers, {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'k-test'
    });
    assert.equal(calls[0].body.model, DEFAULT_TOKEN_MODEL);

    // Subtracting the baseline is only meaningful when the two requests are
    // identical apart from the measured tool_result content.
    const [measured, baseline] = calls.map(call => call.body);
    measured.messages[2].content[0].content = '<payload>';
    baseline.messages[2].content[0].content = '<payload>';
    assert.deepEqual(measured, baseline);
  });

  it('floors the differential at zero instead of reporting negative tokens', async () => {
    const result = await countToolResultTokens('tiny', {
      apiKey: 'k-test',
      model: 'claude-test-pinned',
      fetchImpl: countingFetch({ tiny: 30, '': 90 })
    });

    assert.equal(result.tokens, 0);
    assert.equal(Object.is(result.tokens, -0), false);
    assert.equal(result.model, 'claude-test-pinned');
  });

  it('rejects on a non-ok HTTP response rather than counting it as zero', async () => {
    await assert.rejects(
      () => countToolResultTokens('payload', {
        apiKey: 'k-test',
        fetchImpl: countingFetch({
          payload: { ok: true, json: async () => ({ input_tokens: 100 }) },
          '': { ok: false, status: 429, json: async () => ({ input_tokens: 0 }) }
        })
      }),
      /Anthropic token count failed: HTTP 429/
    );
  });

  it('rejects a response whose input_tokens is missing or not an integer', async () => {
    for (const value of [undefined, null, '150', 12.5, Number.NaN]) {
      await assert.rejects(
        () => countToolResultTokens('payload', {
          apiKey: 'k-test',
          fetchImpl: countingFetch({
            payload: { ok: true, json: async () => ({ input_tokens: value }) },
            '': 30
          })
        }),
        /omitted input_tokens/,
        `input_tokens ${JSON.stringify(value)} must not be accepted`
      );
    }
  });

  it('refuses to call the API when no key is configured', async () => {
    let requests = 0;
    await assert.rejects(
      () => countToolResultTokens('payload', { fetchImpl: async () => { requests += 1; } }),
      /ANTHROPIC_API_KEY is required/
    );
    assert.equal(requests, 0);

    // Also with the real fetch in place: the key check must precede any request.
    await assert.rejects(
      () => countToolResultTokens('payload'),
      /ANTHROPIC_API_KEY is required/
    );
  });
});

// ════════════════════════════════════════════════════════════════
// 2. Claude CLI differential token counting
// ════════════════════════════════════════════════════════════════

describe('Claude CLI differential token counting', () => {
  it('sums the usage keys and subtracts the empty-result framing', () => {
    const spawn = recordingSpawn([
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 900, cache_creation_input_tokens: 50, cache_read_input_tokens: 50 } }) },
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 30, cache_read_input_tokens: 10 } }) }
    ]);

    const result = countToolResultTokensWithClaudeCli('fixture payload', { spawnImpl: spawn.impl });

    assert.deepEqual(result, {
      tokens: 960,
      model: DEFAULT_TOKEN_MODEL,
      counter: 'claude-cli-differential'
    });
    assert.equal(spawn.calls.length, 2);
    assert.equal(spawn.calls[0].command, 'claude');
    assert.equal(spawn.calls[0].options.input, `${CLI_PREFIX}fixture payload${CLI_SUFFIX}`);
    assert.equal(spawn.calls[1].options.input, `${CLI_PREFIX}${CLI_SUFFIX}`);
    assert.equal(spawn.calls[0].options.encoding, 'utf8');
    assert.equal(spawn.calls[0].options.maxBuffer, 10 * 1024 * 1024);
    assert.deepEqual(spawn.calls[0].args, spawn.calls[1].args);
    const args = spawn.calls[0].args;
    assert.equal(args[args.indexOf('--model') + 1], DEFAULT_TOKEN_MODEL);
    assert.equal(args[args.indexOf('--output-format') + 1], 'json');
    assert.ok(args.includes('--no-session-persistence'));
  });

  it('ignores absent and non-numeric usage keys instead of producing NaN', () => {
    const spawn = recordingSpawn([
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 10, cache_creation_input_tokens: 'twelve', cache_read_input_tokens: null } }) },
      { status: 0, stdout: JSON.stringify({ id: 'no-usage-key' }) }
    ]);

    assert.equal(countToolResultTokensWithClaudeCli('payload', { spawnImpl: spawn.impl }).tokens, 10);
  });

  it('floors the CLI differential at zero', () => {
    const spawn = recordingSpawn([
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 10 } }) },
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 40 } }) }
    ]);

    assert.equal(countToolResultTokensWithClaudeCli('payload', { spawnImpl: spawn.impl }).tokens, 0);
  });

  it('throws with the CLI stderr on a non-zero exit', () => {
    const spawn = recordingSpawn([{ status: 2, stderr: 'boom: model not available' }]);

    assert.throws(
      () => countToolResultTokensWithClaudeCli('payload', { spawnImpl: spawn.impl }),
      /Claude CLI token count failed: boom: model not available/
    );
    assert.equal(spawn.calls.length, 1, 'must not measure the baseline after a failure');
  });

  it('treats a signal-killed CLI as a failure, not as zero tokens', () => {
    const spawn = recordingSpawn([{ status: null, stderr: '' }]);

    assert.throws(
      () => countToolResultTokensWithClaudeCli('payload', { spawnImpl: spawn.impl }),
      /Claude CLI token count failed: exit null/
    );
  });

  it('propagates malformed CLI JSON instead of returning a zero count', () => {
    const spawn = recordingSpawn([{ status: 0, stdout: 'Welcome to Claude!\nnot json' }]);

    assert.throws(
      () => countToolResultTokensWithClaudeCli('payload', { spawnImpl: spawn.impl }),
      SyntaxError
    );
  });

  it('honors an explicit command and model', () => {
    const spawn = recordingSpawn([
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 5 } }) },
      { status: 0, stdout: JSON.stringify({ usage: { input_tokens: 5 } }) }
    ]);

    const result = countToolResultTokensWithClaudeCli('payload', {
      spawnImpl: spawn.impl,
      command: '/opt/bin/claude',
      model: 'claude-test-pinned'
    });

    assert.equal(result.model, 'claude-test-pinned');
    assert.equal(spawn.calls[0].command, '/opt/bin/claude');
    const args = spawn.calls[0].args;
    assert.equal(args[args.indexOf('--model') + 1], 'claude-test-pinned');
  });
});

// ════════════════════════════════════════════════════════════════
// 3. Telemetry — metadata only, never fatal
// ════════════════════════════════════════════════════════════════

describe('telemetry emits metadata and never fails a tool call', () => {
  const METRIC_KEYS = [
    'schemaVersion', 'kind', 'sessionId', 'sequence', 'tool', 'responseMode',
    'outputBytes', 'outputEstimatedTokens', 'durationMs', 'isError', 'sessionTotals'
  ];

  it('records no field derived from the result content', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'huly-metrics-shape-')), 'metrics.jsonl');
    const telemetry = createTelemetry({ destination: 'file', file, sessionId: 'session-shape' });
    const secret = '{"description":"leaked-issue-body","assignee":"leaked@example.test"}';

    telemetry.record({ toolName: 'get_issue', resultText: secret, durationMs: 3 });

    const raw = readFileSync(file, 'utf8').trim();
    assert.doesNotMatch(raw, /leaked/);
    const event = JSON.parse(raw);
    assert.deepEqual(Object.keys(event).sort(), [...METRIC_KEYS].sort());
    assert.deepEqual(Object.keys(event.sessionTotals).sort(),
      ['calls', 'outputBytes', 'outputEstimatedTokens']);
    assert.equal(event.outputBytes, Buffer.byteLength(secret, 'utf8'));
    assert.equal(event.outputEstimatedTokens, Math.ceil(event.outputBytes / 4));
    assert.equal(event.responseMode, 'compact');
    assert.equal(event.isError, false);
  });

  it('clamps and rounds durations and tolerates a missing result', () => {
    const events = [];
    const telemetry = createTelemetry({ destination: 'stderr', sessionId: 'session-duration' });
    const original = console.error;
    console.error = line => events.push(JSON.parse(String(line).replace(/^\[huly-mcp-metrics\] /, '')));
    try {
      telemetry.record({ toolName: 'a', resultText: '{}', durationMs: -12.5 });
      telemetry.record({ toolName: 'b', resultText: '{}', durationMs: 1.23456 });
      telemetry.record({ toolName: 'c', durationMs: 1 });
    } finally {
      console.error = original;
    }

    assert.equal(events[0].durationMs, 0);
    assert.equal(events[1].durationMs, 1.235);
    assert.equal(events[2].outputBytes, 0);
    assert.equal(events[2].outputEstimatedTokens, 0);
    assert.deepEqual(events.map(event => event.sequence), [1, 2, 3]);
  });

  it('swallows a file destination with no configured path', async () => {
    const telemetry = createTelemetry({ destination: 'file', sessionId: 'session-nofile' });
    const { lines } = await captureStderr(async () => {
      telemetry.record({ toolName: 'get_issue', resultText: '{"body":"leaked"}', durationMs: 1 });
    });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[huly-mcp\] metrics disabled after error: HULY_METRICS_FILE is required/);
    assert.doesNotMatch(lines[0], /leaked/);
    assert.deepEqual(telemetry.snapshot(), {
      sessionId: 'session-nofile',
      calls: 1,
      outputBytes: 17,
      outputEstimatedTokens: 5
    });
  });

  it('swallows an unsupported destination on every call', async () => {
    const telemetry = createTelemetry({ destination: 'syslog', sessionId: 'session-bad' });
    const { lines } = await captureStderr(async () => {
      telemetry.record({ toolName: 'get_issue', resultText: '{}', durationMs: 1 });
      telemetry.record({ toolName: 'get_issue', resultText: '{}', durationMs: 1 });
    });

    assert.equal(lines.length, 2);
    for (const line of lines) {
      assert.match(line, /metrics disabled after error: Unsupported HULY_METRICS destination: syslog/);
    }
    assert.equal(telemetry.snapshot().calls, 2);
  });
});

// ════════════════════════════════════════════════════════════════
// 4. MCP tool-call surface
// ════════════════════════════════════════════════════════════════

const handlerFor = (server, method) => server._requestHandlers.get(method);

function callTool(server, name, args, meta) {
  const params = meta ? { name, arguments: args, _meta: meta } : { name, arguments: args };
  return handlerFor(server, 'tools/call')({ method: 'tools/call', params }, {});
}

describe('MCP tool-call surface', () => {
  it('reports sanitized runtime context and falls back when HULY_URL is unparseable', async () => {
    const context = await handleToolCall('get_huly_context', {});

    assert.equal(context.hulyUrlHost, 'huly-host-without-scheme');
    assert.equal(context.authMode, 'incomplete_email_password');
    assert.equal(context.defaultWorkspace, 'ws-default');
    assert.equal(context.defaultProject, 'DEF');
    assert.deepEqual(Object.keys(context).sort(), [
      'authMode', 'defaultProject', 'defaultWorkspace', 'hulyUrlHost',
      'packageName', 'packageVersion', 'responseModes', 'toolProfile'
    ]);
  });

  it('lists tools without advertising the internal argument names', async () => {
    const { server, TOOLS } = createMcpServer();
    const listed = await handlerFor(server, 'tools/list')({ method: 'tools/list', params: {} }, {});

    assert.equal(listed.tools.length, TOOLS.length);
    assert.equal(new Set(listed.tools.map(tool => tool.name)).size, TOOLS.length);
    for (const tool of listed.tools) {
      const properties = Object.keys(tool.inputSchema?.properties ?? {});
      assert.equal(properties.includes('__responseMode'), false, `${tool.name} advertises __responseMode`);
      assert.equal(properties.includes('__toolProfile'), false, `${tool.name} advertises __toolProfile`);
    }
  });

  it('refuses a client-supplied tool profile', async () => {
    const { server } = createMcpServer({}, { toolProfile: 'read' });

    const spoofed = await callTool(server, 'get_huly_context', { __toolProfile: 'full' });
    assert.equal(spoofed.isError, true);
    assert.match(spoofed.content[0].text, /Unsupported argument for get_huly_context: __toolProfile/);

    const honest = await callTool(server, 'get_huly_context', {});
    assert.equal(honest.isError, undefined);
    assert.equal(JSON.parse(honest.content[0].text).toolProfile, 'read');
  });

  it('returns the failure message and nothing else on the error path', async () => {
    const { server } = createMcpServer();
    const failure = new Error('workspace ws-default is unreachable');
    failure.code = 'ECONNREFUSED';
    failure.stack = 'Error: workspace ws-default is unreachable\n    at /src/pool.mjs:57:3';

    const result = await withPooledClient(failure, () =>
      callTool(server, 'get_project', { project: 'PROJ' }));

    assert.equal(result.isError, true);
    const payload = JSON.parse(result.content[0].text);
    assert.deepEqual(payload, { error: 'workspace ws-default is unreachable' });
    assert.deepEqual(Object.keys(payload), ['error']);
    assert.doesNotMatch(result.content[0].text, /pool\.mjs|ECONNREFUSED/);
  });

  it('substitutes a message when the failure carries none', async () => {
    const { server } = createMcpServer();
    const result = await withPooledClient(new Error(''), () =>
      callTool(server, 'get_project', { project: 'PROJ' }));

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), { error: 'Tool call failed' });
  });

  it('bounds and sanitizes a hostile failure message', async () => {
    const { server } = createMcpServer();
    const escapes = `${String.fromCharCode(0)}${String.fromCharCode(27)}`;
    const hostile = new Error(`start${escapes}[31m${'x'.repeat(900)}`);

    const result = await withPooledClient(hostile, () =>
      callTool(server, 'get_project', { project: 'PROJ' }));

    const message = JSON.parse(result.content[0].text).error;
    assert.equal(message.length, 500);
    assert.equal(message.startsWith('start  [31m'), true);
    assert.equal(hasControlCharacters(message), false);
  });

  it('reports an invalid per-call response mode instead of silently defaulting', async () => {
    const { server } = createMcpServer();
    const result = await callTool(server, 'get_huly_context', {}, { 'com.huly/responseMode': 'verbose' });

    assert.equal(result.isError, true);
    assert.deepEqual(JSON.parse(result.content[0].text), {
      error: 'Invalid com.huly/responseMode: expected compact or raw'
    });
  });

  it('records failed calls as metadata without recording the failure text', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'huly-metrics-error-')), 'metrics.jsonl');
    const { server } = createMcpServer({}, {
      telemetry: { destination: 'file', file, sessionId: 'session-calls' }
    });

    await callTool(server, 'get_huly_context', {});
    await withPooledClient(new Error('secret-hostname.internal refused'), () =>
      callTool(server, 'get_project', { project: 'PROJ' }));

    const raw = readFileSync(file, 'utf8');
    const events = raw.trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 2);
    assert.equal(events[0].tool, 'get_huly_context');
    assert.equal(events[0].isError, false);
    assert.equal(events[1].tool, 'get_project');
    assert.equal(events[1].isError, true);
    assert.equal(events[1].responseMode, 'compact');
    assert.doesNotMatch(raw, /secret-hostname/);
  });

  it('routes a workspace tool through the pool with the injected response mode', async () => {
    const { server } = createMcpServer();
    const recorder = createClientRecorder({ listIssues: { items: [], count: 0 } });
    const workspaces = [];

    const result = await withPooledClient(recorder.client, () =>
      callTool(server, 'list_issues', { project: 'PROJ', workspace: 'ws-explicit', limit: 5 }),
    workspaces);

    assert.deepEqual(workspaces, ['ws-explicit']);
    assert.equal(recorder.calls.length, 1);
    assert.equal(recorder.calls[0].method, 'listIssues');
    assert.equal(recorder.calls[0].args[0], 'PROJ');
    assert.equal(recorder.calls[0].args[5], 5);
    assert.equal(recorder.calls[0].args[7].responseMode, 'compact');
    assert.equal(result.isError, undefined);
    assert.deepEqual(JSON.parse(result.content[0].text), { items: [], count: 0 });
  });
});

describe('default project and workspace resolution', () => {
  it('injects HULY_PROJECT only for project-scoped tools that omit it', async () => {
    const recorder = createClientRecorder();
    await withPooledClient(recorder.client, async () => {
      await handleToolCall('list_issues', {});
      await handleToolCall('list_issues', { project: 'EXPLICIT' });
      await handleToolCall('search_issues', { query: 'auth' });
    });

    assert.deepEqual(recorder.calls.map(call => call.method),
      ['listIssues', 'listIssues', 'searchIssues']);
    assert.equal(recorder.calls[0].args[0], 'DEF');
    assert.equal(recorder.calls[1].args[0], 'EXPLICIT');
    assert.equal(recorder.calls[2].args[1], undefined,
      'search_issues is not project-scoped and must not inherit HULY_PROJECT');
  });

  it('falls back to HULY_WORKSPACE when the call omits a workspace', async () => {
    const recorder = createClientRecorder();
    const workspaces = [];
    await withPooledClient(recorder.client, async () => {
      await handleToolCall('list_labels', {});
      await handleToolCall('list_labels', { workspace: 'other-ws' });
    }, workspaces);

    assert.deepEqual(workspaces, ['ws-default', 'other-ws']);
  });

  it('passes the configured URL and credentials to account tools without connecting a pool client', async () => {
    const calls = await withRecordedStatics(() =>
      withPooledClient(new Error('account tools must not open a workspace connection'), () =>
        handleToolCall('get_workspace_info', { workspace: 'ws-target' })));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'getWorkspaceInfo');
    assert.deepEqual(calls[0].args, [
      'huly-host-without-scheme',
      { email: 'user@example.test', password: undefined },
      'ws-target'
    ]);
  });

  it('rejects an unknown tool name', async () => {
    await assert.rejects(
      () => handleToolCall('definitely_not_a_tool', {}),
      /Unknown tool: definitely_not_a_tool/
    );
  });
});

// ════════════════════════════════════════════════════════════════
// 5. MCP resource handlers
// ════════════════════════════════════════════════════════════════

describe('MCP resource handlers', () => {
  const readResource = (server, uri) =>
    handlerFor(server, 'resources/read')({ method: 'resources/read', params: { uri } }, {});
  const listResources = server =>
    handlerFor(server, 'resources/list')({ method: 'resources/list', params: {} }, {});

  it('advertises both resource templates', async () => {
    const { server } = createMcpServer();
    const result = await handlerFor(server, 'resources/templates/list')(
      { method: 'resources/templates/list', params: {} }, {});

    assert.deepEqual(result.resourceTemplates.map(template => template.uriTemplate), [
      'huly://projects/{identifier}',
      'huly://issues/{issueId}'
    ]);
    for (const template of result.resourceTemplates) {
      assert.equal(template.mimeType, 'application/json');
      assert.ok(template.name);
      assert.ok(template.description);
    }
  });

  it('maps projects to resource entries', async () => {
    const { server } = createMcpServer();
    const recorder = createClientRecorder({
      listProjects: { items: [{ identifier: 'PROJ', name: 'Platform', issueCount: 12 }] }
    });

    const result = await withPooledClient(recorder.client, () => listResources(server));

    assert.deepEqual(result, {
      resources: [{
        uri: 'huly://projects/PROJ',
        name: 'PROJ: Platform',
        description: 'Project with 12 issues',
        mimeType: 'application/json'
      }]
    });
    assert.equal(recorder.calls[0].method, 'listProjects');
  });

  it('degrades to an empty resource list and logs when the workspace is unreachable', async () => {
    const { server } = createMcpServer();
    const { lines, value } = await captureStderr(() =>
      withPooledClient(new Error('connect ECONNREFUSED 127.0.0.1:8087'), () => listResources(server)));

    assert.deepEqual(value, { resources: [] });
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^ListResources failed: connect ECONNREFUSED/);
  });

  it('reads a project resource', async () => {
    const { server } = createMcpServer();
    const project = { identifier: 'PROJ', name: 'Platform', issueCount: 12 };
    const recorder = createClientRecorder({ getProject: project });

    const result = await withPooledClient(recorder.client, () =>
      readResource(server, 'huly://projects/PROJ'));

    assert.deepEqual(recorder.calls, [{ method: 'getProject', args: ['PROJ'] }]);
    assert.equal(result.contents.length, 1);
    assert.equal(result.contents[0].uri, 'huly://projects/PROJ');
    assert.equal(result.contents[0].mimeType, 'application/json');
    assert.equal(result.contents[0].text, JSON.stringify(project, null, 2));
  });

  it('reads an issue resource', async () => {
    const { server } = createMcpServer();
    const issue = { identifier: 'PROJ-42', title: 'Fix dispatch' };
    const recorder = createClientRecorder({ getIssue: issue });

    const result = await withPooledClient(recorder.client, () =>
      readResource(server, 'huly://issues/PROJ-42'));

    assert.deepEqual(recorder.calls, [{ method: 'getIssue', args: ['PROJ-42'] }]);
    assert.equal(result.contents[0].text, JSON.stringify(issue, null, 2));
  });

  it('rejects malformed and traversal-style resource URIs before touching the client', async () => {
    const { server } = createMcpServer();
    const rejected = [
      'huly://projects/../../etc/passwd',
      'huly://projects/PROJ/../OTHER',
      'huly://projects/PROJ%2F..',
      'huly://projects/PROJ?workspace=other',
      'huly://projects/PROJ\n',
      'huly://projects/',
      'huly://projects/PROJ/issues/1',
      'huly://issues/PROJ-42/../../projects/OTHER',
      'huly://issues/PROJ-42abc',
      'huly://issues/PROJ',
      'file:///etc/passwd',
      'https://huly.example.test/projects/PROJ',
      'prefix-huly://projects/PROJ'
    ];
    const recorder = createClientRecorder();

    await withPooledClient(recorder.client, async () => {
      for (const uri of rejected) {
        await assert.rejects(
          () => readResource(server, uri),
          error => {
            assert.match(error.message, /Unknown resource URI/);
            assert.ok(error.message.includes(uri.trim()));
            return true;
          },
          `resource URI ${JSON.stringify(uri)} must be rejected`
        );
      }
    });

    assert.deepEqual(recorder.calls, [], 'a rejected URI must never reach the Huly client');
  });
});

// ════════════════════════════════════════════════════════════════
// 6. Dispatch routing — every handler invoked
// ════════════════════════════════════════════════════════════════

const ACCOUNT_URL = 'https://account.example.test';
const ACCOUNT_CREDS = Object.freeze({ token: 'account-token' });

const ACCOUNT_ROUTES = [
  { name: 'list_workspaces', method: 'listWorkspaces', args: {}, rest: [] },
  { name: 'get_workspace_info', method: 'getWorkspaceInfo', args: { workspace: 'ws' }, rest: ['ws'] },
  { name: 'create_workspace', method: 'createWorkspace', args: { name: 'Acme' }, rest: ['Acme'] },
  {
    name: 'update_workspace_name',
    method: 'updateWorkspaceName',
    args: { workspace: 'ws', name: 'Acme' },
    rest: ['ws', 'Acme']
  },
  { name: 'delete_workspace', method: 'deleteWorkspace', args: { workspace: 'ws' }, rest: ['ws'] },
  { name: 'get_workspace_members', method: 'getWorkspaceMembers', args: { workspace: 'ws' }, rest: ['ws'] },
  {
    name: 'update_workspace_role',
    method: 'updateWorkspaceRole',
    args: { workspace: 'ws', email: 'member@example.test', role: 'MAINTAINER' },
    rest: ['ws', 'member@example.test', 'MAINTAINER']
  },
  { name: 'get_account_info', method: 'getAccountInfo', args: {}, rest: [] },
  { name: 'get_user_profile', method: 'getUserProfile', args: {}, rest: [] },
  {
    name: 'set_my_profile',
    method: 'setMyProfile',
    args: { name: 'Ada', city: 'London', country: 'UK' },
    rest: ['Ada', 'London', 'UK']
  },
  { name: 'change_password', method: 'changePassword', args: { newPassword: 'pw-new' }, rest: ['pw-new'] },
  {
    name: 'change_username',
    method: 'changeUsername',
    args: { firstName: 'Ada', lastName: 'Lovelace' },
    rest: ['Ada', 'Lovelace']
  },
  {
    name: 'send_invite',
    method: 'sendInvite',
    args: { workspace: 'ws', email: 'invitee@example.test', role: 'MEMBER' },
    rest: ['ws', 'invitee@example.test', 'MEMBER']
  },
  {
    name: 'resend_invite',
    method: 'resendInvite',
    args: { workspace: 'ws', email: 'invitee@example.test', role: 'GUEST' },
    rest: ['ws', 'invitee@example.test', 'GUEST']
  },
  {
    name: 'create_invite_link',
    method: 'createInviteLink',
    args: {
      workspace: 'ws', email: 'invitee@example.test', role: 'MEMBER',
      firstName: 'Ada', lastName: 'Lovelace', expireHours: 12
    },
    rest: ['ws', 'invitee@example.test', 'MEMBER', 'Ada', 'Lovelace', 12]
  },
  {
    name: 'list_integrations',
    method: 'listIntegrations',
    args: { filter: { kind: 'github' } },
    rest: [{ kind: 'github' }]
  },
  {
    name: 'get_integration',
    method: 'getIntegration',
    args: { socialId: 'sid', kind: 'github', workspaceUuid: 'uuid' },
    rest: [{ socialId: 'sid', kind: 'github', workspaceUuid: 'uuid' }]
  },
  {
    name: 'create_integration',
    method: 'createIntegration',
    args: { socialId: 'sid', kind: 'github', workspaceUuid: 'uuid', data: { repo: 'acme' }, disabled: false },
    rest: [{ socialId: 'sid', kind: 'github', workspaceUuid: 'uuid', data: { repo: 'acme' }, disabled: false }]
  },
  {
    name: 'update_integration',
    method: 'updateIntegration',
    args: { socialId: 'sid', kind: 'github', workspaceUuid: 'uuid', data: { repo: 'acme' }, disabled: true },
    rest: [{ socialId: 'sid', kind: 'github', workspaceUuid: 'uuid', data: { repo: 'acme' }, disabled: true }]
  },
  {
    name: 'delete_integration',
    method: 'deleteIntegration',
    args: { socialId: 'sid', kind: 'github', workspaceUuid: 'uuid' },
    rest: [{ socialId: 'sid', kind: 'github', workspaceUuid: 'uuid' }]
  },
  { name: 'list_mailboxes', method: 'getMailboxes', args: {}, rest: [] },
  {
    name: 'create_mailbox',
    method: 'createMailbox',
    args: { name: 'support', domain: 'example.test' },
    rest: ['support', 'example.test']
  },
  { name: 'delete_mailbox', method: 'deleteMailbox', args: { mailboxId: 'mb-1' }, rest: ['mb-1'] },
  {
    name: 'find_person_by_social_key',
    method: 'findPersonBySocialKey',
    args: { socialKey: 'email:ada@example.test' },
    rest: ['email:ada@example.test']
  },
  { name: 'get_social_ids', method: 'getSocialIds', args: {}, rest: [] },
  {
    name: 'add_email_social_id',
    method: 'addEmailSocialId',
    args: { targetEmail: 'ada@example.test' },
    rest: ['ada@example.test']
  },
  { name: 'list_subscriptions', method: 'getSubscriptions', args: {}, rest: [] }
];

const WORKSPACE_ROUTES = {
  list_projects: 'listProjects',
  get_project: 'getProject',
  list_issues: 'listIssues',
  get_issue: 'getIssue',
  create_issue: 'createIssue',
  update_issue: 'updateIssue',
  delete_issue: 'deleteIssue',
  search_issues: 'searchIssues',
  get_my_issues: 'getMyIssues',
  batch_create_issues: 'batchCreateIssues',
  move_issue: 'moveIssue',
  create_issues_from_template: 'createIssuesFromTemplate',
  summarize_project: 'summarizeProject',
  add_label: 'addLabel',
  remove_label: 'removeLabel',
  list_labels: 'listLabels',
  create_label: 'createLabel',
  update_label: 'updateLabel',
  delete_label: 'deleteLabel',
  add_relation: 'addRelation',
  add_blocked_by: 'addBlockedBy',
  set_parent: 'setParent',
  list_project_types: 'listProjectTypes',
  list_task_types: 'listTaskTypes',
  list_statuses: 'listStatuses',
  list_milestones: 'listMilestones',
  get_milestone: 'getMilestone',
  create_milestone: 'createMilestone',
  set_milestone: 'setMilestone',
  update_milestone: 'updateMilestone',
  delete_milestone: 'deleteMilestone',
  list_members: 'listMembers',
  add_comment: 'addComment',
  list_comments: 'listComments',
  update_comment: 'updateComment',
  delete_comment: 'deleteComment',
  log_time: 'logTime',
  list_time_reports: 'listTimeReports',
  delete_time_report: 'deleteTimeReport',
  create_project: 'createProject',
  update_project: 'updateProject',
  archive_project: 'archiveProject',
  delete_project: 'deleteProject',
  list_components: 'listComponents',
  create_component: 'createComponent',
  update_component: 'updateComponent',
  delete_component: 'deleteComponent',
  get_label: 'getLabel',
  get_member: 'getMember',
  get_status: 'getStatus',
  get_component: 'getComponent',
  get_task_type: 'getTaskType',
  get_comment: 'getComment',
  get_time_report: 'getTimeReport'
};

describe('dispatch routing — every handler reaches its client method', () => {
  it('declares a routing expectation for every dispatch entry', () => {
    assert.deepEqual(
      Object.keys(accountTools).sort(),
      ACCOUNT_ROUTES.map(route => route.name).sort()
    );
    assert.deepEqual(
      Object.keys(workspaceTools).sort(),
      Object.keys(WORKSPACE_ROUTES).sort()
    );
  });

  it('invokes every account tool with the exact static method and argument order', async () => {
    for (const route of ACCOUNT_ROUTES) {
      const calls = await withRecordedStatics(() =>
        accountTools[route.name](route.args, ACCOUNT_URL, ACCOUNT_CREDS));

      assert.equal(calls.length, 1, `${route.name}: expected exactly 1 HulyClient static call`);
      assert.equal(calls[0].method, route.method,
        `${route.name} routed to HulyClient.${calls[0].method}() instead of ${route.method}()`);
      assert.deepEqual(calls[0].args, [ACCOUNT_URL, ACCOUNT_CREDS, ...route.rest],
        `${route.name}: argument order or values changed`);
    }
  });

  it('invokes every workspace tool with the expected client method and no internal args', async () => {
    const { TOOLS } = createMcpServer();
    const schemas = new Map(TOOLS.map(tool => [tool.name, tool.inputSchema]));
    const PROFILE_LEAK = '__PROFILE_LEAK__';

    for (const [name, expectedMethod] of Object.entries(WORKSPACE_ROUTES)) {
      const schema = schemas.get(name);
      assert.ok(schema, `${name}: not advertised by the MCP server`);
      const args = { ...buildArgs(schema), __responseMode: 'compact', __toolProfile: PROFILE_LEAK };
      const recorder = createClientRecorder();

      await workspaceTools[name](args, recorder.client);

      assert.equal(recorder.calls.length, 1, `${name}: expected exactly 1 client call`);
      assert.equal(recorder.calls[0].method, expectedMethod,
        `${name} routed to client.${recorder.calls[0].method}() instead of ${expectedMethod}()`);
      assert.equal(deepContains(recorder.calls[0].args, PROFILE_LEAK), false,
        `${name} forwarded the internal tool profile to the client`);
      assert.equal(deepHasKey(recorder.calls[0].args, '__toolProfile'), false,
        `${name} forwarded the internal __toolProfile key to the client`);
      assert.equal(deepHasKey(recorder.calls[0].args, '__responseMode'), false,
        `${name} forwarded the raw __responseMode key to the client`);
    }
  });

  it('reads the relation argument each tool names, not a neighbouring one', async () => {
    const decoys = { issueId: 'P-1', relatedIssueId: 'DECOY-R', blockerIssueId: 'DECOY-B', parentId: 'DECOY-P' };
    const cases = [
      { name: 'add_relation', method: 'addRelation', override: { relatedIssueId: 'P-2' }, expected: ['P-1', 'P-2'] },
      { name: 'add_blocked_by', method: 'addBlockedBy', override: { blockerIssueId: 'P-3' }, expected: ['P-1', 'P-3'] },
      { name: 'set_parent', method: 'setParent', override: { parentId: 'P-4' }, expected: ['P-1', 'P-4'] }
    ];

    for (const testCase of cases) {
      const recorder = createClientRecorder();
      await workspaceTools[testCase.name]({ ...decoys, ...testCase.override }, recorder.client);

      assert.equal(recorder.calls[0].method, testCase.method);
      assert.deepEqual(recorder.calls[0].args, testCase.expected,
        `${testCase.name} read the wrong relation argument`);
    }
  });
});
