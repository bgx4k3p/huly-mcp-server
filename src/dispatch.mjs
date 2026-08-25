/**
 * Shared dispatch table mapping tool/route names to HulyClient method calls.
 *
 * Both mcp.mjs and server.mjs consume this table instead of maintaining
 * independent switch/if-else chains. Each entry defines how to extract
 * arguments and call the appropriate client method.
 *
 * Two categories:
 * - accountTools: operate on the Huly account (no workspace connection needed)
 * - workspaceTools: operate within a workspace (require a connected HulyClient)
 */
import { HulyClient } from './client.mjs';

/**
 * Tool behavior policy used to generate MCP safety annotations.
 *
 * Keep this beside the dispatch tables so adding a handler without classifying
 * its behavior fails the metadata regression test. MCP defaults are applied by
 * mcpShared.mjs; these sets describe behavior, not merely naming conventions.
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  'get_huly_context',
  'list_workspaces', 'get_workspace_info', 'get_workspace_members',
  'get_account_info', 'get_user_profile', 'list_integrations',
  'get_integration', 'list_mailboxes', 'find_person_by_social_key',
  'get_social_ids', 'list_subscriptions',
  'list_projects', 'get_project', 'list_issues', 'get_issue',
  'search_issues', 'get_my_issues', 'summarize_project', 'list_labels',
  'list_project_types', 'list_task_types', 'list_statuses',
  'list_milestones', 'get_milestone', 'list_members', 'list_comments',
  'list_time_reports', 'list_components', 'get_label', 'get_member',
  'get_status', 'get_component', 'get_task_type', 'get_comment',
  'get_time_report'
]);

export const DESTRUCTIVE_TOOL_NAMES = new Set([
  'delete_workspace', 'delete_integration', 'delete_mailbox',
  'delete_issue', 'delete_label', 'delete_milestone', 'delete_comment',
  'delete_time_report', 'delete_project', 'delete_component'
]);

/**
 * Account-level tools — called as static methods on HulyClient.
 * Handler signature: (args, url, creds) => Promise<any>
 */
export const accountTools = {
  list_workspaces: (a, url, creds) =>
    HulyClient.listWorkspaces(url, creds),
  get_workspace_info: (a, url, creds) =>
    HulyClient.getWorkspaceInfo(url, creds, a.workspace),
  create_workspace: (a, url, creds) =>
    HulyClient.createWorkspace(url, creds, a.name),
  update_workspace_name: (a, url, creds) =>
    HulyClient.updateWorkspaceName(url, creds, a.workspace, a.name),
  delete_workspace: (a, url, creds) =>
    HulyClient.deleteWorkspace(url, creds, a.workspace),
  get_workspace_members: (a, url, creds) =>
    HulyClient.getWorkspaceMembers(url, creds, a.workspace),
  update_workspace_role: (a, url, creds) =>
    HulyClient.updateWorkspaceRole(url, creds, a.workspace, a.email, a.role),
  get_account_info: (a, url, creds) =>
    HulyClient.getAccountInfo(url, creds),
  get_user_profile: (a, url, creds) =>
    HulyClient.getUserProfile(url, creds),
  set_my_profile: (a, url, creds) =>
    HulyClient.setMyProfile(url, creds, a.name, a.city, a.country),
  change_password: (a, url, creds) =>
    HulyClient.changePassword(url, creds, a.newPassword),
  change_username: (a, url, creds) =>
    HulyClient.changeUsername(url, creds, a.firstName, a.lastName),
  send_invite: (a, url, creds) =>
    HulyClient.sendInvite(url, creds, a.workspace, a.email, a.role),
  resend_invite: (a, url, creds) =>
    HulyClient.resendInvite(url, creds, a.workspace, a.email, a.role),
  create_invite_link: (a, url, creds) =>
    HulyClient.createInviteLink(url, creds, a.workspace, a.email, a.role, a.firstName, a.lastName, a.expireHours),
  list_integrations: (a, url, creds) =>
    HulyClient.listIntegrations(url, creds, a.filter),
  get_integration: (a, url, creds) =>
    HulyClient.getIntegration(url, creds, { socialId: a.socialId, kind: a.kind, workspaceUuid: a.workspaceUuid }),
  create_integration: (a, url, creds) =>
    HulyClient.createIntegration(url, creds, { socialId: a.socialId, kind: a.kind, workspaceUuid: a.workspaceUuid, data: a.data, disabled: a.disabled }),
  update_integration: (a, url, creds) =>
    HulyClient.updateIntegration(url, creds, { socialId: a.socialId, kind: a.kind, workspaceUuid: a.workspaceUuid, data: a.data, disabled: a.disabled }),
  delete_integration: (a, url, creds) =>
    HulyClient.deleteIntegration(url, creds, { socialId: a.socialId, kind: a.kind, workspaceUuid: a.workspaceUuid }),
  list_mailboxes: (a, url, creds) =>
    HulyClient.getMailboxes(url, creds),
  create_mailbox: (a, url, creds) =>
    HulyClient.createMailbox(url, creds, a.name, a.domain),
  delete_mailbox: (a, url, creds) =>
    HulyClient.deleteMailbox(url, creds, a.mailboxId),
  find_person_by_social_key: (a, url, creds) =>
    HulyClient.findPersonBySocialKey(url, creds, a.socialKey),
  get_social_ids: (a, url, creds) =>
    HulyClient.getSocialIds(url, creds),
  add_email_social_id: (a, url, creds) =>
    HulyClient.addEmailSocialId(url, creds, a.targetEmail),
  list_subscriptions: (a, url, creds) =>
    HulyClient.getSubscriptions(url, creds)
};

/**
 * Workspace-level tools — called as instance methods on a connected HulyClient.
 * Handler signature: (args, client) => Promise<any>
 */
export const workspaceTools = {
  list_projects: (a, c) =>
    c.listProjects({ include: a.include, cursor: a.cursor, limit: a.limit }),
  get_project: (a, c) =>
    c.getProject(a.project, { include: a.include }),
  list_issues: (a, c) =>
    c.listIssues(a.project, a.status, a.priority, a.label, a.milestone, a.limit, a.cursor, {
      fields: a.fields, include: a.include, commentsLimit: a.comments_limit, activityLimit: a.activity_limit,
      timeReportsLimit: a.time_reports_limit, relationsLimit: a.relations_limit,
      childrenLimit: a.children_limit, descriptionPreviewChars: a.description_preview_chars,
      responseMode: a.__responseMode
    }),
  get_issue: (a, c) =>
    c.getIssue(a.issueId, {
      fields: a.fields, include: a.include,
      commentsLimit: a.comments_limit, activityLimit: a.activity_limit, timeReportsLimit: a.time_reports_limit,
      relationsLimit: a.relations_limit, childrenLimit: a.children_limit,
      descriptionPreviewChars: a.description_preview_chars, responseMode: a.__responseMode
    }),
  create_issue: (a, c) =>
    c.createIssue(a.project, a.title, a.description, a.priority, a.status, a.labels, a.type, {
      assignee: a.assignee, component: a.component, milestone: a.milestone,
      dueDate: a.dueDate, estimation: a.estimation, descriptionFormat: a.descriptionFormat
    }),
  update_issue: (a, c) =>
    c.updateIssue(a.issueId, a.title, a.description, a.priority, a.status, a.type, {
      assignee: a.assignee, component: a.component, milestone: a.milestone,
      dueDate: a.dueDate, estimation: a.estimation, descriptionFormat: a.descriptionFormat
    }),
  delete_issue: (a, c) =>
    c.deleteIssue(a.issueId),
  search_issues: (a, c) =>
    c.searchIssues(a.query, a.project, a.limit, a.cursor),
  get_my_issues: (a, c) =>
    c.getMyIssues(a.project, a.status, a.limit, a.cursor),
  batch_create_issues: (a, c) =>
    c.batchCreateIssues(a.project, a.issues),
  move_issue: (a, c) =>
    c.moveIssue(a.issueId, a.targetProject),
  create_issues_from_template: (a, c) =>
    c.createIssuesFromTemplate(a.project, a.template, { title: a.title, version: a.version }),
  summarize_project: (a, c) =>
    c.summarizeProject(a.project),

  // Labels
  add_label: (a, c) => c.addLabel(a.issueId, a.label),
  remove_label: (a, c) => c.removeLabel(a.issueId, a.label),
  list_labels: (a, c) => c.listLabels({ cursor: a.cursor, limit: a.limit }),
  create_label: (a, c) => c.createLabel(a.name, a.color, a.description),
  update_label: (a, c) =>
    c.updateLabel(a.name, { newName: a.newName, color: a.color, description: a.description }),
  delete_label: (a, c) => c.deleteLabel(a.name),

  // Relations
  add_relation: (a, c) => c.addRelation(a.issueId, a.relatedIssueId),
  add_blocked_by: (a, c) => c.addBlockedBy(a.issueId, a.blockerIssueId),
  set_parent: (a, c) => c.setParent(a.issueId, a.parentId),

  // Task types & statuses
  list_project_types: (a, c) => c.listProjectTypes({ cursor: a.cursor, limit: a.limit }),
  list_task_types: (a, c) => c.listTaskTypes(a.project, { cursor: a.cursor, limit: a.limit }),
  list_statuses: (a, c) => c.listStatuses(a.project, a.taskType, { cursor: a.cursor, limit: a.limit }),

  // Milestones
  list_milestones: (a, c) => c.listMilestones(a.project, a.status, {
    include: a.include, issuesLimit: a.issues_limit, cursor: a.cursor, limit: a.limit
  }),
  get_milestone: (a, c) => c.getMilestone(a.project, a.name, {
    include: a.include, issuesLimit: a.issues_limit
  }),
  create_milestone: (a, c) =>
    c.createMilestone(a.project, a.name, a.description, a.targetDate, a.status, a.descriptionFormat),
  set_milestone: (a, c) => c.setMilestone(a.issueId, a.milestone),
  update_milestone: (a, c) =>
    c.updateMilestone(a.project, a.name, {
      name: a.newName, description: a.description,
      descriptionFormat: a.descriptionFormat, status: a.status, targetDate: a.targetDate
    }),
  delete_milestone: (a, c) => c.deleteMilestone(a.project, a.name),

  // Members
  list_members: (a, c) => c.listMembers({ cursor: a.cursor, limit: a.limit }),

  // Comments
  add_comment: (a, c) => c.addComment(a.issueId, a.text, a.format),
  list_comments: (a, c) => c.listComments(a.issueId, { cursor: a.cursor, limit: a.limit }),
  update_comment: (a, c) => c.updateComment(a.issueId, a.commentId, a.text, a.format),
  delete_comment: (a, c) => c.deleteComment(a.issueId, a.commentId),

  // Time tracking
  log_time: (a, c) => c.logTime(a.issueId, a.hours, a.description, a.date, a.employee),
  list_time_reports: (a, c) => c.listTimeReports(a.issueId, { cursor: a.cursor, limit: a.limit }),
  delete_time_report: (a, c) => c.deleteTimeReport(a.reportId),

  // Projects
  create_project: (a, c) =>
    c.createProject(a.identifier, a.name, a.description, a.private, a.projectType),
  update_project: (a, c) =>
    c.updateProject(a.project, {
      name: a.name, description: a.description,
      isPrivate: a.private, defaultAssignee: a.defaultAssignee
    }),
  archive_project: (a, c) => c.archiveProject(a.project, a.archived),
  delete_project: (a, c) => c.deleteProject(a.project),

  // Components
  list_components: (a, c) => c.listComponents(a.project, { cursor: a.cursor, limit: a.limit }),
  create_component: (a, c) =>
    c.createComponent(a.project, a.name, a.description, a.lead, a.descriptionFormat),
  update_component: (a, c) =>
    c.updateComponent(a.project, a.name, {
      name: a.newName, description: a.description,
      descriptionFormat: a.descriptionFormat, lead: a.lead
    }),
  delete_component: (a, c) => c.deleteComponent(a.project, a.name),

  // Single-item lookups
  get_label: (a, c) => c.getLabel(a.name),
  get_member: (a, c) => c.getMember(a.name),
  get_status: (a, c) => c.getStatus(a.project, a.name),
  get_component: (a, c) => c.getComponent(a.project, a.name),
  get_task_type: (a, c) => c.getTaskType(a.project, a.name),
  get_comment: (a, c) => c.getComment(a.issueId, a.commentId),
  get_time_report: (a, c) => c.getTimeReport(a.issueId, a.reportId)
};
