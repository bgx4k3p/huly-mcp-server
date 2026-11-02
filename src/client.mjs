/**
 * HulyClient: the single entry point for Huly operations, one instance per workspace connection.
 *
 * The methods live in domain modules under ./client/ and are composed onto this class, so callers and
 * tests use one class while each domain stays in its own file. Static methods (account and workspace
 * administration) need no workspace connection.
 */
import { composeMethods } from './client/compose.mjs';
import { AccountMethods } from './client/account.mjs';
import { ConnectionMethods } from './client/connection.mjs';
import { RichTextMethods } from './client/richText.mjs';
import { PagingMethods } from './client/paging.mjs';
import { LookupsMethods } from './client/lookups.mjs';
import { MembersMethods } from './client/members.mjs';
import { IssueReadMethods } from './client/issueRead.mjs';
import { IssueWriteMethods } from './client/issueWrite.mjs';
import { LabelsMethods } from './client/labels.mjs';
import { HierarchyMethods } from './client/hierarchy.mjs';
import { ProjectsMethods } from './client/projects.mjs';
import { WorkflowMethods } from './client/workflow.mjs';
import { MilestonesMethods } from './client/milestones.mjs';
import { ComponentsMethods } from './client/components.mjs';
import { CommentsMethods } from './client/comments.mjs';
import { TimeReportsMethods } from './client/timeReports.mjs';
import { TemplatesMethods } from './client/templates.mjs';

export class HulyClient {
  /**
   * @param {Object} opts
   * @param {string} opts.url - Huly server URL
   * @param {string} [opts.email] - Authentication email (required if no token)
   * @param {string} [opts.password] - Authentication password (required if no token)
   * @param {string} [opts.token] - Authentication token (alternative to email/password)
   * @param {string} opts.workspace - Workspace slug
   */
  constructor({ url, email, password, token, workspace }) {
    this.url = url;
    this.token = token || null;
    this.email = email || null;
    this.password = password || null;
    this.workspace = workspace;
    this._client = null;
    this._platformClient = null;
    this._connectionPromise = null;
    this._collabClient = null;
    this._workspaceId = null;
    this._serverConfig = null;
  }
}

composeMethods(HulyClient, [
  AccountMethods,
  ConnectionMethods,
  RichTextMethods,
  PagingMethods,
  LookupsMethods,
  MembersMethods,
  IssueReadMethods,
  IssueWriteMethods,
  LabelsMethods,
  HierarchyMethods,
  ProjectsMethods,
  WorkflowMethods,
  MilestonesMethods,
  ComponentsMethods,
  CommentsMethods,
  TimeReportsMethods,
  TemplatesMethods
]);
