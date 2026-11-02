/**
 * Account-level tools: server context, account and workspace administration, invites, integrations, mailboxes, social identities and subscriptions.
 */


/** @type {Object[]} */
export const accountTools = [
    {
      name: 'get_huly_context',
      description: 'Return sanitized runtime context for this Huly MCP server: default workspace, default project, Huly URL host, auth mode, package name, and package version. Does not return secrets.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    // ── Account & Workspace Management ──────────────────────
    {
      name: 'list_workspaces',
      description: 'List all workspaces accessible to the authenticated user. Returns each workspace\'s slug, name, mode (active/archived), and creation date. Use this to discover available workspaces before specifying a workspace parameter on other tools.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'get_workspace_info',
      description: 'Get detailed info about a specific workspace by slug. Returns name, mode, version, creation date, and usage info.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' } }, required: ['workspace'] }
    },
    {
      name: 'create_workspace',
      description: 'Create a new workspace. Returns the new workspace slug and ID. WARNING: This is a significant operation — confirm with the user before proceeding.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Workspace display name' } }, required: ['name'] }
    },
    {
      name: 'update_workspace_name',
      description: 'Rename an existing workspace. Only changes the display name, not the slug.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' }, name: { type: 'string', description: 'New display name' } }, required: ['workspace', 'name'] }
    },
    {
      name: 'delete_workspace',
      description: 'Permanently delete a workspace and ALL its data (projects, issues, members). DESTRUCTIVE and IRREVERSIBLE — confirm with the user before proceeding.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug to delete' } }, required: ['workspace'] }
    },
    {
      name: 'get_workspace_members',
      description: 'List all members of a workspace with their roles. Returns member ID, name, email, and role (OWNER/MAINTAINER/MEMBER/GUEST).',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' } }, required: ['workspace'] }
    },
    {
      name: 'update_workspace_role',
      description: 'Change a member\'s role in a workspace. Roles: OWNER, MAINTAINER, MEMBER, GUEST.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' }, email: { type: 'string', description: 'Member email address' }, role: { type: 'string', description: 'New role: OWNER, MAINTAINER, MEMBER, GUEST' } }, required: ['workspace', 'email', 'role'] }
    },
    {
      name: 'get_account_info',
      description: 'Get the current authenticated user\'s account info including ID, name, and social IDs.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'get_user_profile',
      description: 'Get the current user\'s profile including name, avatar, city, and country.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'set_my_profile',
      description: 'Update the current user\'s profile. Only specify the fields you want to change.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'New display name' }, city: { type: 'string', description: 'City' }, country: { type: 'string', description: 'Country' } }, required: [] }
    },
    {
      name: 'change_password',
      description: 'Change the current user\'s password. Requires the current password (from HULY_PASSWORD env var) and a new password.',
      inputSchema: { type: 'object', properties: { newPassword: { type: 'string', description: 'New password' } }, required: ['newPassword'] }
    },
    {
      name: 'change_username',
      description: 'Change the current user\'s first and last name at the account level.',
      inputSchema: { type: 'object', properties: { firstName: { type: 'string', description: 'First name' }, lastName: { type: 'string', description: 'Last name' } }, required: ['firstName'] }
    },
    // ── Invites ──────────────────────────────────────────────
    {
      name: 'send_invite',
      description: 'Send an email invite to join a workspace. Specify the workspace slug, the invitee\'s email, and an optional role (default: MEMBER).',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' }, email: { type: 'string', description: 'Email address to invite' }, role: { type: 'string', description: 'Role: OWNER, MAINTAINER, MEMBER, GUEST (default: MEMBER)' } }, required: ['workspace', 'email'] }
    },
    {
      name: 'resend_invite',
      description: 'Resend a pending workspace invitation.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' }, email: { type: 'string', description: 'Email of the pending invitee' }, role: { type: 'string', description: 'Role: OWNER, MAINTAINER, MEMBER, GUEST (default: MEMBER)' } }, required: ['workspace', 'email'] }
    },
    {
      name: 'create_invite_link',
      description: 'Create a shareable invite link for a workspace. Returns the link URL. Default expiry: 48 hours.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Workspace slug' }, email: { type: 'string', description: 'Email address for the invite' }, role: { type: 'string', description: 'Role for invitees: OWNER, MAINTAINER, MEMBER, GUEST (default: MEMBER)' }, firstName: { type: 'string', description: 'First name of invitee' }, lastName: { type: 'string', description: 'Last name of invitee' }, expireHours: { type: 'number', description: 'Link expiry in hours (default: 48)' } }, required: ['workspace'] }
    },
    // ── Integrations ─────────────────────────────────────────
    {
      name: 'list_integrations',
      description: 'List all integrations configured for the account. Optionally filter by socialId, kind, or workspaceUuid.',
      inputSchema: { type: 'object', properties: { filter: { type: 'object', description: 'Optional filter: { socialId?, kind?, workspaceUuid? }' } }, required: [] }
    },
    {
      name: 'get_integration',
      description: 'Get details of a specific integration by its key (socialId + kind + workspaceUuid).',
      inputSchema: { type: 'object', properties: { socialId: { type: 'string', description: 'Social ID (PersonId)' }, kind: { type: 'string', description: 'Integration kind (e.g. github, mail, telegram)' }, workspaceUuid: { type: 'string', description: 'Workspace UUID (or null for account-level)' } }, required: ['socialId', 'kind'] }
    },
    {
      name: 'create_integration',
      description: 'Create a new integration with a socialId, kind, optional workspaceUuid, and data.',
      inputSchema: { type: 'object', properties: { socialId: { type: 'string', description: 'Social ID (PersonId)' }, kind: { type: 'string', description: 'Integration kind (e.g. github, mail, telegram)' }, workspaceUuid: { type: 'string', description: 'Workspace UUID (null for account-level)' }, data: { type: 'object', description: 'Integration configuration data' }, disabled: { type: 'boolean', description: 'Whether the integration is disabled' } }, required: ['socialId', 'kind'] }
    },
    {
      name: 'update_integration',
      description: 'Update an existing integration. Pass the full integration key and updated fields.',
      inputSchema: { type: 'object', properties: { socialId: { type: 'string', description: 'Social ID (PersonId)' }, kind: { type: 'string', description: 'Integration kind (e.g. github, mail, telegram)' }, workspaceUuid: { type: 'string', description: 'Workspace UUID (null for account-level)' }, data: { type: 'object', description: 'Updated integration configuration data' }, disabled: { type: 'boolean', description: 'Whether the integration is disabled' } }, required: ['socialId', 'kind'] }
    },
    {
      name: 'delete_integration',
      description: 'Delete an integration by its key (socialId + kind + workspaceUuid). This is irreversible.',
      inputSchema: { type: 'object', properties: { socialId: { type: 'string', description: 'Social ID (PersonId)' }, kind: { type: 'string', description: 'Integration kind (e.g. github, mail, telegram)' }, workspaceUuid: { type: 'string', description: 'Workspace UUID (null for account-level)' } }, required: ['socialId', 'kind'] }
    },
    // ── Mailboxes ────────────────────────────────────────────
    {
      name: 'list_mailboxes',
      description: 'List all mailboxes configured for the account.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'create_mailbox',
      description: 'Create a new mailbox with a name and domain.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Mailbox name (local part before @)' }, domain: { type: 'string', description: 'Email domain' } }, required: ['name', 'domain'] }
    },
    {
      name: 'delete_mailbox',
      description: 'Delete a mailbox by ID.',
      inputSchema: { type: 'object', properties: { mailboxId: { type: 'string', description: 'Mailbox ID' } }, required: ['mailboxId'] }
    },
    // ── Person / Social ID ──────────────────────────────────
    {
      name: 'find_person_by_social_key',
      description: 'Find a person record by their social key (e.g., email, GitHub handle).',
      inputSchema: { type: 'object', properties: { socialKey: { type: 'string', description: 'Social key to search for' } }, required: ['socialKey'] }
    },
    {
      name: 'get_social_ids',
      description: 'Get all social IDs (email, GitHub, etc.) linked to the current user\'s account.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    {
      name: 'add_email_social_id',
      description: 'Link an additional email address to a person\'s account.',
      inputSchema: { type: 'object', properties: { targetEmail: { type: 'string', description: 'Email address to link' } }, required: ['targetEmail'] }
    },
    // ── Subscriptions ────────────────────────────────────────
    {
      name: 'list_subscriptions',
      description: 'List all subscriptions for the current account.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
];
