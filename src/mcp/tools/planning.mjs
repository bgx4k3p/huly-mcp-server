/**
 * Issue links, components, milestones and members.
 */
import {
  descriptionFormatProp,
  milestoneExpansionProps,
  paginationProps,
  workspaceProp
} from '../schemaFragments.mjs';

/** @type {Object[]} */
export const planningTools = [
    // ── Relations ────────────────────────────────────────────
    {
      name: 'add_relation',
      description: 'Add a "related to" link between two issues. Both directions are visible.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Source issue (e.g., "PROJ-1")' }, relatedIssueId: { type: 'string', description: 'Target issue (e.g., "PROJ-2")' }, ...workspaceProp }, required: ['issueId', 'relatedIssueId'] }
    },
    {
      name: 'remove_relation',
      description: 'Remove a bidirectional "related to" link. No-op if neither side exists; also repairs a one-sided link.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Source issue (e.g., "PROJ-1")' }, relatedIssueId: { type: 'string', description: 'Target issue (e.g., "PROJ-2")' }, ...workspaceProp }, required: ['issueId', 'relatedIssueId'] }
    },
    {
      name: 'add_blocked_by',
      description: 'Mark an issue as blocked by another issue.',
      inputSchema: { type: 'object', properties: { issueId: { type: 'string', description: 'Blocked issue (e.g., "PROJ-1")' }, blockerIssueId: { type: 'string', description: 'Blocking issue (e.g., "PROJ-2")' }, ...workspaceProp }, required: ['issueId', 'blockerIssueId'] }
    },
    {
      name: 'remove_blocked_by',
      description: 'Remove a "blocked by" dependency from an issue. No-op if the dependency is not present.',
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
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Component name' }, description: { type: 'string', description: 'Component description' }, lead: { type: 'string', description: 'Lead member name' }, ...descriptionFormatProp, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'update_component',
      description: 'Update a component\'s name, description, or lead.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Current component name' }, newName: { type: 'string', description: 'New component name' }, description: { type: 'string', description: 'New description' }, lead: { type: 'string', description: 'Lead member name (empty string to clear)' }, ...descriptionFormatProp, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'delete_component',
      description: 'Delete a component from a project.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Component name' }, ...workspaceProp }, required: ['project', 'name'] }
    },
    // ── Milestones ───────────────────────────────────────────
    {
      name: 'list_milestones',
      description: 'List milestones in a project with stable pagination and an optional bounded issue expansion. Returns { items, nextCursor? }.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, status: { type: 'string', description: 'Filter by status: planned, in progress, completed, cancelled' }, ...milestoneExpansionProps, ...paginationProps, ...workspaceProp }, required: ['project'] }
    },
    {
      name: 'get_milestone',
      description: 'Get a milestone by name with an optional bounded issue expansion.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, ...milestoneExpansionProps, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'create_milestone',
      description: 'Create a new milestone in a project, optionally assigning collaborator workspace members.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, description: { type: 'string', description: 'Milestone description' }, status: { type: 'string', description: 'Status: planned, in progress, completed, cancelled' }, targetDate: { type: 'string', description: 'Target date (ISO format)' }, collaborators: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Active workspace member names or account UUIDs' }, ...descriptionFormatProp, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'update_milestone',
      description: 'Update a milestone\'s name, description, status, target date, or complete collaborator set. An empty collaborators array clears all collaborators.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Current milestone name' }, newName: { type: 'string', description: 'New name' }, description: { type: 'string', description: 'New description' }, status: { type: 'string', description: 'New status: planned, in progress, completed, cancelled' }, targetDate: { type: 'string', description: 'New target date' }, collaborators: { type: 'array', items: { type: 'string' }, uniqueItems: true, description: 'Complete set of active workspace member names or account UUIDs; empty clears all' }, ...descriptionFormatProp, ...workspaceProp }, required: ['project', 'name'] }
    },
    {
      name: 'delete_milestone',
      description: 'Delete a milestone after clearing its issue references, or move those issues to another milestone.',
      inputSchema: { type: 'object', properties: { project: { type: 'string', description: 'Project identifier' }, name: { type: 'string', description: 'Milestone name' }, moveIssuesTo: { type: 'string', description: 'Replacement milestone name. Omit or pass empty to clear the milestone from affected issues.' }, ...workspaceProp }, required: ['project', 'name'] }
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
];
