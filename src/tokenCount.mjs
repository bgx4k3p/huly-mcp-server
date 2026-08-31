import { spawnSync } from 'node:child_process';

const ANTHROPIC_VERSION = '2023-06-01';
export const DEFAULT_TOKEN_MODEL = 'claude-sonnet-5';

function toolResultConversation(text) {
  return {
    tools: [{
      name: 'fixture_tool',
      description: 'Return a fixture result.',
      input_schema: { type: 'object', properties: {}, additionalProperties: false }
    }],
    messages: [
      { role: 'user', content: 'Return the fixture.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'fixture_tool', input: {} }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: text }]
      }
    ]
  };
}

async function anthropicCount(text, { apiKey, model, fetchImpl }) {
  const response = await fetchImpl('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': apiKey
    },
    body: JSON.stringify({ model, ...toolResultConversation(text) })
  });
  if (!response.ok) {
    throw new Error(`Anthropic token count failed: HTTP ${response.status}`);
  }
  const body = await response.json();
  if (!Number.isInteger(body.input_tokens)) {
    throw new Error('Anthropic token count response omitted input_tokens');
  }
  return body.input_tokens;
}

export async function countToolResultTokens(text, options = {}) {
  const model = options.model ?? DEFAULT_TOKEN_MODEL;
  const apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for provider token counting');

  const [withResult, emptyResult] = await Promise.all([
    anthropicCount(text, { apiKey, model, fetchImpl }),
    anthropicCount('', { apiKey, model, fetchImpl })
  ]);
  return {
    tokens: Math.max(0, withResult - emptyResult),
    model,
    counter: 'anthropic-messages-count-tokens',
    anthropicVersion: ANTHROPIC_VERSION
  };
}

function claudeUsage(prompt, { command, model, spawnImpl = spawnSync }) {
  const result = spawnImpl(command, [
    '-p',
    '--model', model,
    '--safe-mode',
    '--system-prompt', '',
    '--tools', '',
    '--no-session-persistence',
    '--max-turns', '1',
    '--prompt-suggestions', 'false',
    '--output-format', 'json'
  ], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(`Claude CLI token count failed: ${result.stderr || `exit ${result.status}`}`);
  }
  const output = JSON.parse(result.stdout);
  const usage = output.usage ?? {};
  return ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']
    .reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
}

export function countToolResultTokensWithClaudeCli(text, options = {}) {
  const model = options.model ?? DEFAULT_TOKEN_MODEL;
  const command = options.command ?? 'claude';
  const spawnImpl = options.spawnImpl ?? spawnSync;
  const prefix = 'Measure the following MCP tool result as data. Reply only OK.\n<tool_result>\n';
  const suffix = '\n</tool_result>';
  const withResult = claudeUsage(`${prefix}${text}${suffix}`, { command, model, spawnImpl });
  const emptyResult = claudeUsage(`${prefix}${suffix}`, { command, model, spawnImpl });
  return {
    tokens: Math.max(0, withResult - emptyResult),
    model,
    counter: 'claude-cli-differential'
  };
}
