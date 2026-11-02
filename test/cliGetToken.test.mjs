import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('--get-token', () => {
  it('reports a login failure as one message and exit code 1, not a stack trace', () => {
    // Nothing listens on port 9, so loading the server config fails.
    const run = spawnSync(process.execPath, [
      'src/index.mjs', '--get-token', '-e', 'user@example.test', '-p', 'pw', '-u', 'http://127.0.0.1:9'
    ], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 30000 });

    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^Failed to get a token: /m);
    assert.doesNotMatch(run.stderr, /^\s+at /m, 'no stack trace');
  });
});
