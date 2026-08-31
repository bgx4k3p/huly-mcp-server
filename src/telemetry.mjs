import crypto from 'node:crypto';
import { appendFileSync } from 'node:fs';

const METRIC_PREFIX = '[huly-mcp-metrics] ';

function byteLength(value) {
  return Buffer.byteLength(value ?? '', 'utf8');
}

export function createTelemetry(options = {}) {
  const destination = options.destination ?? process.env.HULY_METRICS ?? 'off';
  const metricsFile = options.file ?? process.env.HULY_METRICS_FILE;
  const sessionId = options.sessionId ?? crypto.randomUUID();
  let sequence = 0;
  let totalCalls = 0;
  let totalBytes = 0;
  let estimatedTokens = 0;

  function emit(event) {
    if (destination === 'off') return;
    const line = JSON.stringify(event);
    if (destination === 'stderr') {
      console.error(`${METRIC_PREFIX}${line}`);
      return;
    }
    if (destination === 'file') {
      if (!metricsFile) throw new Error('HULY_METRICS_FILE is required when HULY_METRICS=file');
      appendFileSync(metricsFile, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
      return;
    }
    throw new Error(`Unsupported HULY_METRICS destination: ${destination}`);
  }

  function record({ toolName, resultText, durationMs, responseMode = 'compact', isError = false }) {
    try {
      const outputBytes = byteLength(resultText);
      const outputEstimatedTokens = Math.ceil(outputBytes / 4);
      sequence += 1;
      totalCalls += 1;
      totalBytes += outputBytes;
      estimatedTokens += outputEstimatedTokens;
      emit({
        schemaVersion: 1,
        kind: 'huly_mcp_tool_result',
        sessionId,
        sequence,
        tool: toolName,
        responseMode,
        outputBytes,
        outputEstimatedTokens,
        durationMs: Math.max(0, Math.round(durationMs * 1000) / 1000),
        isError,
        sessionTotals: {
          calls: totalCalls,
          outputBytes: totalBytes,
          outputEstimatedTokens: estimatedTokens
        }
      });
    } catch (error) {
      // Telemetry must never fail a tool call or write to stdout.
      console.error(`[huly-mcp] metrics disabled after error: ${error.message}`);
    }
  }

  function snapshot() {
    return {
      sessionId,
      calls: totalCalls,
      outputBytes: totalBytes,
      outputEstimatedTokens: estimatedTokens
    };
  }

  return { record, snapshot };
}
