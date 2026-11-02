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
   * @throws {Error} When either issue is not found
   */
  async addRelation(issueId, relatedToIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: relatedIssue } = await this._parseAndFindIssue(client, relatedToIssueId);

    const currentRelations = issue.relations || [];

    const alreadyRelated = currentRelations.some(r => r._id === relatedIssue._id);
    if (alreadyRelated) {
      return { message: `Issues are already related` };
    }

    const newRelations = [...currentRelations, { _id: relatedIssue._id, _class: relatedIssue._class }];

    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      relations: newRelations
    });

    // Write reverse relation on the target issue
    const { project: relProject } = await this._parseAndFindIssue(client, relatedToIssueId);
    const targetRelations = relatedIssue.relations || [];
    if (!targetRelations.some(r => r._id === issue._id)) {
      await client.updateDoc(tracker.class.Issue, relProject._id, relatedIssue._id, {
        relations: [...targetRelations, { _id: issue._id, _class: issue._class }]
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
   * @throws {Error} When either issue is not found
   */
  async addBlockedBy(issueId, blockedByIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);
    const { issue: blockingIssue } = await this._parseAndFindIssue(client, blockedByIssueId);

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
   * Remove a sub-issue from its current parent's child list, if the parent still exists.
   * @param {Object} client - Huly SDK client
   * @param {Object} issue - Sub-issue document
   * @returns {Promise<void>}
   */
  async _removeFromParent(client, issue) {
    const oldParent = await client.findOne(tracker.class.Issue, { _id: issue.attachedTo });
    if (!oldParent) return;
    const remaining = (oldParent.childInfo || []).filter(c => c.childId !== issue._id);
    await client.updateDoc(tracker.class.Issue, oldParent.space, oldParent._id, {
      childInfo: remaining,
      subIssues: remaining.length
    });
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

    await this._removeFromParent(client, issue);

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      project._id,
      tracker.class.Project,
      'issues',
      {
        parents: [],
        attachedTo: project._id,
        attachedToClass: tracker.class.Project,
        collection: 'issues'
      }
    );

    return { message: `Removed parent from ${issueId}`, issueId, parentId: null };
  }

  /**
   * Set or remove the parent of an issue, moving it out of any previous parent.
   * @param {string} issueId - Child issue identifier
   * @param {string} [parentIssueId] - Parent issue identifier; empty or omitted removes the parent
   * @returns {Promise<Object>} `{ message, issueId, parentIssueId, parentChildCount }`, or
   *   `{ message, issueId, parentId: null }` when the parent was removed
   * @throws {Error} When either issue is not found
   */
  async setParent(issueId, parentIssueId) {
    const client = await this._getClient();

    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // An empty parentId removes the parent.
    if (parentIssueId === undefined || parentIssueId === null || String(parentIssueId).trim() === '') {
      return await this._detachParent(client, project, issue, issueId);
    }

    const { project: parentProject, issue: parentIssue } = await this._parseAndFindIssue(client, parentIssueId);

    // Clean up old parent if the child already has one
    if (issue.attachedTo && issue.attachedToClass === tracker.class.Issue && issue.attachedTo !== parentIssue._id) {
      await this._removeFromParent(client, issue);
    }

    // Build full ancestor chain for breadcrumbs
    const parentInfo = {
      parentId: parentIssue._id,
      identifier: `${parentProject.identifier}-${parentIssue.number}`,
      parentTitle: parentIssue.title,
      space: parentProject._id
    };
    const ancestors = [...(parentIssue.parents || []), parentInfo];

    await client.updateCollection(
      tracker.class.Issue,
      project._id,
      issue._id,
      parentIssue._id,
      tracker.class.Issue,
      'subIssues',
      {
        parents: ancestors,
        attachedTo: parentIssue._id,
        attachedToClass: tracker.class.Issue,
        collection: 'subIssues'
      }
    );

    const childInfo = {
      childId: issue._id,
      ...this._issueTimeFields(issue)
    };

    const currentChildInfo = parentIssue.childInfo || [];

    const existingIndex = currentChildInfo.findIndex(c => c.childId === issue._id);
    let updatedChildInfo;
    if (existingIndex >= 0) {
      updatedChildInfo = [...currentChildInfo];
      updatedChildInfo[existingIndex] = childInfo;
    } else {
      updatedChildInfo = [...currentChildInfo, childInfo];
    }

    await client.updateDoc(tracker.class.Issue, parentProject._id, parentIssue._id, {
      childInfo: updatedChildInfo,
      subIssues: updatedChildInfo.length
    });

    return {
      message: `Set parent: ${issueId} is now a child of ${parentIssueId}`,
      issueId,
      parentIssueId,
      parentChildCount: updatedChildInfo.length
    };
  }
}
