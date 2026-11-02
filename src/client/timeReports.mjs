/**
 * Time tracking: logging time and managing time reports.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, normalizeReportDate, parseHours, toHours, toIsoDate, withExtra } from '../helpers.mjs';
import { contactPlugin, generateId, tracker } from './sdk.mjs';

export class TimeReportsMethods {
  /**
   * Log time spent on an issue and add it to the issue's reported time.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {number|string} hours - Hours spent; must be a non-negative number
   * @param {string} [description] - Description of work done
   * @param {string} [date] - Report date, ISO 8601 (defaults to now)
   * @param {string} [employeeName] - Employee name (case-insensitive); omitted leaves the report unassigned
   * @returns {Promise<{message: string, issueId: string, reportedTime: number, id: string}>}
   * @throws {Error} When the issue or employee is not found, or hours or date is invalid
   */
  async logTime(issueId, hours, description, date, employeeName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    let employeeId = null;
    if (employeeName) {
      employeeId = await this._findEmployeeByName(client, employeeName);
    }

    const normalizedHours = parseHours(hours);
    const reportId = generateId();
    await client.addCollection(
      tracker.class.TimeSpendReport,
      project._id,
      issue._id,
      tracker.class.Issue,
      'reports',
      {
        employee: employeeId,
        date: normalizeReportDate(date),
        value: normalizedHours,
        description: description || ''
      },
      reportId
    );

    // Huly adds the report to the issue's reportedTime itself, atomically with the report.
    const updated = await client.findOne(tracker.class.Issue, { _id: issue._id });

    return {
      message: `Logged ${normalizedHours}h on ${issueId}`,
      issueId,
      reportedTime: toHours(updated?.reportedTime),
      id: reportId
    };
  }

  /**
   * List time reports on an issue, one cursor page at a time.
   * @param {string} issueId - Issue identifier (e.g., "PROJ-42")
   * @param {Object} [options]
   * @param {string} [options.cursor] - Opaque cursor from a previous page
   * @param {number} [options.limit=50] - Page size (1-100)
   * @returns {Promise<{items: Object[], count: number, hasMore: boolean, truncated: boolean, nextCursor?: string}>}
   *   List envelope
   * @throws {Error} When the issue is not found, or the limit or cursor is invalid
   */
  async listTimeReports(issueId, options = {}) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const reports = await client.findAll(tracker.class.TimeSpendReport, {
      attachedTo: issue._id
    }, { sort: { date: -1 } });

    const employees = await client.findAll(contactPlugin.mixin.Employee, { active: true });
    const employeeMap = new Map(employees.map(employee => [employee._id, employee.name]));
    const enriched = reports.map(r => withExtra(r, {
      id: r._id,
      hours: toHours(r.value),
      description: fromMarkup(r.description),
      date: toIsoDate(r.date),
      employee: r.employee ? employeeMap.get(r.employee) ?? null : null
    }));
    return this._cursoredFindAll(enriched, {
      ...options,
      cursorScope: { workspace: this.workspace, tool: 'list_time_reports', issueId: issueId.toUpperCase() }
    });
  }

  /**
   * Delete a time report by ID. The server reduces the issue's reported time.
   * @param {string} reportId - Time report ID
   * @returns {Promise<{message: string, id: string, hours: number}>}
   * @throws {Error} When the report is not found
   */
  async deleteTimeReport(reportId) {
    const client = await this._getClient();

    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report) throw new Error(`Time report not found: ${reportId}`);

    // The transactor automatically decrements reportedTime on the issue
    // when a TimeSpendReport is removed via removeCollection — do NOT
    // manually update reportedTime here or it gets decremented twice.
    await client.removeCollection(tracker.class.TimeSpendReport, report.space, report._id, report.attachedTo, report.attachedToClass, report.collection);

    return {
      message: `Time report deleted`,
      id: reportId,
      hours: toHours(report.value)
    };
  }

  /**
   * Update a time report on an issue.
   * @param {string} issueId - Issue identifier the report belongs to
   * @param {string} reportId - Time report ID
   * @param {Object} [updates] - Fields to update; omitted keys are left unchanged
   * @param {number|string} [updates.hours] - Hours spent; must be a non-negative number
   * @param {string} [updates.description] - Description of work done
   * @param {string} [updates.date] - Report date, ISO 8601; empty sets it to now
   * @param {string} [updates.employee] - Employee name; empty clears it
   * @returns {Promise<{id: string, issueId: string, updated: string[]}>}
   * @throws {Error} When the issue, report (on that issue), or employee is not found, or a value is invalid
   */
  async updateTimeReport(issueId, reportId, updates = {}) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);
    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report || report.attachedTo !== issue._id) {
      throw new Error(`Time report not found on ${issueId}: ${reportId}`);
    }
    const docUpdates = {};
    const updatedFields = [];
    if (updates.hours !== undefined) {
      docUpdates.value = parseHours(updates.hours);
      updatedFields.push('hours');
    }
    if (updates.description !== undefined) {
      docUpdates.description = updates.description;
      updatedFields.push('description');
    }
    if (updates.date !== undefined) {
      docUpdates.date = normalizeReportDate(updates.date);
      updatedFields.push('date');
    }
    if (updates.employee !== undefined) {
      docUpdates.employee = updates.employee.trim() === ''
        ? null
        : await this._findEmployeeByName(client, updates.employee);
      updatedFields.push('employee');
    }

    if (Object.keys(docUpdates).length > 0) {
      // TimeSpendReport is an AttachedDoc. Updating it through its collection
      // transaction is what runs Huly's parent reportedTime maintenance.
      await client.updateCollection(
        tracker.class.TimeSpendReport,
        report.space,
        report._id,
        report.attachedTo,
        report.attachedToClass,
        report.collection,
        docUpdates
      );
    }
    return { id: reportId, issueId, updated: updatedFields };
  }

  /**
   * Get a time report by ID on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} reportId - Time report ID
   * @returns {Promise<Object>} `{ id, hours, description, date, employee }` plus extras
   * @throws {Error} When the issue is not found or the report is not attached to it
   */
  async getTimeReport(issueId, reportId) {
    const client = await this._getClient();
    const { issue } = await this._parseAndFindIssue(client, issueId);

    const report = await client.findOne(tracker.class.TimeSpendReport, { _id: reportId });
    if (!report || report.attachedTo !== issue._id) {
      throw new Error(`Time report not found on ${issueId}: ${reportId}`);
    }

    let employee = null;
    if (report.employee) {
      const employeeDoc = await client.findOne(contactPlugin.mixin.Employee, { _id: report.employee });
      employee = employeeDoc?.name ?? null;
    }

    return withExtra(report, {
      id: report._id,
      hours: toHours(report.value),
      description: fromMarkup(report.description),
      date: toIsoDate(report.date),
      employee
    });
  }
}
