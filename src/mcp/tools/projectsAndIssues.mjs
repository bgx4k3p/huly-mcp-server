/**
 * Project, issue and label tools.
 */
import {
  descriptionFormatProp,
  issueProjectionProps,
  paginationProps,
  projectIncludeProp,
  projectSettingsProps,
  workspaceProp
} from '../schemaFragments.mjs';

/** @type {Object[]} */
export const projectsAndIssuesTools = [
    // ── Workspace-Level Tools ──────────────────────────────
    {
      name: 'list_projects',
      description: 'List projects with stable pagination and optional granular expansions. Returns each project\'s identifier, display name, and issue count. Use this first to discover projects.',
      inputSchema: { type: 'object', properties: { ...projectIncludeProp, ...paginationProps, ...workspaceProp }, required: [] }
    },
    {
      name: 'get_project',
      description: 'Get a project by identifier with optional granular expansions. Returns identifier, name, description, and issue count. Use list_projects first if needed.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, ...projectIncludeProp, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'list_issues',
      description: 'List issues with filters, stable cursor pagination, selectable base fields, and independently bounded detail expansions. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, status: { type: 'string', description: 'Filter by status: Backlog, Todo, In Progress, Done, Canceled' }, priority: { type: 'string', description: 'Filter by priority: urgent, high, medium, low, none' }, label: { type: 'string', description: 'Filter by label name (exact match)' }, milestone: { type: 'string', description: 'Filter by milestone name (exact match)' }, ...issueProjectionProps, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_issue',
      description: 'Get one issue with selectable base fields and independently bounded expansions. The complete markdown description is returned by default; set include explicitly to change expansions.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, ...issueProjectionProps, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'create_issue',
      description: 'Create a new issue in a project. Returns the new issue ID (e.g., "PROJ-43"). Supports markdown in the description field. Priority defaults to "none", status defaults to "Todo". Use list_task_types to discover available types (Issue, Epic, Bug, etc.) before specifying a type. For creating multiple issues at once, use batch_create_issues instead.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, title: { type: 'string', description: 'Issue title' }, description: { type: 'string', description: 'Issue description. Format controlled by descriptionFormat.' }, ...descriptionFormatProp, priority: { type: 'string', description: 'Priority: urgent, high, medium, low, none (default: none)' }, status: { type: 'string', description: 'Initial status (default: Todo). Use list_statuses to see options.' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply. Labels are auto-created if they don\'t exist.' }, type: { type: 'string', description: 'Task type name (e.g., "Issue", "Epic", "Bug"). Use list_task_types to see available types.' }, assignee: { type: 'string', description: 'Assignee name (must match an active workspace member)' }, component: { type: 'string', description: 'Component name to assign the issue to' }, milestone: { type: 'string', description: 'Milestone name to assign the issue to' }, dueDate: { type: 'string', description: 'Due date in ISO format (e.g., "2026-04-01")' }, estimation: { type: 'number', description: 'Time estimation in hours' }, ...workspaceProp }, required: ['project', 'title'] }
    },
    {
      name: 'update_issue',
      description: 'Update one or more fields on an existing issue. Only specify the fields you want to change — omitted fields are left unchanged. Returns a list of which fields were updated. Use list_statuses to discover valid status names.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, title: { type: 'string', description: 'New title' }, description: { type: 'string', description: 'New description. Format controlled by descriptionFormat.' }, ...descriptionFormatProp, priority: { type: 'string', description: 'New priority: urgent, high, medium, low, none' }, status: { type: 'string', description: 'New status: Backlog, Todo, In Progress, Done, Canceled' }, type: { type: 'string', description: 'New task type name (e.g., "Issue", "Epic", "Bug")' }, assignee: { type: 'string', description: 'New assignee name; empty clears the assignee' }, component: { type: 'string', description: 'New component name; empty clears the component' }, milestone: { type: 'string', description: 'New milestone name; empty clears the milestone' }, dueDate: { type: 'string', description: 'New due date in ISO format; empty clears it' }, estimation: { type: 'number', description: 'New time estimation in hours' }, ...workspaceProp }, required: ['issueId'] }
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
      description: 'Create a project with members, owners, and defaults. The creator is always included as a member and owner.',
      inputSchema: { type: 'object', properties: { identifier: { type: 'string', description: 'Project identifier (2-5 uppercase letters, e.g., "PROJ")' }, name: { type: 'string', description: 'Project display name' }, description: { type: 'string', description: 'Project description' }, private: { type: 'boolean', description: 'Whether the project is private (default: false)' }, projectType: { type: 'string', description: 'Project type name or id. Required when several types can hold issues.' }, ...projectSettingsProps, ...workspaceProp }, required: ['identifier', 'name'] }
    },
    {
      name: 'update_project',
      description: 'Update project fields, defaults, or replace membership/ownership. Retain an owner; private projects must retain an owner who is a member.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, name: { type: 'string', description: 'New display name' }, description: { type: 'string', description: 'New description' }, private: { type: 'boolean', description: 'Privacy setting' }, ...projectSettingsProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'delete_project',
      description: 'Permanently delete a project and ALL its issues. DESTRUCTIVE and IRREVERSIBLE — confirm with the user.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'archive_project',
      description: 'Archive or restore a project. Pass archived=false to unarchive it.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier (e.g., "PROJ")' }, archived: { type: 'boolean', description: 'true to archive (default), false to unarchive' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'move_issue',
      description: 'Move an issue from one project to another. Returns the new issue identifier.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, targetProject: { type: 'string', description: 'Target project identifier' }, ...workspaceProp }, required: ['issueId', 'targetProject'] }
    },
    {
      name: 'search_issues',
      description: 'Full-text search across all projects or within a specific project. Returns a bounded page ordered deterministically by creation time.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search text' }, project: { type: 'string', description: 'Limit search to this project (optional)' }, ...paginationProps, ...workspaceProp }, required: ['query'] }
    },
];
