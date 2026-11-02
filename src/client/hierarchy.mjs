/**
 * Links between issues: related-to, blocked-by and parent/sub-issue.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { tracker } from './sdk.mjs';

export class HierarchyMethods {
  /**
   * Add a bidirectional "related to" relationship between two issues.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {string} relatedToIssueId - Related issue identifier
   * @returns {Promise<Object>} `{ message, issueId, relatedToIssueId }`, or `{ message }` when the issue already
   *   lists the relation
   * @throws {Error} When either issue is not found, or both are the same issue
   */
  async addRelation(issueId, relatedToIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { project: relatedProject, issue: relatedIssue } = await this._parseAndFindIssue(client, relatedToIssueId);
    if (relatedIssue._id === issue._id) throw new Error(`${issueId} cannot be related to itself`);

    // The relation is stored on both issues; write whichever side is missing, which also repairs a half-written one.
    const sides = [
      { project, issue, other: relatedIssue },
      { project: relatedProject, issue: relatedIssue, other: issue }
    ].filter(side => !(side.issue.relations || []).some(r => r._id === side.other._id));
    if (sides.length === 0) {
      return { message: 'Issues are already related', issueId, relatedToIssueId };
    }
    for (const side of sides) {
      await client.updateDoc(tracker.class.Issue, side.project._id, side.issue._id, {
        relations: [...(side.issue.relations || []), { _id: side.other._id, _class: side.other._class }]
      });
    }

    return {
      message: `Added relation: ${issueId} ↔ ${relatedToIssueId}`,
      issueId,
      relatedToIssueId
    };
  }

  /**
   * Remove a bidirectional "related to" relationship between two issues.
   * Repairs a partially written relationship by removing whichever side exists.
   * @param {string} issueId - Issue identifier
   * @param {string} relatedToIssueId - Related issue identifier
   * @returns {Promise<{message: string, issueId: string, relatedIssueId: string}>} Also returned, with a
   *   not-related message, when neither side lists the relation
   * @throws {Error} When either issue is not found
   */
  async removeRelation(issueId, relatedToIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { project: relatedProject, issue: relatedIssue } =
      await this._parseAndFindIssue(client, relatedToIssueId);

    const currentRelations = issue.relations || [];
    const relatedRelations = relatedIssue.relations || [];
    const remainingRelations = currentRelations.filter(r => r._id !== relatedIssue._id);
    const remainingRelatedRelations = relatedRelations.filter(r => r._id !== issue._id);
    const removedSource = remainingRelations.length !== currentRelations.length;
    const removedTarget = remainingRelatedRelations.length !== relatedRelations.length;

    if (!removedSource && !removedTarget) {
      return {
        message: `Issues are not related: ${issueId} ↔ ${relatedToIssueId}`,
        issueId,
        relatedIssueId: relatedToIssueId
      };
    }

    if (removedSource) {
      await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
        relations: remainingRelations
      });
    }
    if (removedTarget) {
      await client.updateDoc(tracker.class.Issue, relatedProject._id, relatedIssue._id, {
        relations: remainingRelatedRelations
      });
    }

    return {
      message: `Removed relation: ${issueId} ↔ ${relatedToIssueId}`,
      issueId,
      relatedIssueId: relatedToIssueId
    };
  }

  /**
   * Add a "blocked by" dependency between two issues. Only the blocked issue is updated.
   * @param {string} issueId - Identifier of the issue that is blocked
   * @param {string} blockedByIssueId - Identifier of the blocking issue
   * @returns {Promise<Object>} `{ message, issueId, blockedByIssueId }`, or `{ message }` when already blocked
   * @throws {Error} When either issue is not found, or both are the same issue
   */
  async addBlockedBy(issueId, blockedByIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: blockingIssue } = await this._parseAndFindIssue(client, blockedByIssueId);
    if (blockingIssue._id === issue._id) throw new Error(`${issueId} cannot block itself`);

    const currentBlockedBy = issue.blockedBy || [];

    const alreadyBlocked = currentBlockedBy.some(r => r._id === blockingIssue._id);
    if (alreadyBlocked) {
      return { message: `${issueId} is already blocked by ${blockedByIssueId}` };
    }

    const newBlockedBy = [...currentBlockedBy, { _id: blockingIssue._id, _class: blockingIssue._class }];

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      blockedBy: newBlockedBy
    });

    return {
      message: `Added dependency: ${issueId} is now blocked by ${blockedByIssueId}`,
      issueId,
      blockedByIssueId
    };
  }

  /**
   * Remove a "blocked by" dependency from an issue.
   * @param {string} issueId - Identifier of the issue that is blocked
   * @param {string} blockerIssueId - Identifier of the blocking issue
   * @returns {Promise<{message: string, issueId: string, blockerIssueId: string}>} Also returned, with a
   *   not-blocked message, when the dependency does not exist
   * @throws {Error} When either issue is not found
   */
  async removeBlockedBy(issueId, blockerIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: blockingIssue } = await this._parseAndFindIssue(client, blockerIssueId);
    const currentBlockedBy = issue.blockedBy || [];
    const remainingBlockedBy = currentBlockedBy.filter(r => r._id !== blockingIssue._id);

    if (remainingBlockedBy.length === currentBlockedBy.length) {
      return {
        message: `${issueId} is not blocked by ${blockerIssueId}`,
        issueId,
        blockerIssueId
      };
    }

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      blockedBy: remainingBlockedBy
    });

    return {
      message: `Removed dependency: ${issueId} is no longer blocked by ${blockerIssueId}`,
      issueId,
      blockerIssueId
    };
  }

  /**
   * Whether an issue sits somewhere below another one, following the actual parent links upward rather than
   * the stored ancestor list.
   * @param {Object} client - Huly SDK client
   * @param {Object} issue - Issue to start from
   * @param {string} ancestorId - Internal id of the possible ancestor
   * @returns {Promise<boolean>}
   */
  async _isDescendant(client, issue, ancestorId) {
    const seen = new Set();
    let current = issue;
    while (current?.attachedToClass === tracker.class.Issue && current.attachedTo && !seen.has(current._id)) {
      if (current.attachedTo === ancestorId) return true;
      seen.add(current._id);
      current = await client.findOne(tracker.class.Issue, { _id: current.attachedTo });
    }
    return false;
  }

  /**
   * Rewrite the breadcrumbs of every issue below one that changed parent. Huly updates the moved issue's own
   * `parents` but not its descendants'. Each descendant's breadcrumbs are its parent followed by the parent's
   * breadcrumbs (nearest first, as Huly stores them). Descendants keep their collection, so writing `parents`
   * on them does not interfere with Huly's own bookkeeping.
   * @param {Object} client - Huly SDK client
   * @param {string} rootId - Id of the issue that changed parent
   */
  async _refreshDescendantBreadcrumbs(client, rootId) {
    let level = [await client.findOne(tracker.class.Issue, { _id: rootId })].filter(Boolean);
    while (level.length > 0) {
      const byId = new Map(level.map(issue => [issue._id, issue]));
      const children = await client.findAll(tracker.class.Issue, {
        attachedTo: { $in: [...byId.keys()] },
        attachedToClass: tracker.class.Issue
      });
      for (const child of children) {
        const parent = byId.get(child.attachedTo);
        child.parents = [
          { parentId: parent._id, identifier: parent.identifier, parentTitle: parent.title, space: parent.space },
          ...(parent.parents || [])
        ];
        await client.updateDoc(tracker.class.Issue, child.space, child._id, { parents: child.parents });
      }
      level = children;
    }
  }

  /**
   * Set a parent's sub-issue count from the child list the server maintains. Huly keeps `childInfo` in step when
   * an issue changes collection but not the `subIssues` count, so the count is derived from the fresh list after
   * the move rather than computed from a copy read before it.
   * @param {Object} client - Huly SDK client
   * @param {string} parentId - Parent issue id
   * @returns {Promise<number|null>} The parent's child count, or null when the parent no longer exists
   */
  async _syncSubIssueCount(client, parentId) {
    const parent = await client.findOne(tracker.class.Issue, { _id: parentId });
    if (!parent) return null;
    const count = (parent.childInfo || []).length;
    await client.updateDoc(tracker.class.Issue, parent.space, parent._id, { subIssues: count });
    return count;
  }

  /**
   * Detach a sub-issue from its parent, returning it to the project's own issue collection.
   * @param {Object} client - Huly SDK client
   * @param {Object} project - Project the issue belongs to
   * @param {Object} issue - Issue document
   * @param {string} issueId - Issue identifier, for the result message
   * @returns {Promise<{message: string, issueId: string, parentId: null}>} Also returned when there is no parent
   */
  async _detachParent(client, project, issue, issueId) {
    if (issue.attachedToClass !== tracker.class.Issue || !issue.attachedTo) {
      return { message: `${issueId} has no parent`, issueId, parentId: null };
    }
    const previousParentId = issue.attachedTo;

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      project._id,
      tracker.class.Project,
      'issues',
      { attachedTo: project._id, attachedToClass: tracker.class.Project, collection: 'issues' }
    );
    await this._syncSubIssueCount(client, previousParentId);
    await this._refreshDescendantBreadcrumbs(client, issue._id);

    return { message: `Removed parent from ${issueId}`, issueId, parentId: null };
  }

  /**
   * Set or remove the parent of an issue, moving it out of any previous parent.
   * @param {string} issueId - Child issue identifier
   * @param {string} [parentIssueId] - Parent issue identifier; empty or omitted removes the parent
   * @returns {Promise<Object>} `{ message, issueId, parentIssueId, parentChildCount }`, or
   *   `{ message, issueId, parentId: null }` when the parent was removed
   * @throws {Error} When either issue is not found, or the parent is the issue itself or one of its descendants
   */
  async setParent(issueId, parentIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // An empty parentId removes the parent.
    if (parentIssueId === undefined || parentIssueId === null || String(parentIssueId).trim() === '') {
      return await this._detachParent(client, project, issue, issueId);
    }

    const { issue: parentIssue } = await this._parseAndFindIssue(client, parentIssueId);
    if (parentIssue._id === issue._id) throw new Error(`${issueId} cannot be its own parent`);
    if (await this._isDescendant(client, parentIssue, issue._id)) {
      throw new Error(`${parentIssueId} is a descendant of ${issueId}; making it the parent would create a cycle`);
    }

    const previousParentId = issue.attachedToClass === tracker.class.Issue && issue.attachedTo !== parentIssue._id
      ? issue.attachedTo
      : null;

    // Huly maintains the child's `parents` breadcrumbs and the parents' `childInfo` when the issue changes
    // collection. Writing either here would break that: Huly finds the previous parent through `parents`.
    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      parentIssue._id,
      tracker.class.Issue,
      'subIssues',
      { attachedTo: parentIssue._id, attachedToClass: tracker.class.Issue, collection: 'subIssues' }
    );

    const parentChildCount = await this._syncSubIssueCount(client, parentIssue._id);
    if (previousParentId) await this._syncSubIssueCount(client, previousParentId);
    await this._refreshDescendantBreadcrumbs(client, issue._id);

    return {
      message: `Set parent: ${issueId} is now a child of ${parentIssueId}`,
      issueId,
      parentIssueId,
      parentChildCount
    };
  }
}
