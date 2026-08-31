import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The account/admin surface talks to Huly through @hcengineering/account-client,
// whose CommonJS exports are non-configurable getters and cannot be replaced.
// The seam used here is fetch itself, so every assertion below is on the
// JSON-RPC request that actually leaves the process: method, params, target
// accounts endpoint and bearer token.
const HULY_URL = 'https://huly.example.test';
const ACCOUNTS_URL = 'https://accounts.example.test';
const OTHER_URL = 'https://other.example.test';
const OTHER_ACCOUNTS_URL = 'https://other-accounts.example.test';

const ACCOUNTS_BY_SERVER = new Map([
  [HULY_URL, ACCOUNTS_URL],
  [OTHER_URL, OTHER_ACCOUNTS_URL]
]);

class RpcFailure {
  constructor(status) {
    this.status = status;
  }
}

const rpcFails = () => new RpcFailure({ code: 'account.OperationFailed', params: {} });

const calls = [];
let rpcTable = {};

const trimSlash = value => value.replace(/\/+$/, '');

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { 'content-type': 'application/json' }
  });
}

globalThis.fetch = async (input, init) => {
  const request = input instanceof Request ? input : null;
  const url = trimSlash(request ? request.url : String(input));

  const server = [...ACCOUNTS_BY_SERVER.keys()].find(base => url === `${base}/config.json`);
  if (server !== undefined) {
    calls.push({ kind: 'config', url });
    return jsonResponse({ ACCOUNTS_URL: ACCOUNTS_BY_SERVER.get(server) });
  }

  const body = JSON.parse(request ? await request.text() : String(init?.body));
  const call = {
    kind: 'rpc',
    url,
    rpc: body.method,
    params: body.params ?? {},
    authorization: request
      ? request.headers.get('authorization')
      : new Headers(init?.headers ?? {}).get('authorization')
  };
  calls.push(call);

  if (!(call.rpc in rpcTable)) {
    throw new Error(`unstubbed account RPC: ${call.rpc}`);
  }
  const entry = rpcTable[call.rpc];
  const value = typeof entry === 'function' ? entry(call.params) : entry;
  return jsonResponse(value instanceof RpcFailure ? { error: value.status } : { result: value });
};

const { HulyClient } = await import('../src/client.mjs');

function jwtFor(payload) {
  return `header.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;
}

const TOKEN = jwtFor({ account: 'account-uuid-1' });
const OTHER_TOKEN = jwtFor({ account: 'account-uuid-2' });
const LOGIN_TOKEN = jwtFor({ account: 'login-account-uuid' });
const LOGIN_ACCOUNT = 'login-account-uuid';
const TOKEN_CREDS = { token: TOKEN };
const PASSWORD_CREDS = { email: 'ada@example.test', password: 'correct horse' };

// The second entry carries the legacy field names the mappers fall back to.
const WORKSPACES = [
  { url: 'alpha', name: 'Alpha', mode: 'active', createdOn: Date.UTC(2026, 0, 2) },
  { workspace: 'beta', workspaceName: 'Beta', mode: 'archived' }
];

const DEFAULT_RPC = {
  getUserWorkspaces: () => WORKSPACES,
  selectWorkspace: ({ workspaceUrl }) => ({ token: `${workspaceUrl}-token`, workspace: workspaceUrl }),
  login: () => ({ token: LOGIN_TOKEN, account: LOGIN_ACCOUNT })
};

function stubRpc(overrides = {}) {
  rpcTable = { ...DEFAULT_RPC, ...overrides };
}

const rpcCalls = () => calls.filter(call => call.kind === 'rpc');
const rpcNames = () => rpcCalls().map(call => call.rpc);
const rpcFor = name => rpcCalls().find(call => call.rpc === name);
const paramsFor = name => rpcCalls().filter(call => call.rpc === name).map(call => call.params);
const configFetches = () => calls.filter(call => call.kind === 'config').map(call => call.url);

beforeEach(() => {
  calls.length = 0;
  rpcTable = {};
  HulyClient._authCache = { token: null, accountId: null, accountsUrl: null, expiresAt: 0 };
});

describe('account session establishment', () => {
  it('resolves the accounts endpoint from server config and presents the caller token', async () => {
    stubRpc();

    const workspaces = await HulyClient.listWorkspaces(HULY_URL, TOKEN_CREDS);

    assert.deepEqual(configFetches(), [`${HULY_URL}/config.json`]);
    const call = rpcFor('getUserWorkspaces');
    assert.equal(call.url, ACCOUNTS_URL, 'the RPC must go to ACCOUNTS_URL, not the Huly front URL');
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.deepEqual(workspaces, [
      {
        slug: 'alpha',
        name: 'Alpha',
        mode: 'active',
        createdOn: new Date(Date.UTC(2026, 0, 2)).toISOString()
      },
      { slug: 'beta', name: 'Beta', mode: 'archived', createdOn: null }
    ]);
  });

  it('logs in with the supplied credentials and then authorises as the issued token', async () => {
    stubRpc({ getAccountInfo: ({ accountId }) => ({ uuid: accountId, role: 'OWNER' }) });

    const info = await HulyClient.getAccountInfo(HULY_URL, PASSWORD_CREDS);

    const login = rpcFor('login');
    assert.deepEqual(login.params, { email: 'ada@example.test', password: 'correct horse' });
    assert.equal(login.authorization, null, 'the login call itself must not carry a bearer');
    const lookup = rpcFor('getAccountInfo');
    assert.equal(lookup.authorization, `Bearer ${LOGIN_TOKEN}`);
    // The account id comes from the login response, not from the email.
    assert.deepEqual(lookup.params, { accountId: LOGIN_ACCOUNT });
    assert.deepEqual(info, { uuid: LOGIN_ACCOUNT, role: 'OWNER' });
  });

  it('rejects a token with no account claim before calling the API', async () => {
    stubRpc();

    await assert.rejects(
      () => HulyClient.listWorkspaces(HULY_URL, { token: jwtFor({ workspace: 'alpha' }) }),
      /JWT token missing account field/
    );
    assert.deepEqual(rpcNames(), [], 'an unusable token must not be sent anywhere');
  });

  it('rejects a login that returns no token instead of continuing unauthenticated', async () => {
    stubRpc({ login: () => ({ account: LOGIN_ACCOUNT }) });

    await assert.rejects(
      () => HulyClient.listWorkspaces(HULY_URL, PASSWORD_CREDS),
      /Login failed/
    );
    assert.deepEqual(rpcNames(), ['login']);
  });

  it('reuses a cached session only for the same server and the same credentials', async () => {
    stubRpc();

    await HulyClient.listWorkspaces(HULY_URL, TOKEN_CREDS);
    await HulyClient.listWorkspaces(HULY_URL, TOKEN_CREDS);
    await HulyClient.listWorkspaces(HULY_URL, { token: OTHER_TOKEN });
    await HulyClient.listWorkspaces(OTHER_URL, { token: OTHER_TOKEN });

    assert.deepEqual(configFetches(), [
      `${HULY_URL}/config.json`,
      `${HULY_URL}/config.json`,
      `${OTHER_URL}/config.json`
    ], 'only the repeated same-credential call may skip config resolution');
    assert.deepEqual(
      rpcCalls().map(call => call.authorization),
      [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`, `Bearer ${OTHER_TOKEN}`, `Bearer ${OTHER_TOKEN}`],
      'a second account must never be served the first account cached token'
    );
    assert.equal(rpcCalls().at(-1).url, OTHER_ACCOUNTS_URL,
      'a different server must not be addressed through the cached accounts URL');
  });

  it('re-establishes an expired session', async () => {
    stubRpc();

    await HulyClient.listWorkspaces(HULY_URL, TOKEN_CREDS);
    HulyClient._authCache.expiresAt = Date.now() - 1;
    await HulyClient.listWorkspaces(HULY_URL, TOKEN_CREDS);

    assert.equal(configFetches().length, 2);
  });
});

describe('workspace scoping', () => {
  it('selects the addressed workspace and signs the write with that workspace token', async () => {
    stubRpc({ updateWorkspaceName: null });

    const result = await HulyClient.updateWorkspaceName(HULY_URL, TOKEN_CREDS, 'beta', 'Beta Renamed');

    assert.deepEqual(rpcNames(), ['getUserWorkspaces', 'selectWorkspace', 'updateWorkspaceName']);
    assert.deepEqual(rpcFor('selectWorkspace').params, {
      workspaceUrl: 'beta', kind: 'external', externalRegions: []
    });
    const write = rpcFor('updateWorkspaceName');
    assert.equal(write.authorization, 'Bearer beta-token',
      'the write must carry the selected workspace token, not the account token');
    assert.deepEqual(write.params, { name: 'Beta Renamed' });
    assert.equal(result.message, 'Workspace "beta" renamed to "Beta Renamed"');
  });

  it('refuses an unknown workspace before anything is selected', async () => {
    stubRpc();

    await assert.rejects(
      () => HulyClient.deleteWorkspace(HULY_URL, TOKEN_CREDS, 'gamma'),
      /Workspace not found: gamma/
    );
    assert.deepEqual(rpcNames(), ['getUserWorkspaces'],
      'an unknown slug must not reach selectWorkspace or a destructive call');
  });

  it('fails when workspace selection returns no token', async () => {
    stubRpc({ selectWorkspace: () => ({ workspace: 'alpha' }) });

    await assert.rejects(
      () => HulyClient.deleteWorkspace(HULY_URL, TOKEN_CREDS, 'alpha'),
      /Failed to select workspace: alpha/
    );
    assert.deepEqual(rpcNames(), ['getUserWorkspaces', 'selectWorkspace']);
  });

  it('deletes through the token of the named workspace', async () => {
    stubRpc({ deleteWorkspace: null });

    const result = await HulyClient.deleteWorkspace(HULY_URL, TOKEN_CREDS, 'beta');

    // deleteWorkspace takes no target parameter: the bearer *is* the target.
    assert.deepEqual(rpcFor('deleteWorkspace').params, {});
    assert.equal(rpcFor('deleteWorkspace').authorization, 'Bearer beta-token');
    assert.equal(result.message, 'Workspace "beta" deleted permanently');
  });

  it('propagates server failures instead of reporting success', async () => {
    stubRpc({
      deleteWorkspace: () => rpcFails(),
      updateWorkspaceName: () => rpcFails(),
      deleteIntegration: () => rpcFails()
    });

    await assert.rejects(() => HulyClient.deleteWorkspace(HULY_URL, TOKEN_CREDS, 'alpha'));
    await assert.rejects(() => HulyClient.updateWorkspaceName(HULY_URL, TOKEN_CREDS, 'alpha', 'Nope'));
    await assert.rejects(() => HulyClient.deleteIntegration(HULY_URL, TOKEN_CREDS, { kind: 'github' }));
  });
});

describe('workspace administration', () => {
  it('maps full workspace info, including a zero major version', async () => {
    stubRpc({
      getWorkspaceInfo: () => ({
        url: 'alpha',
        name: 'Alpha',
        uuid: 'alpha-uuid',
        mode: 'active',
        versionMajor: 0,
        versionMinor: 7,
        versionPatch: 3,
        createdOn: Date.UTC(2026, 0, 2),
        lastVisit: Date.UTC(2026, 0, 3),
        isDisabled: true
      })
    });

    const info = await HulyClient.getWorkspaceInfo(HULY_URL, TOKEN_CREDS, 'alpha');

    assert.equal(rpcFor('getWorkspaceInfo').authorization, 'Bearer alpha-token');
    assert.deepEqual(info, {
      slug: 'alpha',
      name: 'Alpha',
      uuid: 'alpha-uuid',
      mode: 'active',
      // A truthiness check here would report a 0.x deployment as unversioned.
      version: '0.7.3',
      createdOn: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      lastVisit: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      isDisabled: true
    });
  });

  it('falls back to the legacy workspace info fields and defaults the rest', async () => {
    stubRpc({
      getWorkspaceInfo: () => ({ workspaceUrl: 'beta', workspaceUuid: 'beta-uuid', name: 'Beta', mode: 'archived' })
    });

    const info = await HulyClient.getWorkspaceInfo(HULY_URL, TOKEN_CREDS, 'beta');

    assert.deepEqual(info, {
      slug: 'beta',
      name: 'Beta',
      uuid: 'beta-uuid',
      mode: 'archived',
      version: null,
      createdOn: null,
      lastVisit: null,
      isDisabled: false
    });
  });

  it('forwards the workspace name on creation', async () => {
    stubRpc({
      createWorkspace: () => ({ workspace: 'fresh-uuid', workspaceUrl: 'fresh', token: 'fresh-token', role: 'OWNER' })
    });

    const result = await HulyClient.createWorkspace(HULY_URL, TOKEN_CREDS, 'Fresh Workspace');

    assert.deepEqual(rpcFor('createWorkspace').params, { workspaceName: 'Fresh Workspace' });
    assert.equal(rpcFor('createWorkspace').authorization, `Bearer ${TOKEN}`,
      'workspace creation is an account-level call, not a workspace-scoped one');
    assert.equal(result.message, 'Workspace "Fresh Workspace" created');
  });

  it('maps members through person id with null contact fallbacks', async () => {
    stubRpc({
      getWorkspaceMembers: () => ([
        { person: 'person-1', role: 'OWNER', email: 'ada@example.test', name: 'Ada' },
        { _id: 'legacy-1', role: 'USER' }
      ])
    });

    const members = await HulyClient.getWorkspaceMembers(HULY_URL, TOKEN_CREDS, 'alpha');

    assert.deepEqual(members, [
      { id: 'person-1', role: 'OWNER', email: 'ada@example.test', name: 'Ada' },
      { id: 'legacy-1', role: 'USER', email: null, name: null }
    ]);
  });

  it('sends the member and the role to the right role fields', async () => {
    stubRpc({ updateWorkspaceRole: null });

    const result = await HulyClient.updateWorkspaceRole(
      HULY_URL, TOKEN_CREDS, 'alpha', 'ada@example.test', 'MAINTAINER'
    );

    assert.deepEqual(rpcFor('updateWorkspaceRole').params, {
      targetAccount: 'ada@example.test', targetRole: 'MAINTAINER'
    });
    assert.equal(rpcFor('updateWorkspaceRole').authorization, 'Bearer alpha-token');
    assert.equal(result.message, 'Updated role for ada@example.test to MAINTAINER in alpha');
  });
});

describe('profile and credentials', () => {
  it('sends only the supplied profile fields and keeps an explicit clear', async () => {
    stubRpc({ setMyProfile: null });

    const renamed = await HulyClient.setMyProfile(HULY_URL, TOKEN_CREDS, 'Ada Lovelace');
    const relocated = await HulyClient.setMyProfile(HULY_URL, TOKEN_CREDS, undefined, '', 'DE');

    // An omitted field must stay out of the update; an empty string is a clear.
    assert.deepEqual(paramsFor('setMyProfile'), [
      { profile: { name: 'Ada Lovelace' } },
      { profile: { city: '', country: 'DE' } }
    ]);
    assert.deepEqual(renamed.updated, ['name']);
    assert.deepEqual(relocated.updated, ['city', 'country']);
  });

  it('returns the profile the server reports', async () => {
    stubRpc({ getUserProfile: () => ({ name: 'Ada', city: 'Paris' }) });

    const profile = await HulyClient.getUserProfile(HULY_URL, TOKEN_CREDS);

    assert.deepEqual(rpcFor('getUserProfile').params, {});
    assert.deepEqual(profile, { name: 'Ada', city: 'Paris' });
  });

  it('sends the current password as the old one and the new one as the new', async () => {
    stubRpc({ changePassword: null });

    const result = await HulyClient.changePassword(HULY_URL, PASSWORD_CREDS, 'new secret');

    assert.deepEqual(rpcFor('changePassword').params, {
      oldPassword: 'correct horse', newPassword: 'new secret'
    });
    assert.equal(result.message, 'Password changed successfully');
  });

  it('refuses a password change under token auth without calling the API', async () => {
    stubRpc();

    await assert.rejects(
      () => HulyClient.changePassword(HULY_URL, TOKEN_CREDS, 'new secret'),
      /requires email\/password auth/
    );
    assert.deepEqual(rpcNames(), [], 'no password RPC may be attempted without the current password');
  });

  it('clears the last name explicitly when only a first name is given', async () => {
    stubRpc({ changeUsername: null });

    const full = await HulyClient.changeUsername(HULY_URL, TOKEN_CREDS, 'Ada', 'Lovelace');
    const firstOnly = await HulyClient.changeUsername(HULY_URL, TOKEN_CREDS, 'Ada');

    assert.deepEqual(paramsFor('changeUsername'), [
      { first: 'Ada', last: 'Lovelace' },
      { first: 'Ada', last: '' }
    ]);
    assert.equal(full.message, 'Username changed to "Ada Lovelace"');
    assert.equal(firstOnly.message, 'Username changed to "Ada"');
  });
});

describe('invites', () => {
  it('defaults the invite role to MEMBER and scopes it to the workspace', async () => {
    stubRpc({ sendInvite: null, resendInvite: null });

    const sent = await HulyClient.sendInvite(HULY_URL, TOKEN_CREDS, 'alpha', 'new@example.test');
    const resent = await HulyClient.resendInvite(HULY_URL, TOKEN_CREDS, 'alpha', 'new@example.test', 'OWNER');

    assert.deepEqual(rpcFor('sendInvite').params, { email: 'new@example.test', role: 'MEMBER' });
    assert.equal(rpcFor('sendInvite').authorization, 'Bearer alpha-token');
    assert.deepEqual(rpcFor('resendInvite').params, { email: 'new@example.test', role: 'OWNER' });
    assert.equal(sent.message, 'Invite sent to new@example.test for workspace alpha');
    assert.equal(resent.message, 'Invite resent to new@example.test');
  });

  it('maps the seven invite-link arguments onto the right named parameters', async () => {
    stubRpc({ createInviteLink: () => 'https://huly.example.test/invite?id=abc' });

    const defaults = await HulyClient.createInviteLink(HULY_URL, TOKEN_CREDS, 'alpha');
    await HulyClient.createInviteLink(
      HULY_URL, TOKEN_CREDS, 'alpha', 'new@example.test', 'MAINTAINER', 'Ada', 'Lovelace', 12
    );

    // A positional shift here silently grants the wrong role or auto-joins.
    assert.deepEqual(paramsFor('createInviteLink'), [
      { email: '', role: 'MEMBER', autoJoin: false, firstName: '', lastName: '', expHours: 48 },
      {
        email: 'new@example.test',
        role: 'MAINTAINER',
        autoJoin: false,
        firstName: 'Ada',
        lastName: 'Lovelace',
        expHours: 12
      }
    ]);
    assert.deepEqual(defaults, {
      link: 'https://huly.example.test/invite?id=abc', workspace: 'alpha', role: 'MEMBER'
    });
  });
});

describe('integrations and mailboxes', () => {
  it('forwards an integration filter and only defaults it when none is given', async () => {
    stubRpc({ listIntegrations: () => ([{ kind: 'github' }]) });

    await HulyClient.listIntegrations(HULY_URL, TOKEN_CREDS, { kind: 'github', workspaceUuid: 'ws-uuid' });
    const unfiltered = await HulyClient.listIntegrations(HULY_URL, TOKEN_CREDS);

    // A dropped filter lists every integration on the account instead.
    assert.deepEqual(paramsFor('listIntegrations'), [
      { kind: 'github', workspaceUuid: 'ws-uuid' },
      {}
    ]);
    assert.deepEqual(unfiltered, [{ kind: 'github' }]);
  });

  it('sends the integration key and payload verbatim, including an explicit false', async () => {
    const key = { socialId: 'sid-1', kind: 'github', workspaceUuid: 'ws-uuid' };
    stubRpc({
      getIntegration: () => ({ ...key, data: { login: 'ada' } }),
      createIntegration: null,
      updateIntegration: null,
      deleteIntegration: null
    });

    const found = await HulyClient.getIntegration(HULY_URL, TOKEN_CREDS, key);
    await HulyClient.createIntegration(HULY_URL, TOKEN_CREDS, { ...key, disabled: false, data: { login: 'ada' } });
    await HulyClient.updateIntegration(HULY_URL, TOKEN_CREDS, { ...key, disabled: true });
    const deleted = await HulyClient.deleteIntegration(HULY_URL, TOKEN_CREDS, key);

    assert.deepEqual(rpcFor('getIntegration').params, key);
    assert.deepEqual(rpcFor('createIntegration').params, { ...key, disabled: false, data: { login: 'ada' } });
    assert.deepEqual(rpcFor('updateIntegration').params, { ...key, disabled: true });
    assert.deepEqual(rpcFor('deleteIntegration').params, key);
    assert.deepEqual(found, { ...key, data: { login: 'ada' } });
    assert.deepEqual(deleted, { message: 'Integration deleted' });
  });

  it('carries the mailbox name, domain and id through to the API', async () => {
    stubRpc({
      getMailboxes: () => ([{ mailbox: 'ada@mail.test' }]),
      createMailbox: () => ({ mailbox: 'ada@mail.test', socialId: 'sid-1' }),
      deleteMailbox: null
    });

    const list = await HulyClient.getMailboxes(HULY_URL, TOKEN_CREDS);
    const created = await HulyClient.createMailbox(HULY_URL, TOKEN_CREDS, 'ada', 'mail.test');
    const deleted = await HulyClient.deleteMailbox(HULY_URL, TOKEN_CREDS, 'ada@mail.test');

    assert.deepEqual(list, [{ mailbox: 'ada@mail.test' }]);
    assert.deepEqual(rpcFor('getMailboxes').params, {});
    // A dropped domain would create the mailbox on the server default domain.
    assert.deepEqual(rpcFor('createMailbox').params, { name: 'ada', domain: 'mail.test' });
    assert.deepEqual(created, { mailbox: 'ada@mail.test', socialId: 'sid-1' });
    assert.deepEqual(rpcFor('deleteMailbox').params, { mailbox: 'ada@mail.test' });
    assert.equal(deleted.message, 'Mailbox ada@mail.test deleted');
  });
});

describe('people and subscriptions', () => {
  it('sends the social key as socialString and the email as email', async () => {
    stubRpc({
      findPersonBySocialKey: () => 'person-uuid',
      getSocialIds: () => ([{ _id: 'sid-1', type: 'email', value: 'ada@example.test' }]),
      addEmailSocialId: () => ({ socialId: 'sid-2' })
    });

    const person = await HulyClient.findPersonBySocialKey(HULY_URL, TOKEN_CREDS, 'email:ada@example.test');
    const socialIds = await HulyClient.getSocialIds(HULY_URL, TOKEN_CREDS);
    const added = await HulyClient.addEmailSocialId(HULY_URL, TOKEN_CREDS, 'ada.new@example.test');

    assert.deepEqual(rpcFor('findPersonBySocialKey').params, { socialString: 'email:ada@example.test' });
    assert.deepEqual(rpcFor('getSocialIds').params, {});
    assert.deepEqual(rpcFor('addEmailSocialId').params, { email: 'ada.new@example.test' });
    assert.equal(person, 'person-uuid');
    assert.deepEqual(socialIds, [{ _id: 'sid-1', type: 'email', value: 'ada@example.test' }]);
    assert.deepEqual(added, { socialId: 'sid-2' });
  });

  it('asks for inactive subscriptions too', async () => {
    stubRpc({ getSubscriptions: () => ([{ id: 'sub-1', status: 'cancelled' }]) });

    const subscriptions = await HulyClient.getSubscriptions(HULY_URL, TOKEN_CREDS);

    // The SDK default is activeOnly=true, which hides cancelled subscriptions.
    assert.deepEqual(rpcFor('getSubscriptions').params, { activeOnly: false });
    assert.deepEqual(subscriptions, [{ id: 'sub-1', status: 'cancelled' }]);
  });
});
