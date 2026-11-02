/**
 * Time tracking: logging time and managing time reports.
 *
 * Methods are composed onto HulyClient; `this` is the client instance.
 */
import { fromMarkup, normalizeReportDate, parseHours, toHours, toIsoDate, withExtra } from '../helpers.mjs';
import { contactPlugin, generateId, tracker } from './sdk.mjs';

export class TimeReportsMethods {
  /**
   * Log time spent on an issue.
   * @param {string} issueId - Issue identifier
   * @param {number} hours - Hours spent
   * @param {string} [description] - Description of work done
   * @returns {Promise<Object>}
   */
  async logTime(issueId, hours, description, date, employeeName) {
    const client = await this._getClient();
    const { project, issue } = await this._parseAndFindIssue(client, issueId);

    // Resolve employee — default to current user's Employee ref if possible
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

    const newReported = toHours(issue.reportedTime) + normalizedHours;
    await client.updateDoc(tracker.class.Issue, project._id, issue._id, {
      reportedTime: newReported
    });

    return {
      message: `Logged ${normalizedHours}h on ${issueId}`,
      issueId,
      reportedTime: newReported,
      id: reportId
    };
  }

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
   * Get a specific time report by ID on an issue.
   * @param {string} issueId - Issue identifier
   * @param {string} reportId - Time report ID
   * @returns {Promise<Object>}
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
