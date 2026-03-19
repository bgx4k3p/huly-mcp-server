#!/usr/bin/env node
/**
 * Huly MCP Server - stdio transport entry point for Claude Code.
 *
 * Uses the shared ConnectionPool for multi-workspace support.
 * Each tool accepts an optional 'workspace' parameter.
 * Exposes MCP Resources for projects and issues.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { pool } from './pool.mjs';
import { HulyClient } from './client.mjs';
import { accountTools, workspaceTools } from './dispatch.mjs';

const HULY_URL = process.env.HULY_URL || 'http://localhost:8087';
const HULY_TOKEN = process.env.HULY_TOKEN;
const HULY_EMAIL = process.env.HULY_EMAIL;
const HULY_PASSWORD = process.env.HULY_PASSWORD;
const HULY_CREDS = HULY_TOKEN ? { token: HULY_TOKEN } : { email: HULY_EMAIL, password: HULY_PASSWORD };

// Optional workspace property added to every tool
const workspaceProp = {
  workspace: {
    type: 'string',
    description: 'Workspace slug (optional, uses HULY_WORKSPACE env var if omitted). Use list_workspaces to discover available workspace slugs.'
  }
};

// Tool definitions with enriched descriptions for AI agents
const TOOLS = [
  // ── Account & Workspace Management ──────────────────────

  {
    name: 'list_workspaces',
    description: 'List all workspaces accessible to the authenticated user. Returns each workspace\'s slug, name, mode (active/archived), and creation date. Use this to discover available workspaces before specifying a workspace parameter on other tools.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_workspace_info',
    description: 'Get detailed info about a specific workspace by slug. Returns name, mode, version, creation date, and usage info.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' }
      },
      required: ['workspace']
    }
  },
  {
    name: 'create_workspace',
    description: 'Create a new workspace. Returns the new workspace slug and ID. WARNING: This is a significant operation — confirm with the user before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Workspace display name' }
      },
      required: ['name']
    }
  },
  {
    name: 'update_workspace_name',
    description: 'Rename an existing workspace. Only changes the display name, not the slug.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' },
        name: { type: 'string', description: 'New display name' }
      },
      required: ['workspace', 'name']
    }
  },
  {
    name: 'delete_workspace',
    description: 'Permanently delete a workspace and ALL its data (projects, issues, members). DESTRUCTIVE and IRREVERSIBLE — confirm with the user before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug to delete' }
      },
      required: ['workspace']
    }
  },
  {
    name: 'get_workspace_members',
    description: 'List all members of a workspace with their roles. Returns member ID, name, email, and role (OWNER/MAINTAINER/MEMBER/GUEST).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' }
      },
      required: ['workspace']
    }
  },
  {
    name: 'update_workspace_role',
    description: 'Change a member\'s role in a workspace. Roles: OWNER, MAINTAINER, MEMBER, GUEST.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' },
        email: { type: 'string', description: 'Member email address' },
        role: { type: 'string', description: 'New role: OWNER, MAINTAINER, MEMBER, GUEST' }
      },
      required: ['workspace', 'email', 'role']
    }
  },
  {
    name: 'get_account_info',
    description: 'Get the current authenticated user\'s account info including ID, name, and social IDs.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_user_profile',
    description: 'Get the current user\'s profile including name, avatar, city, and country.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'set_my_profile',
    description: 'Update the current user\'s profile. Only specify the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'New display name' },
        city: { type: 'string', description: 'City' },
        country: { type: 'string', description: 'Country' }
      },
      required: []
    }
  },
  {
    name: 'change_password',
    description: 'Change the current user\'s password. Requires the current password (from HULY_PASSWORD env var) and a new password.',
    inputSchema: {
      type: 'object',
      properties: {
        newPassword: { type: 'string', description: 'New password' }
      },
      required: ['newPassword']
    }
  },
  {
    name: 'change_username',
    description: 'Change the current user\'s username/display name at the account level.',
    inputSchema: {
      type: 'object',
      properties: {
        newUsername: { type: 'string', description: 'New username' }
      },
      required: ['newUsername']
    }
  },

  // ── Invites ──────────────────────────────────────────────

  {
    name: 'send_invite',
    description: 'Send an email invite to join a workspace. Specify the workspace slug, the invitee\'s email, and an optional role (default: MEMBER).',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' },
        email: { type: 'string', description: 'Email address to invite' },
        role: { type: 'string', description: 'Role: OWNER, MAINTAINER, MEMBER, GUEST (default: MEMBER)' }
      },
      required: ['workspace', 'email']
    }
  },
  {
    name: 'resend_invite',
    description: 'Resend a pending workspace invitation.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' },
        email: { type: 'string', description: 'Email of the pending invitee' }
      },
      required: ['workspace', 'email']
    }
  },
  {
    name: 'create_invite_link',
    description: 'Create a shareable invite link for a workspace. Returns the link URL. Default expiry: 48 hours.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: { type: 'string', description: 'Workspace slug' },
        role: { type: 'string', description: 'Role for invitees: OWNER, MAINTAINER, MEMBER, GUEST (default: MEMBER)' },
        expireHours: { type: 'number', description: 'Link expiry in hours (default: 48)' }
      },
      required: ['workspace']
    }
  },

  // ── Integrations ─────────────────────────────────────────

  {
    name: 'list_integrations',
    description: 'List all integrations configured for the account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'get_integration',
    description: 'Get details of a specific integration by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        integrationId: { type: 'string', description: 'Integration ID' }
      },
      required: ['integrationId']
    }
  },
  {
    name: 'create_integration',
    description: 'Create a new integration. Pass integration-specific data as the "data" object.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Integration configuration data' }
      },
      required: ['data']
    }
  },
  {
    name: 'update_integration',
    description: 'Update an existing integration by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        integrationId: { type: 'string', description: 'Integration ID' },
        data: { type: 'object', description: 'Updated integration configuration data' }
      },
      required: ['integrationId', 'data']
    }
  },
  {
    name: 'delete_integration',
    description: 'Delete an integration by ID. This is irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        integrationId: { type: 'string', description: 'Integration ID' }
      },
      required: ['integrationId']
    }
  },

  // ── Mailboxes ────────────────────────────────────────────

  {
    name: 'list_mailboxes',
    description: 'List all mailboxes configured for the account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'create_mailbox',
    description: 'Create a new mailbox. Pass mailbox configuration as the "data" object.',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'object', description: 'Mailbox configuration data' }
      },
      required: ['data']
    }
  },
  {
    name: 'delete_mailbox',
    description: 'Delete a mailbox by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        mailboxId: { type: 'string', description: 'Mailbox ID' }
      },
      required: ['mailboxId']
    }
  },

  // ── Person / Social ID ──────────────────────────────────

  {
    name: 'find_person_by_social_key',
    description: 'Find a person record by their social key (e.g., email, GitHub handle).',
    inputSchema: {
      type: 'object',
      properties: {
        socialKey: { type: 'string', description: 'Social key to search for' }
      },
      required: ['socialKey']
    }
  },
  {
    name: 'get_social_ids',
    description: 'Get all social IDs (email, GitHub, etc.) linked to the current user\'s account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'add_email_social_id',
    description: 'Link an additional email address to a person\'s account.',
    inputSchema: {
      type: 'object',
      properties: {
        targetEmail: { type: 'string', description: 'Email address to link' }
      },
      required: ['targetEmail']
    }
  },

  // ── Subscriptions ────────────────────────────────────────

  {
    name: 'list_subscriptions',
    description: 'List all subscriptions for the current account.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // ── Workspace-Level Tools ──────────────────────────────

  {
    name: 'list_projects',
    description: 'List all projects in the Huly workspace. Returns each project\'s identifier (e.g., "PROJ"), display name, and total issue count. Use this first to discover available projects before querying issues.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceProp },
      required: []
    }
  },
  {
    name: 'get_project',
    description: 'Get details for a single project by its identifier (e.g., "PROJ"). Returns identifier, name, description, and issue count. Use list_projects first if you don\'t know the identifier.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'list_issues',
    description: 'List issues in a project with optional filtering. Returns id, title, status, priority, type (Task/Epic/Bug), assignee, component, labels, milestone, parent issue, childCount, dueDate, estimation, reportedTime, createdOn, modifiedOn, and completedAt for each issue. Supports filtering by status, priority, label, and milestone. Default limit 500, auto-paginates. Use search_issues for full-text search across projects.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        status: { type: 'string', description: 'Filter by status: Backlog, Todo, In Progress, Done, Canceled' },
        priority: { type: 'string', description: 'Filter by priority: urgent, high, medium, low, none' },
        label: { type: 'string', description: 'Filter by label name (exact match)' },
        milestone: { type: 'string', description: 'Filter by milestone name (exact match)' },
        limit: { type: 'number', description: 'Maximum number of issues to return (default: 500)' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'get_issue',
    description: 'Get full details for a specific issue by its identifier (e.g., "PROJ-42"). Returns title, description (markdown), status, priority, labels, parent issue, child count, milestone, and timestamps. Use this when you need the full description or detailed metadata for a single issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a project. Returns the new issue ID (e.g., "PROJ-43"). Supports markdown in the description field. Priority defaults to "none", status defaults to "Todo". Use list_task_types to discover available types (Issue, Epic, Bug, etc.) before specifying a type. For creating multiple issues at once, use batch_create_issues instead.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        title: { type: 'string', description: 'Issue title' },
        description: { type: 'string', description: 'Issue description. Format controlled by descriptionFormat.' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Format of the description field. "markdown" (default) renders Markdown syntax. "html" accepts raw HTML. "plain" stores as unformatted text.' },
        priority: { type: 'string', description: 'Priority: urgent, high, medium, low, none (default: none)' },
        status: { type: 'string', description: 'Initial status (default: Todo). Use list_statuses to see options.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply. Labels are auto-created if they don\'t exist.' },
        type: { type: 'string', description: 'Task type name (e.g., "Issue", "Epic", "Bug"). Use list_task_types to see available types.' },
        assignee: { type: 'string', description: 'Assignee name (must match an active workspace member)' },
        component: { type: 'string', description: 'Component name to assign the issue to' },
        milestone: { type: 'string', description: 'Milestone name to assign the issue to' },
        dueDate: { type: 'string', description: 'Due date in ISO format (e.g., "2026-04-01")' },
        estimation: { type: 'number', description: 'Time estimation in hours' },
        ...workspaceProp
      },
      required: ['project', 'title']
    }
  },
  {
    name: 'update_issue',
    description: 'Update one or more fields on an existing issue. Only specify the fields you want to change — omitted fields are left unchanged. Returns a list of which fields were updated. Use list_statuses to discover valid status names.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        title: { type: 'string', description: 'New title' },
        description: { type: 'string', description: 'New description. Format controlled by descriptionFormat.' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Format of the description field. "markdown" (default) renders Markdown syntax. "html" accepts raw HTML. "plain" stores as unformatted text.' },
        priority: { type: 'string', description: 'New priority: urgent, high, medium, low, none' },
        status: { type: 'string', description: 'New status: Backlog, Todo, In Progress, Done, Canceled' },
        type: { type: 'string', description: 'New task type name (e.g., "Issue", "Epic", "Bug")' },
        assignee: { type: 'string', description: 'New assignee name (must match an active workspace member)' },
        component: { type: 'string', description: 'New component name' },
        milestone: { type: 'string', description: 'New milestone name' },
        dueDate: { type: 'string', description: 'New due date in ISO format (e.g., "2026-04-01")' },
        estimation: { type: 'number', description: 'New time estimation in hours' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'add_label',
    description: 'Add a label to an issue. The label is auto-created if it doesn\'t exist yet. Returns a confirmation message. No-op if the label is already attached.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        label: { type: 'string', description: 'Label name to add' },
        ...workspaceProp
      },
      required: ['issueId', 'label']
    }
  },
  {
    name: 'remove_label',
    description: 'Remove a label from an issue. Returns a confirmation or a message if the label was not found on the issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        label: { type: 'string', description: 'Label name to remove' },
        ...workspaceProp
      },
      required: ['issueId', 'label']
    }
  },
  {
    name: 'list_labels',
    description: 'List all available labels in the workspace. Returns each label\'s name and hex color. Use this to discover existing labels before adding them to issues.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceProp },
      required: []
    }
  },
  {
    name: 'create_label',
    description: 'Create a new label for tagging issues. Returns the label ID. No-op if a label with that name already exists. Color is optional (default: teal #4ECDC4).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Label name' },
        color: { type: ['string', 'number'], description: 'Label color: name (red, salmon, pink, hotpink, magenta, purple, indigo, violet, navy, blue, sky, cyan, teal, ocean, mint, green, olive, lime, gold, orange, brown, silver, gray, slate), palette index (0-23), or RGB hex (e.g., 0xBB83FC). Default: blue' },
        ...workspaceProp
      },
      required: ['name']
    }
  },
  {
    name: 'update_label',
    description: 'Update an existing label\'s name, color, or description. Use list_labels to see available labels.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Current label name to find' },
        newName: { type: 'string', description: 'New label name' },
        color: { type: ['string', 'number'], description: 'New color: name (red, salmon, pink, hotpink, magenta, purple, indigo, violet, navy, blue, sky, cyan, teal, ocean, mint, green, olive, lime, gold, orange, brown, silver, gray, slate), palette index (0-23), or RGB hex (e.g., 0xBB83FC)' },
        description: { type: 'string', description: 'New description' },
        ...workspaceProp
      },
      required: ['name']
    }
  },
  {
    name: 'add_relation',
    description: 'Add a bidirectional "related to" relationship between two issues. Use this for issues that are related but not blocking each other. For dependencies, use add_blocked_by instead.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        relatedToIssueId: { type: 'string', description: 'The issue to relate to (e.g., "PROJ-99")' },
        ...workspaceProp
      },
      required: ['issueId', 'relatedToIssueId']
    }
  },
  {
    name: 'add_blocked_by',
    description: 'Add a "blocked by" dependency between two issues. The first issue (issueId) is marked as blocked by the second (blockedByIssueId). Use this for hard dependencies where one issue cannot proceed until another is done. For soft relationships, use add_relation instead.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue that is blocked (e.g., "PROJ-42")' },
        blockedByIssueId: { type: 'string', description: 'The blocking issue (e.g., "PROJ-99")' },
        ...workspaceProp
      },
      required: ['issueId', 'blockedByIssueId']
    }
  },
  {
    name: 'set_parent',
    description: 'Set the parent issue for a child issue, creating a hierarchy (e.g., link a task to an epic). The child appears as a sub-issue under the parent. Use this to build work breakdown structures.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Child issue identifier (e.g., "PROJ-42")' },
        parentIssueId: { type: 'string', description: 'Parent issue identifier (e.g., "PROJ-1" for an epic)' },
        ...workspaceProp
      },
      required: ['issueId', 'parentIssueId']
    }
  },
  {
    name: 'list_task_types',
    description: 'List all available task types for a project (e.g., Issue, Epic, Bug). Returns type ID, name, and description. Use this before create_issue or update_issue when you need to specify a task type.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'list_statuses',
    description: 'List available issue statuses. By default returns ALL statuses across all task types. Use project and/or taskType to scope results — different task types (e.g., "Task" vs "Epic") may have different statuses. Returns status ID, name, category, and color.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier to scope statuses (e.g., "PROJ")' },
        taskType: { type: 'string', description: 'Task type name to scope statuses (e.g., "Task", "Epic")' },
        ...workspaceProp
      },
      required: []
    }
  },
  {
    name: 'list_milestones',
    description: 'List all milestones in a project, sorted by target date. Returns name, description, status (Planned/In Progress/Completed/Canceled), and target date. Supports optional status filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        status: { type: 'string', description: 'Filter by status: Planned, In Progress, Completed, Canceled' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'get_milestone',
    description: 'Get details for a specific milestone by name, including the count of issues assigned to it. Use list_milestones first if you don\'t know the exact name.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Milestone name/label (exact match, case-insensitive)' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },
  {
    name: 'create_milestone',
    description: 'Create a new milestone in a project. Returns the milestone ID. No-op if a milestone with that name already exists. Target date defaults to 30 days from now if not specified.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Milestone name/label' },
        description: { type: 'string', description: 'Milestone description' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        targetDate: { type: 'string', description: 'Target date (ISO 8601 format, e.g., "2025-03-01"). Default: 30 days from now.' },
        status: { type: 'string', description: 'Initial status: Planned, In Progress, Completed, Canceled (default: Planned)' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },
  {
    name: 'set_milestone',
    description: 'Set or clear the milestone on an issue. Pass a milestone name to assign, or omit/empty to clear. Use list_milestones to discover available milestone names.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        milestone: { type: 'string', description: 'Milestone name to set, or empty/null to clear' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'assign_issue',
    description: 'Assign an issue to a workspace member by name or email. Pass an empty string to unassign. Uses fuzzy matching on member names — use list_members first if unsure of the exact name.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        assignee: { type: 'string', description: 'Member name or email. Empty string to unassign.' },
        ...workspaceProp
      },
      required: ['issueId', 'assignee']
    }
  },
  {
    name: 'list_members',
    description: 'List all active workspace members. Returns each member\'s ID, name, email, role, and position. Use this to discover member names before assigning issues.',
    inputSchema: {
      type: 'object',
      properties: { ...workspaceProp },
      required: []
    }
  },
  {
    name: 'add_comment',
    description: 'Add a comment to an issue. Supports markdown, HTML, or plain text via the format parameter. Returns the comment ID. Use list_comments to see existing comments.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        text: { type: 'string', description: 'Comment text' },
        format: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Text format (default: markdown)' },
        ...workspaceProp
      },
      required: ['issueId', 'text']
    }
  },
  {
    name: 'list_comments',
    description: 'List all comments on an issue, sorted chronologically (oldest first). Returns comment ID, text, and timestamps.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'set_due_date',
    description: 'Set or clear the due date on an issue. Pass an ISO 8601 date string to set, or omit/empty to clear. Returns confirmation with the date value.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        dueDate: { type: 'string', description: 'Due date (ISO 8601, e.g., "2026-04-01"). Empty to clear.' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'set_estimation',
    description: 'Set the time estimation on an issue in hours. This represents the expected effort to complete the issue. Use log_time to record actual time spent.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        hours: { type: 'number', description: 'Estimated hours (e.g., 4.5)' },
        ...workspaceProp
      },
      required: ['issueId', 'hours']
    }
  },
  {
    name: 'log_time',
    description: 'Log actual time spent working on an issue. Adds to the issue\'s cumulative reported time. Use set_estimation to set expected effort. Returns the new total reported time.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        hours: { type: 'number', description: 'Hours spent (e.g., 2.5)' },
        description: { type: 'string', description: 'Description of work done' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        ...workspaceProp
      },
      required: ['issueId', 'hours']
    }
  },
  {
    name: 'search_issues',
    description: 'Full-text search across issue titles in all projects (or a specific project). Returns matching issues with id, title, status, and priority. Use this when you need to find issues by keyword. For structured filtering (by status, priority, label), use list_issues instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search text (matches against issue titles)' },
        project: { type: 'string', description: 'Optional project identifier to limit search scope' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
        ...workspaceProp
      },
      required: ['query']
    }
  },

  // ── New Tools (Tier 1–2) ────────────────────────────────────

  {
    name: 'get_my_issues',
    description: 'Get all issues assigned to the currently authenticated user (identified by HULY_EMAIL). Returns id, title, status, priority, labels, due date, estimation, and last modified time. Great for "what\'s on my plate?" queries. Supports optional project and status filters.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Optional project identifier to filter by' },
        status: { type: 'string', description: 'Optional status filter: Backlog, Todo, In Progress, Done, Canceled' },
        limit: { type: 'number', description: 'Max results (default: 500)' },
        ...workspaceProp
      },
      required: []
    }
  },
  {
    name: 'batch_create_issues',
    description: 'Create multiple issues in a single operation. Much more efficient than calling create_issue in a loop. Pass an array of issue objects, each with at least a title. Returns a summary with all created issues and any errors. Use this for breaking down epics, importing tasks, or creating sprint backlogs.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        issues: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'Issue title (required)' },
              description: { type: 'string', description: 'Markdown description' },
              priority: { type: 'string', description: 'Priority: urgent, high, medium, low, none' },
              status: { type: 'string', description: 'Initial status (default: Todo)' },
              labels: { type: 'array', items: { type: 'string' }, description: 'Label names' },
              type: { type: 'string', description: 'Task type (e.g., "Issue", "Bug")' },
              assignee: { type: 'string', description: 'Assignee name' },
              component: { type: 'string', description: 'Component name' },
              milestone: { type: 'string', description: 'Milestone name' },
              dueDate: { type: 'string', description: 'Due date ISO format' },
              estimation: { type: 'number', description: 'Estimation in hours' },
              descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' }
            },
            required: ['title']
          },
          description: 'Array of issue objects to create'
        },
        ...workspaceProp
      },
      required: ['project', 'issues']
    }
  },
  {
    name: 'move_issue',
    description: 'Move an issue from its current project to a different project. The issue gets a new identifier in the target project (e.g., "OLD-42" becomes "NEW-15"). Use this during triage to route issues to the correct team.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        targetProject: { type: 'string', description: 'Target project identifier (e.g., "NEWPROJ")' },
        ...workspaceProp
      },
      required: ['issueId', 'targetProject']
    }
  },
  {
    name: 'summarize_project',
    description: 'Get a comprehensive project summary with aggregated metrics. Returns: total issue count, breakdown by status and priority, list of overdue issues, unassigned issue count, milestone overview, and time tracking totals (estimated vs. reported hours). Use this for standup summaries, sprint reviews, or project health checks. Much more efficient than fetching all issues and computing stats manually.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'get_issue_history',
    description: 'Get the activity timeline for an issue including comments, time logs, sub-issues, and labels. Returns events sorted chronologically. Use this to understand what has happened on an issue, for status updates, or to answer "what changed since yesterday?".',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'create_issues_from_template',
    description: 'Create a structured set of issues from a predefined template. Available templates: "feature" (epic + design/implement/test/docs/review), "bug" (bug + reproduce/root-cause/fix/regression-test), "sprint" (planning/standup/review/retro ceremonies), "release" (epic + freeze/QA/changelog/staging/prod/verify). Templates auto-create parent-child hierarchies. Pass a title param to customize issue names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        template: { type: 'string', description: 'Template name: feature, bug, sprint, release' },
        title: { type: 'string', description: 'Custom title/name for the template items (e.g., "User Authentication" for a feature template)' },
        version: { type: 'string', description: 'Version string (used by release template, e.g., "v2.1.0")' },
        ...workspaceProp
      },
      required: ['project', 'template']
    }
  },

  // ── Project Management ──────────────────────────────────────

  {
    name: 'create_project',
    description: 'Create a new tracker project in the workspace. Returns the new project identifier and ID. The identifier is auto-generated from the name (e.g., "My Project" → "MYPR") unless the Huly server assigns one. Use list_projects to verify creation.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project display name' },
        identifier: { type: 'string', description: 'Project identifier (e.g., "PROJ"). If omitted, auto-generated from name.' },
        description: { type: 'string', description: 'Project description' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        private: { type: 'boolean', description: 'Whether the project is private (default: false)' },
        projectType: { type: 'string', description: 'Project type name (e.g., "Classic project"). Auto-resolved if workspace has only one type.' },
        ...workspaceProp
      },
      required: ['name']
    }
  },
  {
    name: 'update_project',
    description: 'Update a project\'s name, description, default assignee, or privacy. Only specify fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'New project name' },
        description: { type: 'string', description: 'New description' },
        private: { type: 'boolean', description: 'Set project privacy' },
        defaultAssignee: { type: 'string', description: 'Default assignee name. Empty string to clear.' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'archive_project',
    description: 'Archive or unarchive a project. Archived projects are hidden from default views but retain all data. Pass archived=true to archive, archived=false to unarchive. Returns confirmation of the new state.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        archived: { type: 'boolean', description: 'true to archive, false to unarchive' },
        ...workspaceProp
      },
      required: ['project', 'archived']
    }
  },
  {
    name: 'delete_project',
    description: 'DESTRUCTIVE: Permanently delete a project and all its issues. This cannot be undone. All issues, milestones, components, and time reports in the project will be lost. Always confirm with the user before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        ...workspaceProp
      },
      required: ['project']
    }
  },

  // ── Issue Deletion ──────────────────────────────────────────

  {
    name: 'delete_issue',
    description: 'DESTRUCTIVE: Permanently delete an issue and all its sub-issues, comments, and time reports. This cannot be undone. Always confirm with the user before proceeding.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },

  // ── Milestone Management ────────────────────────────────────

  {
    name: 'update_milestone',
    description: 'Update one or more fields on an existing milestone. Only specify the fields you want to change — omitted fields are left unchanged. Returns the updated milestone details. Use list_milestones to discover milestone names.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Current milestone name (used to find it)' },
        newName: { type: 'string', description: 'New milestone name' },
        description: { type: 'string', description: 'New description' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        status: { type: 'string', description: 'New status: Planned, In Progress, Completed, Canceled' },
        targetDate: { type: 'string', description: 'New target date (ISO 8601, e.g., "2026-06-01")' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },
  {
    name: 'delete_milestone',
    description: 'Delete a milestone from a project. Issues assigned to this milestone will have their milestone cleared. Returns confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Milestone name to delete (exact match, case-insensitive)' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },

  // ── Components ──────────────────────────────────────────────

  {
    name: 'list_components',
    description: 'List all components in a project. Components are used to categorize issues by subsystem or area (e.g., "Frontend", "API", "Database"). Returns component name, description, and lead (if assigned).',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        ...workspaceProp
      },
      required: ['project']
    }
  },
  {
    name: 'create_component',
    description: 'Create a new component in a project. Components categorize issues by subsystem or area. Returns the new component ID. No-op if a component with that name already exists.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Component name (e.g., "Frontend", "API")' },
        description: { type: 'string', description: 'Component description' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        lead: { type: 'string', description: 'Component lead — member name or email (optional)' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },
  {
    name: 'update_component',
    description: 'Update one or more fields on an existing component. Only specify the fields you want to change — omitted fields are left unchanged. Returns the updated component details.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Current component name (used to find it)' },
        newName: { type: 'string', description: 'New component name' },
        description: { type: 'string', description: 'New description' },
        descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Description format (default: markdown)' },
        lead: { type: 'string', description: 'New lead — member name or email, or empty to clear' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },
  {
    name: 'delete_component',
    description: 'Delete a component from a project. Issues assigned to this component will have their component cleared. Returns confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' },
        name: { type: 'string', description: 'Component name to delete' },
        ...workspaceProp
      },
      required: ['project', 'name']
    }
  },

  // ── Time Reports ────────────────────────────────────────────

  {
    name: 'list_time_reports',
    description: 'List all time reports (logged time entries) for an issue. Returns each report\'s ID, hours, description, author, and date. Use this to audit time tracking or review work logs before deleting a report.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        ...workspaceProp
      },
      required: ['issueId']
    }
  },
  {
    name: 'delete_time_report',
    description: 'Delete a specific time report from an issue. Use list_time_reports first to find the report ID. The issue\'s total reported time will be reduced accordingly.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        reportId: { type: 'string', description: 'Time report ID (from list_time_reports)' },
        ...workspaceProp
      },
      required: ['issueId', 'reportId']
    }
  },

  // ── Comment Management ──────────────────────────────────────

  {
    name: 'update_comment',
    description: 'Update the text of an existing comment on an issue. Use list_comments to find the comment ID. Returns the updated comment.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        commentId: { type: 'string', description: 'Comment ID (from list_comments)' },
        text: { type: 'string', description: 'New comment text' },
        format: { type: 'string', enum: ['markdown', 'html', 'plain'], description: 'Text format (default: markdown)' },
        ...workspaceProp
      },
      required: ['issueId', 'commentId', 'text']
    }
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment from an issue. Use list_comments to find the comment ID. Returns confirmation. This cannot be undone.',
    inputSchema: {
      type: 'object',
      properties: {
        issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' },
        commentId: { type: 'string', description: 'Comment ID (from list_comments)' },
        ...workspaceProp
      },
      required: ['issueId', 'commentId']
    }
  }
];


/**
 * Route a tool call to the appropriate HulyClient method.
 * Uses shared dispatch table from dispatch.mjs.
 */
async function handleToolCall(name, args) {
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

// Create and run the MCP server
const server = new Server(
  { name: 'huly-mcp-server', version: '2.0.0' },
  { capabilities: { tools: {}, resources: {} } }
);

// ── Tools ──────────────────────────────────────────────────────

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

// ── Resources ──────────────────────────────────────────────────

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
    const projects = await client.withReconnect(() => client.listProjects());
    return {
      resources: projects.map(p => ({
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

// ── Start ──────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Huly MCP Server v2.0.0 running on stdio (46 tools, resources enabled)');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
