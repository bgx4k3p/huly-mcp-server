/**
 * stdio carries JSON-RPC on stdout, so nothing else may ever be written there.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('stdio stdout guard', () => {
  it('is the first module the stdio entry point loads', () => {
    // ESM evaluates imports in order, so the guard is installed before any SDK module can print.
    const source = readFileSync(new URL('../src/mcp.mjs', import.meta.url), 'utf8');
    const firstImport = source.match(/^import\s+(?:[^'"]*from\s+)?['"]([^'"]+)['"]/m);
    assert.equal(firstImport?.[1], './stdioConsole.mjs');
  });

  it('routes console.log and console.info to stderr', () => {
    const run = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      "await import('./src/stdioConsole.mjs'); console.log('log-line'); console.info('info-line');"
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /log-line/);
    assert.match(run.stderr, /info-line/);
  });

  it('writes only JSON-RPC messages to stdout during a session', async () => {
    const child = spawn(process.execPath, ['src/index.mjs'], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HULY_URL: 'https://huly.example.test',
        HULY_TOKEN: 'test-token',
        HULY_WORKSPACE: 'test-workspace'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no tools/list reply; stdout so far: ${stdout}`)), 30000);
      child.stdout.on('data', () => {
        if (stdout.includes('"id":2')) { clearTimeout(timer); resolve(); }
      });
    });
    child.kill();

    const lines = stdout.split('\n').filter(line => line.trim() !== '');
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.equal(JSON.parse(line).jsonrpc, '2.0', `non-JSON-RPC stdout line: ${line}`);
    }
  });
});
