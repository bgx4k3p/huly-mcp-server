import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { countToolResultTokens } from '../src/tokenCount.mjs';

describe('Claude provider token counting', () => {
  it('subtracts the empty tool-result framing cost', async () => {
    const bodies = [];
    const counts = [125, 100];
    const result = await countToolResultTokens('fixture result', {
      apiKey: 'test-key',
      model: 'claude-test-pinned',
      fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(init.body));
        return {
          ok: true,
          json: async () => ({ input_tokens: counts.shift() })
        };
      }
    });

    assert.equal(result.tokens, 25);
    assert.equal(result.model, 'claude-test-pinned');
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].messages[2].content[0].content, 'fixture result');
    assert.equal(bodies[1].messages[2].content[0].content, '');
  });

  it('requires an API key for the provider counter', async () => {
    await assert.rejects(
      () => countToolResultTokens('fixture', { apiKey: '' }),
      /ANTHROPIC_API_KEY/
    );
  });
});
