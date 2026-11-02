/**
 * Tool catalog policy: annotations, project defaults and tool profiles.
 */
import { HULY_PROJECT } from '../config.mjs';
import { DESTRUCTIVE_TOOL_NAMES, READ_ONLY_TOOL_NAMES, workspaceTools } from '../dispatch.mjs';

/** Tool profiles a server can expose: every tool, workspace tools only, or read-only tools. */
export const SUPPORTED_TOOL_PROFILES = Object.freeze(['full', 'project', 'read']);

/** Tools whose `project` argument may default to HULY_PROJECT. */
export const PROJECT_DEFAULT_TOOLS = new Set([
  'get_project',
  'list_issues',
  'create_issue',
  'update_project',
  'delete_project',
  'archive_project',
  'batch_create_issues',
  'summarize_project',
  'create_issues_from_template',
  'list_components',
  'get_component',
  'create_component',
  'update_component',
  'delete_component',
  'list_milestones',
  'get_milestone',
  'create_milestone',
  'update_milestone',
  'delete_milestone',
  'list_statuses',
  'get_status',
  'list_task_types',
  'get_task_type'
]);

/**
 * Emit only annotation fields that differ from, or clarify, MCP defaults.
 * This keeps the advertised schema compact while making read-only and
 * non-destructive operations safe for clients that honor tool annotations.
 */
export function applyToolMetadata(tools) {
  return tools.map(tool => {
    if (READ_ONLY_TOOL_NAMES.has(tool.name)) {
      return { ...tool, annotations: { readOnlyHint: true } };
    }

    return {
      ...tool,
      annotations: {
        destructiveHint: DESTRUCTIVE_TOOL_NAMES.has(tool.name)
      }
    };
  });
}

/**
 * When HULY_PROJECT is set, make `project` optional on the tools that default to it and say so in its description.
 * @param {Object[]} tools - Tool definitions
 * @returns {Object[]}
 */
export function applyDefaultProject(tools) {
  if (!HULY_PROJECT) return tools;

  return tools.map(tool => {
    if (!PROJECT_DEFAULT_TOOLS.has(tool.name)) return tool;

    const schema = tool.inputSchema;
    if (!schema?.properties?.project || !schema.required?.includes('project')) return tool;

    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          ...schema.properties,
          project: {
            ...schema.properties.project,
            description: `${schema.properties.project.description} Optional when HULY_PROJECT is set; defaults to "${HULY_PROJECT}".`
          }
        },
        required: schema.required.filter(name => name !== 'project')
      }
    };
  });
}

/**
 * Validate a tool profile name; an empty value means 'full'.
 * @param {string|undefined} value - Profile name
 * @returns {string} One of SUPPORTED_TOOL_PROFILES
 * @throws {Error} When the profile is unknown
 */
export function normalizeToolProfile(value) {
  const profile = String(value || 'full').trim().toLowerCase();
  if (!SUPPORTED_TOOL_PROFILES.includes(profile)) {
    throw new Error(`Invalid HULY_TOOL_PROFILE: expected ${SUPPORTED_TOOL_PROFILES.join(', ')}`);
  }
  return profile;
}

/**
 * Keep only the tools a profile exposes: all for 'full', workspace tools for 'project', read-only tools for 'read'.
 * get_huly_context is always kept.
 * @param {Object[]} tools - Tool definitions
 * @param {string} profile - Normalized profile name
 * @returns {Object[]}
 */
export function applyToolProfile(tools, profile) {
  if (profile === 'full') return tools;
  const enabled = profile === 'project'
    ? new Set(['get_huly_context', ...Object.keys(workspaceTools)])
    : new Set(['get_huly_context', ...READ_ONLY_TOOL_NAMES]);
  return tools.filter(tool => enabled.has(tool.name));
}
