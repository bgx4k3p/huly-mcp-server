/**
 * Comments, workflow metadata and time tracking.
 */
import { paginationProps, workspaceProp } from '../schemaFragments.mjs';

/** @type {Object[]} */
export const activityTools = [
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
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, taskType: { type: 'string', description: 'Restrict statuses to one task type (e.g., "Issue", "Epic", "Bug").' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_status',
      description: 'Get details for a specific status by name.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Status name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'list_project_types',
      description: 'List the project types configured in the workspace. These are the valid values for the projectType argument of create_project. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { ...paginationProps, ...workspaceProp }, required: [] }
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
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, hours: { type: 'number', description: 'Hours spent' }, description: { type: 'string', description: 'Description of work done' }, date: { type: 'string', description: 'Date of the work in ISO format (default: today)' }, employee: { type: 'string', description: 'Workspace member the time is logged for. Omitted leaves the report unattributed.' }, ...workspaceProp }, required: ['issueId', 'hours'] }
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
      name: 'update_time_report',
      description: 'Update a time report\'s hours, description, date, or employee. Pass an empty employee to clear attribution.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, reportId: { type: 'string', description: 'Time report ID' }, hours: { type: 'number', description: 'New hours spent' }, description: { type: 'string', description: 'New work description' }, date: { type: 'string', description: 'New work date in ISO format' }, employee: { type: 'string', description: 'New workspace member name; empty clears attribution' }, ...workspaceProp }, required: ['issueId', 'reportId'] }
    },
    {
      name: 'delete_time_report',
      description: 'Delete a time report.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier' }, reportId: { type: 'string', description: 'Time report ID' }, ...workspaceProp }, required: ['issueId', 'reportId'] }
    },
];
