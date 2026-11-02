/**
 * All tool definitions, in the order clients see them in tools/list.
 */
import { accountTools } from './tools/account.mjs';
import { projectsAndIssuesTools } from './tools/projectsAndIssues.mjs';
import { workflowTools } from './tools/workflow.mjs';
import { planningTools } from './tools/planning.mjs';
import { activityTools } from './tools/activity.mjs';

/**
 * Fresh copy of the full tool definition list.
 * @returns {Object[]} MCP tool definitions
 */
export function getToolDefinitions() {
  return structuredClone([
    ...accountTools,
    ...projectsAndIssuesTools,
    ...workflowTools,
    ...planningTools,
    ...activityTools
  ]);
}
