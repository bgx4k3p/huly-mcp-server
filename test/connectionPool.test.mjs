import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
  'HULY_URL', 'HULY_TOKEN', 'HULY_EMAIL', 'HULY_PASSWORD', 'HULY_WORKSPACE', 'HULY_PROJECT',
  'HULY_POOL_TTL_MS', 'PORT', 'MCP_AUTH_TOKEN', 'ALLOWED_ORIGINS', 'HULY_RATE_LIMIT'
];

/** Swap in an environment, returning the previous values so it can be put back. */
function applyEnv(env) {
  const saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

// config.mjs snapshots the environment once, at load. Pinning it here — and
// notably leaving HULY_WORKSPACE unset — keeps the pool's "no workspace
// configured" path reachable whatever the developer has exported. The ambient
// environment goes back as soon as the module graph is loaded.
const ambient = applyEnv({
  HULY_URL: 'https://huly.example.test',
  HULY_TOKEN: 'unit-token',
  HULY_POOL_TTL_MS: '60000',
  PORT: '8080',
  MCP_AUTH_TOKEN: 'mcp-secret',
  ALLOWED_ORIGINS: 'https://origin.example.test',
  HULY_RATE_LIMIT: '25'
});
const { ConnectionPool } = await import('../src/pool.mjs');
const { HulyClient } = await import('../src/client.mjs');
const {
  HULY_URL, HULY_TOKEN, HULY_EMAIL, HULY_PASSWORD, HULY_WORKSPACE,
  POOL_TTL_MS, POOL_CLEANUP_INTERVAL_MS
} = await import('../src/config.mjs');
restoreEnv(ambient);

const require = createRequire(import.meta.url);
const tracker = require('@hcengineering/tracker').default;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Replace the only two HulyClient methods that touch the network. */
function stubTransport({ onConnect } = {}) {
  const connects = [];
  const disconnects = [];
  const originalConnect = HulyClient.prototype.connect;
  const originalDisconnect = HulyClient.prototype.disconnect;

  HulyClient.prototype.connect = async function stubbedConnect() {
    connects.push(this);
    await onConnect?.(this, connects.length);
  };
  HulyClient.prototype.disconnect = function stubbedDisconnect() {
    disconnects.push(this);
  };

  return {
    connects,
    disconnects,
    restore() {
      HulyClient.prototype.connect = originalConnect;
      HulyClient.prototype.disconnect = originalDisconnect;
    }
  };
}

/** Run against an isolated pool with the transport stubbed and warnings captured. */
async function withPool(run, options = {}) {
  const transport = stubTransport(options);
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  const pool = new ConnectionPool();
  try {
    return await run({ pool, warnings, connects: transport.connects, disconnects: transport.disconnects });
  } finally {
    pool.clearAll();
    console.warn = originalWarn;
    transport.restore();
  }
}

/** Freeze Date.now so TTL boundaries are exact instead of racing the real clock. */
async function withFrozenClock(start, run) {
  const original = Date.now;
  const clock = { now: start };
  Date.now = () => clock.now;
  try {
    return await run(clock);
  } finally {
    Date.now = original;
  }
}

describe('ConnectionPool cleanup timer', () => {
  function captureTimers(handleFor) {
    const intervals = [];
    const cleared = [];
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    globalThis.setInterval = (fn, ms) => {
      const handle = handleFor(intervals.length);
      intervals.push({ fn, ms, handle });
      return handle;
    };
    globalThis.clearInterval = handle => cleared.push(handle);
    return {
      intervals,
      cleared,
      restore() {
        globalThis.setInterval = originalSet;
        globalThis.clearInterval = originalClear;
      }
    };
  }

  it('registers an unrefd sweep on the configured interval and cancels it in clearAll', async () => {
    let unrefs = 0;
    // The second pool receives a bare timer id, as a host without unref() would return.
    const timers = captureTimers(index => (index === 0 ? { unref: () => { unrefs += 1; } } : 42));
    const transport = stubTransport();
    const originalWarn = console.warn;
    console.warn = () => {};

    try {
      const pool = new ConnectionPool();
      assert.equal(timers.intervals.length, 1);
      assert.equal(timers.intervals[0].ms, POOL_CLEANUP_INTERVAL_MS);
      assert.equal(unrefs, 1, 'the sweep timer must never hold the process open');

      const client = await pool.getClient('ws-timer');
      pool._entries.get('ws-timer').lastUsed = Date.now() - POOL_TTL_MS - 1;
      timers.intervals[0].fn();

      assert.deepEqual(transport.disconnects, [client], 'the registered callback must run the stale sweep');
      assert.equal(pool._entries.size, 0);

      pool.clearAll();
      assert.deepEqual(timers.cleared, [timers.intervals[0].handle],
        'clearAll must cancel the exact handle it created');

      assert.doesNotThrow(() => new ConnectionPool(), 'a timer id without unref() must not break construction');
    } finally {
      console.warn = originalWarn;
      timers.restore();
      transport.restore();
    }
  });
});

describe('ConnectionPool.getClient', () => {
  it('refuses an unresolvable workspace instead of connecting to a nameless one', async () => {
    await withPool(async ({ pool, connects }) => {
      const message = /No workspace specified and HULY_WORKSPACE env var is not set/;
      await assert.rejects(() => pool.getClient(), message);
      await assert.rejects(() => pool.getClient(''), message);
      assert.deepEqual(connects, [], 'no connection may be opened without a workspace');
      assert.equal(pool._entries.size, 0, 'a rejected lookup must not leave an entry behind');
    });
  });

  it('builds each client from the shared config and caches it per workspace', async () => {
    await withPool(async ({ pool, connects }) => {
      const a = await pool.getClient('ws-a');
      const b = await pool.getClient('ws-b');

      assert.equal(connects.length, 2);
      assert.notEqual(a, b, 'distinct workspaces must not share a connection');
      assert.equal(a.workspace, 'ws-a');
      assert.equal(b.workspace, 'ws-b');
      assert.equal(a.url, HULY_URL);
      assert.equal(a.token, HULY_TOKEN || null);
      assert.equal(a.email, HULY_EMAIL || null);
      assert.equal(a.password, HULY_PASSWORD || null);
      assert.deepEqual([...pool._entries.keys()], ['ws-a', 'ws-b']);
    });
  });

  it('serves the cached client and extends its idle deadline', async () => {
    await withPool(async ({ pool, connects, disconnects }) => {
      const first = await pool.getClient('ws-a');
      const entry = pool._entries.get('ws-a');
      entry.lastUsed = Date.now() - Math.floor(POOL_TTL_MS / 2);
      const before = entry.lastUsed;

      assert.equal(await pool.getClient('ws-a'), first);
      assert.equal(connects.length, 1, 'a live entry must never reconnect');
      assert.deepEqual(disconnects, []);
      assert.ok(entry.lastUsed > before, 'a cache hit must push the TTL window forward');
    });
  });

  it('collapses concurrent callers onto a single connection', async () => {
    const gate = deferred();
    await withPool(async ({ pool, connects }) => {
      const first = pool.getClient('ws-a');
      const second = pool.getClient('ws-a');
      const third = pool.getClient('ws-a');
      assert.equal(connects.length, 1, 'later callers must join the in-flight connect, not open their own');

      gate.resolve();
      const [a, b, c] = await Promise.all([first, second, third]);

      assert.equal(a, b);
      assert.equal(b, c);
      assert.equal(connects.length, 1);
      assert.equal(pool._entries.size, 1);
      const entry = pool._entries.get('ws-a');
      assert.equal(entry.client, a);
      assert.equal(entry.connecting, null, 'the settled entry must release the shared promise');
    }, { onConnect: () => gate.promise });
  });

  it('removes the entry when a connect fails so the next caller retries', async () => {
    let attempt = 0;
    await withPool(async ({ pool, connects }) => {
      await assert.rejects(() => pool.getClient('ws-a'), /transport refused/);
      assert.equal(pool._entries.has('ws-a'), false, 'a failed connect must not poison the cache');

      const client = await pool.getClient('ws-a');
      assert.equal(connects.length, 2, 'the retry must be a fresh connect, not a replayed rejection');
      assert.equal(pool._entries.get('ws-a').client, client);
    }, {
      onConnect: () => {
        attempt += 1;
        if (attempt === 1) throw new Error('transport refused');
      }
    });
  });

  it('fails every concurrent caller of a broken connect and leaves no entry behind', async () => {
    const gate = deferred();
    await withPool(async ({ pool, connects }) => {
      const settled = Promise.allSettled([pool.getClient('ws-a'), pool.getClient('ws-a')]);
      gate.reject(new Error('handshake timeout'));
      const results = await settled;

      assert.deepEqual(results.map(result => result.status), ['rejected', 'rejected']);
      for (const result of results) assert.match(result.reason.message, /handshake timeout/);
      assert.equal(connects.length, 1);
      assert.equal(pool._entries.size, 0, 'the shared failure must clear the shared entry');
    }, { onConnect: () => gate.promise });
  });

  it('treats the TTL edge as live and evicts one millisecond past it', async () => {
    await withPool(async ({ pool, connects, disconnects, warnings }) => {
      await withFrozenClock(1_000_000, async clock => {
        const first = await pool.getClient('ws-a');

        clock.now += POOL_TTL_MS;
        assert.equal(await pool.getClient('ws-a'), first, 'the TTL boundary itself is still a cache hit');
        assert.deepEqual(disconnects, []);

        clock.now += POOL_TTL_MS + 1;
        const second = await pool.getClient('ws-a');

        assert.notEqual(second, first);
        assert.deepEqual(disconnects, [first], 'a stale client must be disconnected, not merely dropped');
        assert.equal(connects.length, 2);
        assert.equal(pool._entries.get('ws-a').client, second, 'the replacement must be the cached one');
        assert.match(warnings.join('\n'), /ws-a/);
      });
    });
  });
});

describe('ConnectionPool.clearClient', () => {
  it('disconnects and forgets only the named workspace', async () => {
    await withPool(async ({ pool, connects, disconnects }) => {
      const a = await pool.getClient('ws-a');
      const b = await pool.getClient('ws-b');

      pool.clearClient('ws-a');
      assert.deepEqual(disconnects, [a]);
      assert.deepEqual([...pool._entries.keys()], ['ws-b']);
      assert.equal(await pool.getClient('ws-b'), b, 'an untouched workspace keeps its connection');

      const reconnected = await pool.getClient('ws-a');
      assert.notEqual(reconnected, a, 'a cleared workspace must get a new client');
      assert.equal(connects.length, 3);
    });
  });

  it('ignores a workspace that was never connected', async () => {
    await withPool(async ({ pool, disconnects }) => {
      await pool.getClient('ws-a');
      pool.clearClient('ws-never-seen');
      assert.deepEqual(disconnects, []);
      assert.equal(pool._entries.size, 1);
    });
  });

  it('is a silent no-op when the workspace cannot be resolved', async () => {
    await withPool(async ({ pool, disconnects }) => {
      assert.equal(HULY_WORKSPACE, undefined, 'the pinned environment must leave the default unset');
      pool.clearClient();
      assert.deepEqual(disconnects, [], 'clearing an unresolvable workspace must not throw or close anything');
    });
  });
});

describe('ConnectionPool.clearAll', () => {
  it('disconnects every cached client exactly once and empties the cache', async () => {
    await withPool(async ({ pool, disconnects }) => {
      const clients = [
        await pool.getClient('ws-a'),
        await pool.getClient('ws-b'),
        await pool.getClient('ws-c')
      ];

      pool.clearAll();
      assert.equal(disconnects.length, 3, 'no client may be closed twice or skipped');
      assert.deepEqual(new Set(disconnects), new Set(clients));
      assert.equal(pool._entries.size, 0);

      pool.clearAll();
      assert.equal(disconnects.length, 3, 'a second clearAll must be a no-op');
    });
  });
});

describe('ConnectionPool._evictStale', () => {
  it('sweeps the idle entries and spares a connect in flight', async () => {
    const gate = deferred();
    await withPool(async ({ pool, disconnects, warnings }) => {
      const fresh = await pool.getClient('ws-fresh');
      const stale = await pool.getClient('ws-stale');
      const pending = pool.getClient('ws-pending');
      const expired = Date.now() - POOL_TTL_MS - 1;
      pool._entries.get('ws-stale').lastUsed = expired;
      pool._entries.get('ws-pending').lastUsed = expired;

      pool._evictStale();

      assert.deepEqual(disconnects, [stale], 'only the idle client may be disconnected');
      assert.deepEqual([...pool._entries.keys()], ['ws-fresh', 'ws-pending'],
        'an unfinished connect must survive the sweep');
      assert.equal(pool._entries.get('ws-fresh').client, fresh);
      assert.match(warnings.join('\n'), /ws-stale/);

      gate.resolve();
      assert.equal((await pending).workspace, 'ws-pending');
    }, { onConnect: (_client, attempt) => (attempt === 3 ? gate.promise : undefined) });
  });
});

function newClient(overrides = {}) {
  return new HulyClient({
    url: 'https://huly.example.test',
    token: 'unit-token',
    workspace: 'ws-primary',
    ...overrides
  });
}

describe('HulyClient.connect guards', () => {
  it('returns immediately when a client is already cached', async () => {
    const client = newClient({ token: undefined, workspace: undefined });
    client._client = { marker: 'live' };

    await client.connect();

    assert.deepEqual(client._client, { marker: 'live' }, 'a cached client must not be rebuilt');
    assert.equal(client._connectionPromise, null, 'the short circuit must not create a promise');
  });

  it('validates workspace and credentials before touching the network', async () => {
    await assert.rejects(() => newClient({ workspace: undefined }).connect(), /Missing required config: workspace/);
    await assert.rejects(() => newClient({ workspace: '' }).connect(), /Missing required config: workspace/);
    await assert.rejects(
      () => newClient({ token: undefined }).connect(),
      /Missing required auth: set HULY_TOKEN or HULY_EMAIL \+ HULY_PASSWORD/
    );
    await assert.rejects(() => newClient({ token: undefined, email: 'a@example.test' }).connect(),
      /Missing required auth/);
    await assert.rejects(() => newClient({ token: undefined, password: 'pw' }).connect(), /Missing required auth/);
  });

  it('clears the in-flight promise after a failure so the next attempt re-runs', async () => {
    const client = newClient();
    let reads = 0;
    Object.defineProperty(client, 'workspace', {
      configurable: true,
      get() {
        reads += 1;
        return undefined;
      }
    });

    await assert.rejects(() => client.connect(), /Missing required config: workspace/);
    assert.equal(client._connectionPromise, null, 'a rejected connect must not stay latched');
    await assert.rejects(() => client.connect(), /Missing required config: workspace/);
    assert.equal(reads, 2, 'the retry must re-run the connect body, not replay a cached rejection');
  });

  it('makes a joining caller wait on the in-flight connect instead of starting another', async () => {
    const client = newClient();
    const gate = deferred();
    client._connectionPromise = gate.promise;
    let settled = false;

    const joined = client.connect().then(() => { settled = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the joiner must not resolve before the connect it joined');
    assert.equal(client._connectionPromise, gate.promise, 'a joiner must not replace the shared promise');

    gate.resolve();
    await joined;
    assert.equal(settled, true);
    assert.equal(client._connectionPromise, gate.promise, 'only the owning caller resets the promise');
  });

  it('propagates the in-flight failure to a joining caller', async () => {
    const client = newClient();
    const gate = deferred();
    client._connectionPromise = gate.promise;

    const joined = client.connect();
    gate.reject(new Error('transactor unreachable'));

    await assert.rejects(() => joined, /transactor unreachable/);
    assert.equal(client._client, null, 'a failed join must not leave a half-built client');
  });
});

describe('HulyClient._getClient', () => {
  it('connects on demand and then serves the cached SDK client', async () => {
    const client = newClient();
    const sdk = { marker: 'sdk' };
    let connects = 0;
    client.connect = async () => {
      connects += 1;
      client._client = sdk;
    };

    assert.equal(await client._getClient(), sdk);
    assert.equal(connects, 1);
    assert.equal(await client._getClient(), sdk);
    assert.equal(connects, 1, 'a live client must not trigger another connect');
  });

  it('surfaces a connect failure rather than returning a null client', async () => {
    const client = newClient();
    client.connect = async () => { throw new Error('workspace not found'); };
    await assert.rejects(() => client._getClient(), /workspace not found/);
  });
});

describe('HulyClient collaborator fields', () => {
  function collabHarness() {
    const reads = [];
    const writes = [];
    const store = new Map();
    const client = newClient();
    client._collabClient = {
      async getMarkup(docRef, source) {
        reads.push({ docRef, source });
        return store.get(`${docRef.objectId}:${docRef.objectAttr}`) ?? '';
      },
      async updateMarkup(docRef, markup) {
        writes.push({ docRef, markup });
        store.set(`${docRef.objectId}:${docRef.objectAttr}`, markup);
      }
    };
    return { client, reads, writes };
  }

  it('refuses to read or write rich text before the collaborator client exists', async () => {
    const client = newClient();
    assert.equal(client._collabClient, null);
    await assert.rejects(
      () => client._readCollaboratorField('issue-1', tracker.class.Issue),
      /Collaborator client not initialized\. Cannot read rich text fields/
    );
    await assert.rejects(
      () => client._writeCollaboratorField('issue-1', tracker.class.Issue, 'text'),
      /Collaborator client not initialized\. Cannot write rich text fields/
    );
  });

  it('round-trips markdown through the document reference it was written to', async () => {
    const { client, reads, writes } = collabHarness();

    await client._writeCollaboratorField('issue-1', tracker.class.Issue, 'a **bold** body');
    assert.deepEqual(writes[0].docRef, {
      objectId: 'issue-1',
      objectClass: tracker.class.Issue,
      objectAttr: 'description'
    });
    assert.equal(JSON.parse(writes[0].markup).type, 'doc', 'the raw input must be serialised, never stored verbatim');

    const text = await client._readCollaboratorField('issue-1', tracker.class.Issue);
    assert.deepEqual(reads[0].docRef, writes[0].docRef, 'read and write must address the same document');
    assert.equal(reads[0].source, null, 'the default read must not pin a source revision');
    assert.match(text, /a \*\*bold\*\* body/);
  });

  it('applies the requested input format instead of always parsing markdown', async () => {
    const { client, writes } = collabHarness();

    await client._writeCollaboratorField('issue-1', tracker.class.Issue, '# Heading', 'markdown');
    await client._writeCollaboratorField('issue-1', tracker.class.Issue, '# Heading', 'plain');

    assert.equal(JSON.parse(writes[0].markup).content[0].type, 'heading');
    assert.equal(JSON.parse(writes[1].markup).content[0].type, 'paragraph',
      'plain input must never be parsed as markup');
  });

  it('targets a non-default attribute and forwards the source revision', async () => {
    const { client, reads, writes } = collabHarness();

    await client._writeCollaboratorField('milestone-1', tracker.class.Milestone, 'notes', 'markdown', 'description');
    await client._readCollaboratorField('milestone-1', tracker.class.Milestone, 'fullDescription', 'rev-7');

    assert.equal(writes[0].docRef.objectAttr, 'description');
    assert.deepEqual(reads[0], {
      docRef: { objectId: 'milestone-1', objectClass: tracker.class.Milestone, objectAttr: 'fullDescription' },
      source: 'rev-7'
    });
    // A different attribute is a different document, so it must read back empty.
    assert.equal(await client._readCollaboratorField('milestone-1', tracker.class.Milestone, 'fullDescription'), '');
  });
});

describe('HulyClient._buildRelatedIssueMap', () => {
  function relationSdk(issues, projects) {
    const calls = [];
    const sdk = {
      async findAll(_class, query) {
        calls.push({ _class, query });
        const ids = query._id.$in;
        if (_class === tracker.class.Issue) return issues.filter(issue => ids.includes(issue._id));
        if (_class === tracker.class.Project) return projects.filter(project => ids.includes(project._id));
        return [];
      }
    };
    return { sdk, calls };
  }

  it('queries nothing when no issue carries a relation', async () => {
    const { sdk, calls } = relationSdk([], []);
    const map = await newClient()._buildRelatedIssueMap(sdk, [{ relations: [], blockedBy: null }, {}]);

    assert.equal(map.size, 0);
    assert.deepEqual(calls, [], 'an empty id set must never reach the server as $in: []');
  });

  it('resolves every relation in two queries and dedupes shared references', async () => {
    const issues = [
      { _id: 'r1', number: 7, title: 'Cache miss', space: 'sp-a' },
      { _id: 'r2', number: 9, title: 'Timeout', space: 'sp-b' },
      { _id: 'r3', number: 3, title: 'Orphan', space: 'sp-gone' }
    ];
    const projects = [{ _id: 'sp-a', identifier: 'ALPHA' }, { _id: 'sp-b', identifier: 'BETA' }];
    const { sdk, calls } = relationSdk(issues, projects);

    const map = await newClient()._buildRelatedIssueMap(sdk, [
      { relations: [{ _id: 'r1' }, { _id: 'r2' }], blockedBy: [{ _id: 'r1' }] },
      { relations: [{ _id: 'r2' }], blockedBy: [{ _id: 'r3' }] }
    ]);

    assert.equal(calls.length, 2, 'one issue query and one project query, whatever the fan-out');
    assert.deepEqual(calls[0].query._id.$in, ['r1', 'r2', 'r3'], 'ids must be deduped across both relation kinds');
    assert.deepEqual(calls[1].query._id.$in, ['sp-a', 'sp-b', 'sp-gone'], 'spaces must be deduped too');
    assert.deepEqual(map.get('r1'), { id: 'ALPHA-7', title: 'Cache miss' });
    assert.deepEqual(map.get('r2'), { id: 'BETA-9', title: 'Timeout' });
    assert.deepEqual(map.get('r3'), { id: '?-3', title: 'Orphan' },
      'an unreadable project must degrade to a placeholder, not crash');
  });
});

describe('config env resolution', () => {
  let generation = 0;

  /** Re-evaluate config.mjs under a chosen environment; it reads env once at load. */
  async function loadWith(env) {
    const saved = applyEnv(env);
    generation += 1;
    try {
      return await import(`../src/config.mjs?generation=${generation}`);
    } finally {
      restoreEnv(saved);
    }
  }

  it('falls back to the documented defaults when the environment is empty', async () => {
    const config = await loadWith({});

    assert.equal(config.HULY_URL, 'http://localhost:8087');
    assert.equal(config.POOL_TTL_MS, 1_800_000);
    assert.equal(config.PORT, 3001);
    assert.equal(config.RATE_LIMIT, 200);
    assert.equal(config.ALLOWED_ORIGINS, '*');
    assert.equal(config.MCP_AUTH_TOKEN, null, 'an absent token must disable auth explicitly, not with undefined');
    assert.equal(config.HULY_WORKSPACE, undefined);
    assert.equal(config.HULY_PROJECT, undefined);
    assert.deepEqual(config.HULY_CREDS, { email: undefined, password: undefined });
    assert.equal(config.POOL_CLEANUP_INTERVAL_MS, 300_000);
    assert.equal(config.RATE_WINDOW_MS, 60_000);
    assert.equal(config.MAX_BODY_SIZE, 1_048_576);
  });

  it('prefers the environment over every default and parses numbers as numbers', async () => {
    const config = await loadWith({
      HULY_URL: 'https://huly.example.test',
      HULY_WORKSPACE: 'ws-env',
      HULY_PROJECT: 'PROJ',
      HULY_POOL_TTL_MS: '60000',
      PORT: '8080',
      HULY_RATE_LIMIT: '25',
      MCP_AUTH_TOKEN: 'mcp-secret',
      ALLOWED_ORIGINS: 'https://a.test,https://b.test'
    });

    assert.equal(config.HULY_URL, 'https://huly.example.test');
    assert.equal(config.HULY_WORKSPACE, 'ws-env');
    assert.equal(config.HULY_PROJECT, 'PROJ');
    assert.equal(config.MCP_AUTH_TOKEN, 'mcp-secret');
    assert.equal(config.ALLOWED_ORIGINS, 'https://a.test,https://b.test');
    assert.deepEqual([config.POOL_TTL_MS, config.PORT, config.RATE_LIMIT], [60_000, 8080, 25]);
    for (const value of [config.POOL_TTL_MS, config.PORT, config.RATE_LIMIT]) {
      assert.equal(typeof value, 'number', 'numeric settings must be parsed, not left as strings');
    }
  });

  it('uses a token alone and falls back to email and password when there is none', async () => {
    const tokened = await loadWith({
      HULY_TOKEN: 'jwt-token', HULY_EMAIL: 'user@example.test', HULY_PASSWORD: 'pw'
    });
    assert.deepEqual(tokened.HULY_CREDS, { token: 'jwt-token' }, 'token auth must not carry password fields');

    const basic = await loadWith({ HULY_EMAIL: 'user@example.test', HULY_PASSWORD: 'pw' });
    assert.deepEqual(basic.HULY_CREDS, { email: 'user@example.test', password: 'pw' });
    assert.equal(basic.HULY_TOKEN, undefined);

    // An empty token is not a credential and must not shadow the password path.
    const empty = await loadWith({ HULY_TOKEN: '', HULY_EMAIL: 'user@example.test', HULY_PASSWORD: 'pw' });
    assert.deepEqual(empty.HULY_CREDS, { email: 'user@example.test', password: 'pw' });
  });
});

describe('pool cleared during an in-flight connect', () => {
  it('does not resurrect the entry and never hands back a disconnected client', async () => {
    const { ConnectionPool } = await import('../src/pool.mjs');
    const { HulyClient } = await import('../src/client.mjs');

    const originalConnect = HulyClient.prototype.connect;
    const originalDisconnect = HulyClient.prototype.disconnect;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let disconnects = 0;

    HulyClient.prototype.connect = async function connect() { await gate; };
    HulyClient.prototype.disconnect = function disconnect() { disconnects += 1; };

    const pool = new ConnectionPool();
    try {
      const inflight = pool.getClient('ws-a');
      pool.clearAll();          // caller asked for the pool to be torn down
      release();

      await assert.rejects(inflight, /was closed while it was being established/);
      // Caching it would leak a socket the caller closed, and clearAll also
      // stopped the sweep timer, so nothing would ever evict it.
      assert.equal(pool._entries.size, 0, 'the cleared slot must not be reclaimed');
      assert.equal(disconnects, 1, 'the orphaned connection must be closed');
    } finally {
      pool.clearAll();
      HulyClient.prototype.connect = originalConnect;
      HulyClient.prototype.disconnect = originalDisconnect;
    }
  });

  it('same for clearClient targeting the workspace being connected', async () => {
    const { ConnectionPool } = await import('../src/pool.mjs');
    const { HulyClient } = await import('../src/client.mjs');

    const originalConnect = HulyClient.prototype.connect;
    const originalDisconnect = HulyClient.prototype.disconnect;
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let disconnects = 0;
    HulyClient.prototype.connect = async function connect() { await gate; };
    HulyClient.prototype.disconnect = function disconnect() { disconnects += 1; };

    const pool = new ConnectionPool();
    try {
      const inflight = pool.getClient('ws-b');
      pool.clearClient('ws-b');
      release();

      await assert.rejects(inflight, /was closed while it was being established/);
      assert.equal(pool._entries.has('ws-b'), false);
      assert.equal(disconnects, 1);
    } finally {
      pool.clearAll();
      HulyClient.prototype.connect = originalConnect;
      HulyClient.prototype.disconnect = originalDisconnect;
    }
  });
});
