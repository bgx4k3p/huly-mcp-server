# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Rolled-up child time

- `get_issue` and `list_issues` return `estimationTotal` and
  `reportedTimeTotal` for an issue that has children. An issue's `estimation`
  and `reportedTime` count only what is booked directly on it — Huly never rolls
  descendants into those fields — so a parent previously read as empty while the
  Huly UI showed a total. The totals are summed from the server-maintained
  `childInfo` array, one level deep, matching what the UI displays.
- Both fields are projectable through `fields`. An issue with no children emits
  neither, so response sizes are unchanged for every leaf. `estimation` and
  `reportedTime` keep their existing meaning, so existing parsers are
  unaffected.

## 3.0.1 - 2026-08-31

The v3 validation pass deferred three defects, each for a reason that did not
survive a second look. `docs/V3_DEFECTS.md` records the original reasoning
alongside what changed.

### Deferred defects closed

- **Cursor ordering degenerated to id-descending** for `list_statuses`,
  `list_project_types`, and `list_task_types`. The deferral assumed a fix meant
  putting `createdOn` into compact output and paying bytes on every response. It
  did not: those four builders hand-construct their rows, while every other
  paginated reader passes its source document through `withExtra`, which already
  carries `createdOn` to the cursor tuple. Compact output filters `extra`
  through an empty allowlist, so the timestamp reaches the comparator and never
  reaches the payload. Budget fixtures are byte-identical. A live probe
  confirmed the premise first: every status, project type, and task type carries
  a real `createdOn`, model-level rows included.
- **Hours were coerced to 0 when they were not a number**, so `log_time` with
  `hours: "two"` reported success while the workspace recorded nothing. One
  lenient coercion was serving both reads and writes. `toHours` stays lenient
  for reads, where a single malformed stored value must not fail a page; the
  five write sites now use `parseHours`, which rejects non-numeric and negative
  values and admits 0. Four of those sites — `set_estimation` and the
  `estimation` field of `create_issue`, `update_issue`, and
  `batch_create_issues` — had the same defect and were not in the original
  report.
- **`get_huly_context` reported the module-load workspace constant** while
  dispatch resolved from the live environment, so a host that repointed the
  server was told a workspace nothing was reading from. Both now resolve through
  `resolveDefaultWorkspace`.

### Project type selection

- **`create_project` no longer demands an explicit `projectType`** merely
  because the workspace has HR or CRM modules installed. Candidates are narrowed
  to the types that own a tracker task type, using the predicate
  `list_task_types` and `search_issues` already share; a single remaining type
  is used automatically, and the call still refuses, listing only the
  issue-capable types, when the choice is genuinely the caller's.

### Maintenance

- Adds the project-type resolution guards that shipped without a test, and
  corrects `CONTRIBUTING.md`, which called the live integration suite the unit
  tests. Without `HULY_TEST_PROJECT` that suite reads workspace `default` and
  project `START`, then fails on missing fixtures rather than on the
  contributor's change.
- Bumps `github/codeql-action` to v4.37.8 and clears three stale dependabot
  pull requests; every action reference in both workflows is now current.

509 unit tests pass, live WebSocket and REST suites 200/200, response budgets
unchanged.

## 3.0.0 - 2026-08-25

Version 3 is an intentionally breaking token-efficiency release. It does not
contain a v2 compatibility layer.

### Breaking changes

- The default MCP result mode is now minified `compact`. `legacy` mode was
  removed; only `compact` and diagnostic `raw` are accepted.
- The tool argument `response_mode` was removed. A caller that needs `raw` for
  one request must use MCP request metadata
  `_meta["com.huly/responseMode"]`. Session headers and `HULY_RESPONSE_MODE`
  remain supported with the values `compact` or `raw`.
- `include_details` was removed from issue, project, and milestone reads. Use
  `fields`, granular `include` values, and the relevant nested limits.
- Compact `list_issues` calls now return a concise default field projection.
  Descriptions are excluded unless explicitly included. Included list
  descriptions default to a 500-character preview; set
  `description_preview_chars: 0` when the complete description is required.
- Related collections are independently bounded. Callers must inspect
  `*Count` and `*Truncated`; top-level pagination uses `hasMore`, `truncated`,
  and the opaque `nextCursor`.
- Bare array results are represented by a compact result envelope. Parsers
  must consume the documented v3 JSON shape instead of relying on v2 display
  text or unreviewed SDK fields under `extra`.
- The direct JavaScript client method `getStatus(name)` was removed. Direct
  callers must use `getStatus(projectIdentifier, name)`.
- Every MCP tool rejects unadvertised arguments. Disabled tools under the new
  `full`, `project`, and `read` profiles are neither advertised nor callable.

### Will an AI client adapt automatically?

A newly connected model normally does: MCP discovery gives it the v3 schemas
and descriptions, so it should select `fields`, `include`, limits, and cursors
without knowing the v2 API. Restart or reconnect the MCP session after the
upgrade so the client does not retain a cached v2 tool catalog.

Automatic discovery cannot rewrite deterministic callers. Saved prompts that
explicitly say `include_details`, application code using the direct client,
workflow JSON with fixed tool arguments, and parsers that depend on the old
result shape must be migrated. Such callers fail clearly rather than silently
receiving a different or unexpectedly large result. A model also cannot infer
that truncated data is sufficient: it must follow `nextCursor` or request a
larger/full expansion when the task requires the omitted content.

### Migration examples

Replace a broad issue read:

```json
{ "issueId": "PROJ-42", "include_details": true }
```

with an intentional projection:

```json
{
  "issueId": "PROJ-42",
  "fields": ["id", "title", "status", "assignee"],
  "include": ["description", "comments"],
  "comments_limit": 5
}
```

Use `include: ["milestones", "components", "labels", "members"]` for project
relations and `include: ["issues"]` with `issues_limit` for milestones.

### Fixed

- Nine parameter sites the dispatch layer already forwarded were never
  advertised in their tool schemas, so strict argument validation rejected
  them. They are now declared and callable: `descriptionFormat` on `create_milestone`,
  `update_milestone`, `create_component`, and `update_component`; `taskType` on
  `list_statuses`; `status` on `list_milestones`; `date` and `employee` on
  `log_time`; and `version` on `create_issues_from_template`.
- `update_project` advertised `isPrivate` while reading `private`, so privacy
  changes were silently discarded. The tool now advertises `private`, matching
  `create_project`. Callers sending `isPrivate` must send `private`; the old
  spelling never took effect.
- `create_milestone` and `update_milestone` no longer advertise `startDate`,
  which no client method implemented and which was silently ignored.
- List pagination metadata (`count`, `hasMore`, `truncated`) is emitted by the
  client that builds each page instead of being inferred from the payload
  shape. A result that merely contained an `items` array no longer acquires
  pagination fields it never had, and a bare array truncated at 100 records
  reports `hasMore: true` rather than implying the page was complete.
- `list_statuses` no longer returns every status when `taskType` matches no
  task type. An unknown task type now fails instead of silently widening a
  restricted read.
- `log_time` rejects an unparseable `date` instead of storing `NaN` on the
  time report.
- `create_issues_from_template` no longer requires `title`, so the release
  template's `version` can identify the generated issues as documented.
- `create_label` reported success while persisting nothing. It chose its
  storage space with the first project found, which in a workspace whose first
  project is Huly's built-in default is a model-level space the server silently
  discards. It now selects a real project space and verifies the write landed
  before reporting success.
- `update_label` renamed the tag but left the denormalised title on every
  attached reference, so the label answered to its old name in issue reads and
  `remove_label` and to its new name in list filters. Attached references are
  renamed too, and the count is reported.
- `list_statuses` returned every status in the workspace when the project did
  not exist, and again when the matched task type had no statuses. Both now
  fail instead of silently widening the read.
- `set_parent` documented an empty `parentId` as "remove parent", but that
  call failed with an issue-id parse error. Detaching a sub-issue now works and
  returns it to the project's own issue collection.
- `create_issue`, `update_issue`, and `batch_create_issues` stored an
  unparseable `dueDate` as `NaN`. All date entry points now share one
  validator with `set_due_date`, which had always validated correctly.
- An unrecognised priority was stored as "none" while the response echoed the
  requested value back. It is now rejected, matching `list_issues`.
- `update_issue` silently ignored an unrecognised status and reported success
  for a write it never performed. It now rejects, matching `create_issue`.
- `create_milestone` silently substituted a default date for an unparseable
  `targetDate`, and `update_milestone` discarded an unparseable date or an
  unknown status while reporting success. Both now reject.
- Cursor pagination sorted with `localeCompare` while the page boundary
  advanced with a raw string comparison. The two disagree on case and
  punctuation, so a page boundary could omit or repeat a record. Both now use
  the same ordering.
- `move_issue` remapped the issue's status against every status in the
  workspace rather than the destination's own workflow, so a same-named status
  from an unrelated project type would match and the documented fallback to the
  destination's default status was unreachable.
- `get_issue` returned child issues that had been moved to another project and
  rendered them with this project's identifier prefix, producing ids that do
  not exist. Child reads are now scoped to the project.
- Label colours are reported as the stored value. They were rendered as RGB hex,
  which displayed palette index 9 (blue) as `#000009` and dropped index 0
  entirely as `null`.
- Time-report reads no longer throw `RangeError` on a stored date that cannot
  be represented; such a date reads as `null` instead of failing the page.
- The label lookup cache returned different elements on a hit than on a miss,
  because only the miss path folded equivalent spellings.
- A non-numeric `HULY_POOL_TTL_MS` parsed to `NaN`, which made every staleness
  comparison false and silently disabled connection eviction for the lifetime
  of the process. It now falls back to the default.
- Runtime `@hcengineering/*` versions are pinned exactly. Since the package
  stopped bundling its dependency tree in 2.4.7, a caret range let a broken
  upstream Huly publish reach every fresh install. This covers the six direct
  dependencies only: the remaining 27 `@hcengineering` packages arrive through
  carets inside Huly's own manifests, so a bad transitive publish can still
  reach a fresh install. Re-bundling is the only complete mitigation and was
  removed in 2.4.7 because it broke `npm install -g`.

### Efficiency and validation

- The counted response corpus used 40.0% fewer Claude input tokens than the
  installed-package baseline.
- Live A/B responses were 26.5% to 81.6% smaller across the measured reads,
  with identical record identity/order and candidate p95 latency no worse in
  the four benchmark cases.
- Discovery schema bytes fell 2.8% with `full`, 25.4% with `project`, and 58.5%
  with `read` compared with the installed v2.4.6 package.
- Unit/property, packed-package, WebSocket, REST, pagination, projection,
  privacy, and isolated live regression gates passed. See
  [the release validation report](docs/RELEASE_VALIDATION.md).

### Rollback

Upgrade callers and the server together. An emergency rollback redeploys the
complete prior v2 artifact; v2 and v3 wire contracts must not be mixed.
