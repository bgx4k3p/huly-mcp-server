/**
 * Workflow tools: my issues, history, batch creation, project summary and issue templates.
 */
import { paginationProps, templateProps, workspaceProp } from '../schemaFragments.mjs';

/** @type {Object[]} */
export const workflowTools = [
    // ── Workflow Tools ───────────────────────────────────────
    {
      name: 'get_my_issues',
      description: 'Get a bounded page of issues assigned to the current user. Optionally filter by project and status.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Limit to this project (optional)' }, status: { type: 'string', description: 'Filter by status name' }, ...paginationProps, ...workspaceProp }, required: [] }
    },
    {
      name: 'get_issue_history',
      description: 'Get an issue activity timeline with comments, time reports, labels, and sub-issues.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Issue identifier (e.g., "PROJ-42")' }, ...workspaceProp }, required: ['issueId'] }
    },
    {
      name: 'batch_create_issues',
      description: 'Create multiple issues at once in a single project. Each issue can have all the same fields as create_issue. Returns created issues and any errors.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, issues: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, descriptionFormat: { type: 'string', enum: ['markdown', 'html', 'plain'] }, priority: { type: 'string' }, status: { type: 'string' }, type: { type: 'string' }, assignee: { type: 'string' }, component: { type: 'string' }, milestone: { type: 'string' }, dueDate: { type: 'string' }, estimation: { type: 'number' }, labels: { type: 'array', items: { type: 'string' } } }, required: ['title'] }, description: 'Array of issues to create' }, ...workspaceProp }, required: ['project', 'issues'] }
    },
    {
      name: 'summarize_project',
      description: 'Get a statistical summary of a project: issue counts by status, priority, type, assignee, component, and label.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'list_issue_templates',
      description: 'List a bounded page of stored Huly issue templates in a project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_issue_template',
      description: 'Read a stored Huly issue template, including children, labels, and related documents.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, templateId: { type: 'string' }, ...workspaceProp }, required: ['project', 'templateId'] }
    },
    {
      name: 'create_issue_template',
      description: 'Create a persistent Huly issue template usable by the Huly UI. Child templates and references are validated before writing.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, ...templateProps, ...workspaceProp }, required: ['project', 'title'] }
    },
    {
      name: 'update_issue_template',
      description: 'Update a stored Huly issue template. Omitted fields remain unchanged; supplied arrays replace the complete set.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, templateId: { type: 'string' }, ...templateProps, ...workspaceProp }, required: ['project', 'templateId'] }
    },
    {
      name: 'delete_issue_template',
      description: 'Delete a stored issue template and its embedded child templates. Previously created issues are retained.',
      inputSchema: { type: 'object', properties: { project: { type: 'string' }, templateId: { type: 'string' }, ...workspaceProp }, required: ['project', 'templateId'] }
    },
    {
      name: 'create_issues_from_template',
      description: 'Create a set of issues from a predefined template. Templates: feature (epic + design/implement/test/docs/review), bug (reproduce/root-cause/fix/regression-test), sprint (planning/standup/review/retro), release (freeze/QA/changelog/staging/prod/verify).',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, template: { type: 'string', enum: ['feature', 'bug', 'sprint', 'release'], description: 'Template name' }, title: { type: 'string', description: 'Title prefix for generated issues' }, version: { type: 'string', description: 'Version label for the release template, used when title is omitted' }, ...workspaceProp }, required: ['project', 'template'] }
    },
];
