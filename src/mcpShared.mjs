/**
 * Shared MCP server factory — tool definitions, dispatch, and resource handlers.
 *
 * Used by both stdio (mcp.mjs) and Streamable HTTP (server.mjs) entry points.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { createRequire } from 'module';
import { pool } from './pool.mjs';
import { accountTools, workspaceTools } from './dispatch.mjs';
import { HULY_URL, HULY_CREDS } from './config.mjs';

const require = createRequire(import.meta.url);
const { name: PKG_NAME, version: PKG_VERSION } = require('../package.json');

export { PKG_NAME, PKG_VERSION };

// Optional workspace property added to every tool
const workspaceProp = {
  workspace: {
    type: 'string',
    description: 'Workspace slug (optional, uses HULY_WORKSPACE env var if omitted). Use list_workspaces to discover available workspace slugs.'
  }
};

// Pagination properties for all list tools
const paginationProps = {
  cursor: {
    type: 'string',
    description: 'Opaque pagination cursor from a previous response\'s nextCursor field. Omit for the first page.'
  },
  limit: {
    type: 'number',
    description: 'Maximum items per page (default: 50, or 20 with include_details)'
  }
};

// ── Tool Definitions ──────────────────────────────────────────

export { workspaceProp };

/**
 * Route a tool call to the appropriate HulyClient method.
 */
export async function handleToolCall(name, args) {
  if (accountTools[name]) {
    return await accountTools[name](args, HULY_URL, HULY_CREDS);
  }

  if (workspaceTools[name]) {
    const workspace = args.workspace || process.env.HULY_WORKSPACE;
    const client = await pool.getClient(workspace);
    return await client.withReconnect(() => workspaceTools[name](args, client));
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * Create a configured MCP Server with all tools and resources registered.
 * @param {Object} [capabilities] - Additional server capabilities
 * @returns {Object} { server, TOOLS }
 */
export function createMcpServer(capabilities = {}) {
  // Import TOOLS inline to keep this module self-contained
  const TOOLS = getToolDefinitions();

  const server = new Server(
    { name: PKG_NAME, version: PKG_VERSION },
    { capabilities: { tools: {}, resources: {}, ...capabilities } }
  );

  // ── Tools ────────────────────────────────────────────────

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const result = await handleToolCall(name, args || {});
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }],
        isError: true
      };
    }
  });

  // ── Resources ────────────────────────────────────────────

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return {
      resourceTemplates: [
        {
          uriTemplate: 'huly://projects/{identifier}',
          name: 'Huly Project',
          description: 'A project in the Huly workspace',
          mimeType: 'application/json'
        },
        {
          uriTemplate: 'huly://issues/{issueId}',
          name: 'Huly Issue',
          description: 'An issue in the Huly workspace (e.g., huly://issues/PROJ-42)',
          mimeType: 'application/json'
        }
      ]
    };
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      const client = await pool.getClient();
      const result = await client.withReconnect(() => client.listProjects());
      return {
        resources: result.items.map(p => ({
          uri: `huly://projects/${p.identifier}`,
          name: `${p.identifier}: ${p.name}`,
          description: `Project with ${p.issueCount} issues`,
          mimeType: 'application/json'
        }))
      };
    } catch (e) {
      console.error('ListResources failed:', e.message);
      return { resources: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    // Match huly://projects/{identifier}
    const projectMatch = uri.match(/^huly:\/\/projects\/([A-Z0-9]+)$/i);
    if (projectMatch) {
      const client = await pool.getClient();
      const result = await client.withReconnect(() =>
        client.getProject(projectMatch[1])
      );
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }

    // Match huly://issues/{issueId}
    const issueMatch = uri.match(/^huly:\/\/issues\/([A-Z0-9]+-\d+)$/i);
    if (issueMatch) {
      const client = await pool.getClient();
      const result = await client.withReconnect(() =>
        client.getIssue(issueMatch[1])
      );
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(result, null, 2)
        }]
      };
    }

    throw new Error(`Unknown resource URI: ${uri}`);
  });

  return { server, TOOLS };
}

// ── Tool Definitions ──────────────────────────────────────────
// Moved here from mcp.mjs for sharing across transports.

function getToolDefinitions() {
  return [
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

    // ── Workspace-Level Tools ──────────────────────────────
    {
      name: 'list_projects',
      description: 'List all projects in the Huly workspace. Returns each project\'s identifier (e.g., "PROJ"), display name, and total issue count. Use this first to discover available projects before querying issues. Set include_details=true to also fetch milestones, components, labels, and member names for each project (limited to 20 projects).',
      inputSchema: { type: 'object', properties: { include_details: { type: 'boolean', description: 'Include milestones, components, labels, and members for each project (default: false). Limits to 20 projects.' }, ...paginationProps, ...workspaceProp }, required: [] }
    },
    {
      name: 'get_project',
      description: 'Get details for a single project by its identifier (e.g., "PROJ"). Returns identifier, name, description, and issue count. Set include_details=true to also fetch milestones, components, labels, and resolved member names. Use list_projects first if you don\'t know the identifier.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, include_details: { type: 'boolean', description: 'Include milestones, components, labels, and members (default: false)' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'list_issues',
      description: 'List issues in a project with optional filtering and cursor-based pagination. Returns { items, nextCursor? }. Pass nextCursor from a previous response to get the next page. Default page size: 50 (20 with include_details).',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, status: { type: 'string', description: 'Filter by status: Backlog, Todo, In Progress, Done, Canceled' }, priority: { type: 'string', description: 'Filter by priority: urgent, high, medium, low, none' }, label: { type: 'string', description: 'Filter by label name (exact match)' }, milestone: { type: 'string', description: 'Filter by milestone name (exact match)' }, include_details: { type: 'boolean', description: 'Include full details: descriptions, comments, time reports, relations, and children. Reduces default page size to 20.' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_issue',
      description: 'Get full details for a specific issue by its identifier (e.g., "PROJ-42"). Returns title, description (markdown), status, priority, labels, parent issue, child count, milestone, and timestamps. Use this when you need the full description or detailed metadata for a single issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, include_details: { type: 'boolean', description: 'Include full details: comments, time reports, relations, and children.' }, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a project. Returns the new issue ID (e.g., "PROJ-43"). Supports markdown in the description field. Priority defaults to "none", status defaults to "Todo". Use list_task_types to discover available types (Issue, Epic, Bug, etc.) before specifying a type. For creating multiple issues at once, use batch_create_issues instead.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, title: { type: 'string', description: 'Issue title' }, description: { type: 'string', description: 'Issue description. Format controlled by descriptionFormat.' }, descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Format of the description field. "markdown" (default) renders Markdown syntax. "html" accepts raw HTML. "plain" stores as unformatted text.' }, priority: { type: 'string', description: 'Priority: urgent, high, medium, low, none (default: none)' }, status: { type: 'string', description: 'Initial status (default: Todo). Use list_statuses to see options.' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply. Labels are auto-created if they don\'t exist.' }, type: { type: 'string', description: 'Task type name (e.g., "Issue", "Epic", "Bug"). Use list_task_types to see available types.' }, assignee: { type: 'string', description: 'Assignee name (must match an active workspace member)' }, component: { type: 'string', description: 'Component name to assign the issue to' }, milestone: { type: 'string', description: 'Milestone name to assign the issue to' }, dueDate: { type: 'string', description: 'Due date in ISO format (e.g., "2026-04-01")' }, estimation: { type: 'number', description: 'Time estimation in hours' }, ...workspaceProp }, required: ['project', 'title'] }
    },
    {
      name: 'update_issue',
      description: 'Update one or more fields on an existing issue. Only specify the fields you want to change — omitted fields are left unchanged. Returns a list of which fields were updated. Use list_statuses to discover valid status names.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, title: { type: 'string', description: 'New title' }, description: { type: 'string', description: 'New description. Format controlled by descriptionFormat.' }, descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Format of the description field. "markdown" (default) renders Markdown syntax. "html" accepts raw HTML. "plain" stores as unformatted text.' }, priority: { type: 'string', description: 'New priority: urgent, high, medium, low, none' }, status: { type: 'string', description: 'New status: Backlog, Todo, In Progress, Done, Canceled' }, type: { type: 'string', description: 'New task type name (e.g., "Issue", "Epic", "Bug")' }, assignee: { type: 'string', description: 'New assignee name (must match an active workspace member)' }, component: { type: 'string', description: 'New component name' }, milestone: { type: 'string', description: 'New milestone name' }, dueDate: { type: 'string', description: 'New due date in ISO format (e.g., "2026-04-01")' }, estimation: { type: 'number', description: 'New time estimation in hours' }, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'add_label',
      description: 'Add a label to an issue. The label is auto-created if it doesn\'t exist yet. Returns a confirmation message. No-op if the label is already attached.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, label: { type: 'string', description: 'Label name to add' }, ...workspaceProp }, required: ['issueId', 'label'] }
    },
    {
      name: 'remove_label',
      description: 'Remove a label from an issue. Returns a confirmation or a message if the label was not found on the issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, label: { type: 'string', description: 'Label name to remove' }, ...workspaceProp }, required: ['issueId', 'label'] }
    },
    {
      name: 'list_labels',
      description: 'List all available labels in the workspace. Returns { items, nextCursor? }. Each label has name and hex color.',
      inputSchema: { type: 'object', properties: { ...paginationProps, ...workspaceProp }, required: [] }
    },
    {
      name: 'create_label',
      description: 'Create a new label for tagging issues. Returns the label ID. No-op if a label with that name already exists. Color is optional (default: teal #4ECDC4).',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Label name' }, color: { type: ['string', 'number'], description: 'Label color: name (red, salmon, pink, hotpink, magenta, purple, indigo, violet, navy, blue, sky, cyan, teal, ocean, mint, green, olive, lime, gold, orange, brown, silver, gray, slate), palette index (0-23), or RGB hex (e.g., 0xBB83FC). Default: blue' }, description: { type: 'string', description: 'Label description' }, ...workspaceProp }, required: ['name'] }
    },
    {
      name: 'update_label',
      description: 'Update an existing label\'s name, color, or description. Use list_labels to see available labels.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Current label name to find' }, newName: { type: 'string', description: 'New label name' }, color: { type: ['string', 'number'], description: 'New color: name (red, salmon, pink, hotpink, magenta, purple, indigo, violet, navy, blue, sky, cyan, teal, ocean, mint, green, olive, lime, gold, orange, brown, silver, gray, slate), palette index (0-23), or RGB hex (e.g., 0xBB83FC)' }, description: { type: 'string', description: 'New description' }, ...workspaceProp }, required: ['name'] }
    },
    {
      name: 'delete_label',
      description: 'Permanently delete a label. Irreversible — confirm with the user before proceeding.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Label name to delete' }, ...workspaceProp }, required: ['name'] }
    },
    {
      name: 'get_label',
      description: 'Get details for a specific label by name.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Label name' }, ...workspaceProp }, required: ['name'] }
    },
    {
      name: 'delete_issue',
      description: 'Permanently delete an issue. DESTRUCTIVE — confirm with the user before proceeding.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'create_project',
      description: 'Create a new project in the workspace. Returns the project identifier and details.',
      inputSchema: { type: 'object', properties: { identifier: { type: 'string', description: 'Project identifier (2-5 uppercase letters, e.g., "PROJ")' }, name: { type: 'string', description: 'Project display name' }, description: { type: 'string', description: 'Project description' }, private: { type: 'boolean', description: 'Whether the project is private (default: false)' }, ...workspaceProp }, required: ['identifier', 'name'] }
    },
    {
      name: 'update_project',
      description: 'Update a project\'s name, description, privacy, or default assignee.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, name: { type: 'string', description: 'New display name' }, description: { type: 'string', description: 'New description' }, descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format' }, isPrivate: { type: 'boolean', description: 'Privacy setting' }, defaultAssignee: { type: 'string', description: 'Default assignee name (empty string to clear)' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'delete_project',
      description: 'Permanently delete a project and ALL its issues. DESTRUCTIVE and IRREVERSIBLE — confirm with the user.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'archive_project',
      description: 'Archive or unarchive a project. Archived projects are hidden from the sidebar but data is preserved.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, archived: { type: 'boolean', description: 'true to archive, false to unarchive (default: true)' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'move_issue',
      description: 'Move an issue from one project to another. Returns the new issue identifier.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, targetProject: { type: 'string', description: 'Target project identifier' }, ...workspaceProp }, required: ['issueId', 'targetProject'] }
    },
    {
      name: 'search_issues',
      description: 'Full-text search across all projects or within a specific project. Returns matching issues ranked by relevance.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search text' }, project: { type: 'string', description: 'Limit search to this project (optional)' }, limit: { type: 'number', description: 'Max results (default: 20)' }, ...workspaceProp }, required: ['query'] }
    },

    // ── Workflow Tools ───────────────────────────────────────
    {
      name: 'get_my_issues',
      description: 'Get all issues assigned to the current user across all projects. Optionally filter by status.',
      inputSchema: { type: 'object', properties: { status: { type: 'string', description: 'Filter by status name' }, ...workspaceProp }, required: [] }
    },
    {
      name: 'batch_create_issues',
      description: 'Create multiple issues at once in a single project. Each issue can have all the same fields as create_issue. Returns created issues and any errors.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, issues: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { type: 'string' }, status: { type: 'string' }, type: { type: 'string' }, assignee: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['title'] }, description: 'Array of issues to create' }, ...workspaceProp }, required: ['project', 'issues'] }
    },
    {
      name: 'summarize_project',
      description: 'Get a statistical summary of a project: issue counts by status, priority, type, assignee, component, and label.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'create_issues_from_template',
      description: 'Create a set of issues from a predefined template. Templates: feature (epic + design/implement/test/docs/review), bug (reproduce/root-cause/fix/regression-test), sprint (planning/standup/review/retro), release (freeze/QA/changelog/staging/prod/verify).',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, template: { type: 'string', enum: ['feature', 'bug', 'sprint', 'release'], description: 'Template name' }, title: { type: 'string', description: 'Title prefix for generated issues' }, ...workspaceProp }, required: ['project', 'template', 'title'] }
    },

    // ── Relations ────────────────────────────────────────────
    {
      name: 'add_relation',
      description: 'Add a "related to" link between two issues. Both directions are visible.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Source issue (e.g., "PROJ-1")' }, relatedIssueId: { type: 'string', description: 'Target issue (e.g., "PROJ-2")' }, ...workspaceProp }, required: ['issueId', 'relatedIssueId'] }
    },
    {
      name: 'add_blocked_by',
      description: 'Mark an issue as blocked by another issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Blocked issue (e.g., "PROJ-1")' }, blockerIssueId: { type: 'string', description: 'Blocking issue (e.g., "PROJ-2")' }, ...workspaceProp }, required: ['issueId', 'blockerIssueId'] }
    },
    {
      name: 'set_parent',
      description: 'Set an issue\'s parent (make it a sub-issue). Pass empty parentId to remove parent.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Child issue (e.g., "PROJ-2")' }, parentId: { type: 'string', description: 'Parent issue (e.g., "PROJ-1"). Empty to remove parent.' }, ...workspaceProp }, required: ['issueId', 'parentId'] }
    },

    // ── Components ───────────────────────────────────────────
    {
      name: 'list_components',
      description: 'List all components in a project. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_component',
      description: 'Get details for a specific component by name.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Component name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'create_component',
      description: 'Create a new component in a project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Component name' }, description: { type: 'string', description: 'Component description' }, lead: { type: 'string', description: 'Lead member name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'update_component',
      description: 'Update a component\'s name, description, or lead.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Current component name' }, newName: { type: 'string', description: 'New component name' }, description: { type: 'string', description: 'New description' }, lead: { type: 'string', description: 'Lead member name (empty string to clear)' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'delete_component',
      description: 'Delete a component from a project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Component name' }, ...workspaceProp }, required: ['project', 'name'] }
    },

    // ── Milestones ───────────────────────────────────────────
    {
      name: 'list_milestones',
      description: 'List all milestones in a project. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, include_details: { type: 'boolean', description: 'Include issue list for each milestone' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_milestone',
      description: 'Get details for a specific milestone by name.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, include_details: { type: 'boolean', description: 'Include issue list' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'create_milestone',
      description: 'Create a new milestone in a project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, description: { type: 'string', description: 'Milestone description' }, status: { type: 'string', description: 'Status: planned, in progress, completed, cancelled' }, startDate: { type: 'string', description: 'Start date (ISO format)' }, targetDate: { type: 'string', description: 'Target date (ISO format)' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'update_milestone',
      description: 'Update a milestone\'s name, description, status, or dates.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Current milestone name' }, newName: { type: 'string', description: 'New name' }, description: { type: 'string', description: 'New description' }, status: { type: 'string', description: 'New status: planned, in progress, completed, cancelled' }, startDate: { type: 'string', description: 'New start date' }, targetDate: { type: 'string', description: 'New target date' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'delete_milestone',
      description: 'Delete a milestone from a project. Issues assigned to it will be unlinked.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'set_milestone',
      description: 'Assign an issue to a milestone by name.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, milestone: { type: 'string', description: 'Milestone name (empty to remove)' }, ...workspaceProp }, required: ['issueId', 'milestone'] }
    },

    // ── Members ──────────────────────────────────────────────
    {
      name: 'list_members',
      description: 'List all active members of the workspace. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { ...paginationProps, ...workspaceProp }, required: [] }
    },
    {
      name: 'get_member',
      description: 'Get details for a specific workspace member by name.',
      inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Member name (case-insensitive partial match)' }, ...workspaceProp }, required: ['name'] }
    },

    // ── Comments ─────────────────────────────────────────────
    {
      name: 'list_comments',
      description: 'List comments on an issue. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, ...paginationProps, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'get_comment',
      description: 'Get a specific comment by its ID.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, commentId: { type: 'string', description: 'Comment ID' }, ...workspaceProp }, required: ['issueId', 'commentId'] }
    },
    {
      name: 'add_comment',
      description: 'Add a comment to an issue. Supports markdown formatting.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, text: { type: 'string', description: 'Comment text (supports markdown)' }, format: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Text format (default: markdown)' }, ...workspaceProp }, required: ['issueId', 'text'] }
    },
    {
      name: 'update_comment',
      description: 'Update the text of an existing comment.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, commentId: { type: 'string', description: 'Comment ID' }, text: { type: 'string', description: 'New comment text' }, format: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Text format (default: markdown)' }, ...workspaceProp }, required: ['issueId', 'commentId', 'text'] }
    },
    {
      name: 'delete_comment',
      description: 'Delete a comment from an issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, commentId: { type: 'string', description: 'Comment ID' }, ...workspaceProp }, required: ['issueId', 'commentId'] }
    },

    // ── Metadata ─────────────────────────────────────────────
    {
      name: 'list_statuses',
      description: 'List issue statuses available in a project. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_status',
      description: 'Get details for a specific status by name.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Status name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'list_task_types',
      description: 'List task types available in a project. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_task_type',
      description: 'Get details for a specific task type by name.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Task type name' }, ...workspaceProp }, required: ['project', 'name'] }
    },

    // ── Time Tracking ────────────────────────────────────────
    {
      name: 'log_time',
      description: 'Log time spent on an issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, hours: { type: 'number', description: 'Hours spent' }, description: { type: 'string', description: 'Description of work done' }, ...workspaceProp }, required: ['issueId', 'hours'] }
    },
    {
      name: 'list_time_reports',
      description: 'List time reports for an issue. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, ...paginationProps, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'get_time_report',
      description: 'Get details for a specific time report.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, reportId: { type: 'string', description: 'Time report ID' }, ...workspaceProp }, required: ['issueId', 'reportId'] }
    },
    {
      name: 'delete_time_report',
      description: 'Delete a time report.',
      inputSchema: { type: 'object', properties: { reportId: { type: 'string', description: 'Time report ID' }, ...workspaceProp }, required: ['reportId'] }
    },
  ];
}
