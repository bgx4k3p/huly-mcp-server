/**
 * JSON Schema fragments shared by several tool definitions.
 */
import { ISSUE_BASE_FIELDS, ISSUE_INCLUDE_FIELDS } from '../projection.mjs';

// Optional workspace property added to every tool
export const workspaceProp = {
  workspace: {
    type: 'string'
  }
};

// Pagination properties for all list tools
export const paginationProps = {
  cursor: {
    type: 'string',
    description: 'Opaque nextCursor from the prior page.'
  },
  limit: {
    type: 'number',
    description: 'Page size: default 50, max 100 (expanded issues 20/50).'
  }
};

// Shared by every tool whose client method accepts a description format.
export const descriptionFormatProp = {
  descriptionFormat: {
    type: 'string',
    enum: ['markdown', 'html', 'plain'],
    description: 'Description format; markdown is the default.'
  }
};

export const projectIncludeProp = {
  include: {
    type: 'array',
    items: { type: 'string', enum: ['milestones', 'components', 'labels', 'members', 'owners', 'defaults'] },
    uniqueItems: true,
    description: 'Related project data to fetch. Omit for the compact project summary.'
  }
};

export const projectSettingsProps = {
  members: { type: 'array', items: { type: 'string' }, description: 'Complete member set: exact names or account UUIDs. Empty clears members on a public project.' },
  owners: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Complete owner set: exact names or account UUIDs. Owners are added to members unless members is supplied.' },
  defaultAssignee: { type: 'string', description: 'Default assignee name; empty clears it' },
  defaultIssueStatus: { type: 'string', description: 'Status name or ID in the default task workflow' },
  defaultTimeReportDay: { type: 'string', enum: ['CurrentWorkDay', 'PreviousWorkDay'] }
};

const templateDataProps = {
  title: { type: 'string', minLength: 1 },
  description: { type: 'string' },
  ...descriptionFormatProp,
  priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low', 'none'] },
  assignee: { type: 'string', description: 'Member name; empty clears' },
  component: { type: 'string', description: 'Component name; empty clears' },
  milestone: { type: 'string', description: 'Milestone name; empty clears' },
  estimation: { type: 'number', minimum: 0 },
  labels: { type: 'array', items: { type: 'string' }, description: 'Complete label-name set; empty clears' },
  type: { type: 'string', description: 'Task type name; empty resets to project default' }
};

export const templateProps = {
  ...templateDataProps,
  children: {
    type: 'array', maxItems: 50, description: 'Complete child-template set; preserve returned child IDs when editing. Empty clears.',
    items: { type: 'object', properties: { id: { type: 'string' }, ...templateDataProps }, required: ['title'], additionalProperties: false }
  },
  relations: {
    type: 'array', description: 'Complete related-document set; empty clears.',
    items: { type: 'object', properties: { id: { type: 'string' }, objectClass: { type: 'string' } }, required: ['id', 'objectClass'], additionalProperties: false }
  }
};

export const milestoneExpansionProps = {
  include: {
    type: 'array',
    items: { type: 'string', enum: ['issues'] },
    uniqueItems: true,
    description: 'Related milestone data to fetch. Omit for the compact milestone summary.'
  },
  issues_limit: {
    type: 'integer',
    description: 'Maximum issues per milestone when include contains issues (default 20, maximum 100).'
  }
};

export const issueProjectionProps = {
  fields: {
    type: 'array',
    items: { type: 'string', enum: ISSUE_BASE_FIELDS },
    uniqueItems: true,
    description: 'Base fields to return. In compact list mode the default is a concise field set; explicit fields always take precedence.'
  },
  include: {
    type: 'array',
    items: { type: 'string', enum: ISSUE_INCLUDE_FIELDS },
    uniqueItems: true,
    description: 'Expensive expansions to fetch. Omit for no list expansions; get_issue includes description by default.'
  },
  comments_limit: { type: 'integer', description: 'Maximum comments per issue (default 20, maximum 100).' },
  activity_limit: { type: 'integer', description: 'Maximum comment/time activity events per issue (default 20, maximum 100).' },
  time_reports_limit: { type: 'integer', description: 'Maximum time reports per issue (default 20, maximum 100).' },
  relations_limit: { type: 'integer', description: 'Maximum relations and blockers per issue (default 20 each, maximum 100).' },
  children_limit: { type: 'integer', description: 'Maximum child issues per issue (default 20, maximum 100).' },
  description_preview_chars: {
    type: 'integer',
    description: 'Description preview length: 0 for full text, or 100-5000 characters. Lists default to 500; get_issue defaults to full text.'
  }
};
