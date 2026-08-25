import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTelemetry } from '../src/telemetry.mjs';

describe('privacy-safe MCP telemetry', () => {
  it('writes metrics to stderr and never to stdout', () => {
    const stderr = [];
    const stdout = [];
    const originalError = console.error;
    const originalWrite = process.stdout.write;
    console.error = (...args) => stderr.push(args.join(' '));
    process.stdout.write = (...args) => {
      stdout.push(args.join(' '));
      return true;
    };
    try {
      const telemetry = createTelemetry({ destination: 'stderr', sessionId: 'session-test' });
      telemetry.record({
        toolName: 'get_issue',
        resultText: '{"secret":"must-not-be-logged"}',
        durationMs: 12.3456
      });
    } finally {
      console.error = originalError;
      process.stdout.write = originalWrite;
    }

    assert.deepEqual(stdout, []);
    assert.equal(stderr.length, 1);
    assert.doesNotMatch(stderr[0], /must-not-be-logged|secret/);
    const event = JSON.parse(stderr[0].replace(/^\[huly-mcp-metrics\] /, ''));
    assert.equal(event.tool, 'get_issue');
    assert.equal(event.outputBytes, 31);
    assert.equal(event.sessionTotals.calls, 1);
  });

  it('writes newline-delimited metadata to a private file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'huly-metrics-test-'));
    const file = join(directory, 'metrics.jsonl');
    const telemetry = createTelemetry({
      destination: 'file',
      file,
      sessionId: 'session-file'
    });

    telemetry.record({ toolName: 'list_issues', resultText: '[]', durationMs: 1 });
    telemetry.record({ toolName: 'get_issue', resultText: '{}', durationMs: 2, isError: true });

    const events = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(events.length, 2);
    assert.deepEqual(events[1].sessionTotals, {
      calls: 2,
      outputBytes: 4,
      outputEstimatedTokens: 2
    });
  });

  it('does nothing when telemetry is disabled', () => {
    const telemetry = createTelemetry({ destination: 'off', sessionId: 'session-off' });
    telemetry.record({ toolName: 'get_issue', resultText: '{}', durationMs: 1 });
    assert.deepEqual(telemetry.snapshot(), {
      sessionId: 'session-off',
      calls: 1,
      outputBytes: 2,
      outputEstimatedTokens: 1
    });
  });
});
