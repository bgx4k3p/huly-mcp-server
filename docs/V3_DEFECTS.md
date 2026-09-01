# Version 3 defect register

Every defect found while validating the v3 candidate, with the site it lived
at, the guard that now covers it, and the commit that carries the fix. The
count matters: "26 bugs" was an undercount taken from changelog bullets, several
of which cover more than one defect.

All of these were reachable through documented MCP tools before this release.

## Why the existing gates missed them

The offline suite asserted on **return values**. `create_label` proved a return
value can lie outright: it reported `{message: "created", id}` while the server
discarded the document. The suite also leaked the labels it created, so
`create_label` always took its "already exists" branch and the creation path
never ran. Tests now assert on the arguments reaching the SDK, and the suite
cleans up after itself so each run genuinely exercises creation.

## Register

Class A — schema and dispatch contract drift. v3 rejects unadvertised
arguments, which turned long-standing schema gaps into hard failures.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| A1 | `descriptionFormat` not advertised on `create_milestone` | mcpShared.mjs | dispatchSchemaAlignment |
| A2 | `descriptionFormat` not advertised on `update_milestone` | mcpShared.mjs | dispatchSchemaAlignment |
| A3 | `descriptionFormat` not advertised on `create_component` | mcpShared.mjs | dispatchSchemaAlignment |
| A4 | `descriptionFormat` not advertised on `update_component` | mcpShared.mjs | dispatchSchemaAlignment |
| A5 | `taskType` not advertised on `list_statuses` | mcpShared.mjs | dispatchSchemaAlignment |
| A6 | `status` not advertised on `list_milestones` | mcpShared.mjs | dispatchSchemaAlignment |
| A7 | `date` not advertised on `log_time` | mcpShared.mjs | dispatchSchemaAlignment |
| A8 | `employee` not advertised on `log_time` | mcpShared.mjs | dispatchSchemaAlignment |
| A9 | `version` not advertised on `create_issues_from_template` | mcpShared.mjs | dispatchSchemaAlignment |
| A10 | `update_project` advertised `isPrivate`, handler read `private`; privacy changes silently discarded | mcpShared.mjs, dispatch.mjs | dispatchSchemaAlignment |
| A11 | `startDate` advertised on both milestone writes, implemented nowhere | mcpShared.mjs | dispatchSchemaAlignment |
| A12 | `set_parent` documented an empty `parentId` as "remove parent"; that call threw | client.mjs `setParent` | clientReadPaths |
| A13 | `version` unreachable because `title` was required and took precedence | mcpShared.mjs | timeNormalization |

Class B — fail-open filters. An unmatched filter returned everything.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| B1 | `listStatuses` unknown task-type name returned every status | client.mjs `listStatuses` | timeNormalization |
| B2 | `listStatuses` fell back to all statuses when the scope was empty | client.mjs `listStatuses` | clientReadPaths |
| B3 | `listStatuses` unknown project kept every task type in the workspace | client.mjs `listStatuses` | clientResolutionGuards |
| B4 | `listStatuses` unresolvable project type kept every task type | client.mjs `listStatuses` | clientReadPaths |
| B5 | `moveIssue` remapped status against every status in the workspace, making the documented default-status fallback unreachable | client.mjs `moveIssue` | issueLifecycle |
| B6 | `getIssue` children not project-scoped; a moved child was returned under the wrong identifier prefix | client.mjs `getIssue` | clientReadPaths |

Class C — success reported for work that did not happen.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| C1 | `createLabel` wrote the tag to a built-in model space, which the server silently discards | client.mjs `createLabel` | timeNormalization |
| C2 | `createLabel` reported success without verifying the write persisted | client.mjs `createLabel` | timeNormalization |
| C3 | `updateIssue` ignored an unknown status and returned `updated: []` | client.mjs `updateIssue` | issueLifecycle |
| C4 | `updateMilestone` discarded an unparseable date or unknown status, reporting success | client.mjs `updateMilestone` | clientMutationPaths |
| C5 | `createMilestone` substituted a default date for an unparseable one | client.mjs `createMilestone` | clientMutationPaths |

Class D — corrupt values reaching the SDK.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| D1 | `createIssue` stored an unparseable `dueDate` as `NaN` | client.mjs `createIssue` | supportModules |
| D2 | `updateIssue` stored an unparseable `dueDate` as `NaN` | client.mjs `updateIssue` | supportModules |
| D3 | `batchCreateIssues` stored an unparseable `dueDate` as `NaN` | client.mjs `batchCreateIssues` | supportModules |
| D4 | `logTime` stored an unparseable `date` as `NaN` | client.mjs `logTime` | timeNormalization |
| D5 | An unknown priority was stored as "none" while the response echoed the requested value | client.mjs `createIssue`, `updateIssue` | supportModules |
| D6 | Seven read paths threw `RangeError` on a stored date that could not be represented, failing the whole page | client.mjs time-report reads | supportModules |

Class E — data consistency.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| E1 | `updateLabel` renamed the tag but left every attached reference's title stale, so the label answered to both names depending on the tool | client.mjs `updateLabel` | taxonomyObjects |
| E2 | Palette colours rendered as RGB hex: index 9 displayed as `#000009`, index 0 as `null` | client.mjs (3 read paths) | clientReadPaths |
| E3 | `_findLabelByName` returned different elements on a cache hit than a miss | client.mjs `_findLabelByName` | paginationInternals |
| E4 | `createWorkspace` returned the workspace UUID as `slug` and `undefined` as `uuid`, so the reported slug could not address the workspace | client.mjs `createWorkspace` | accountAdmin |

Class F — pagination and serialization.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| F1 | Envelope metadata was inferred from payload shape, inventing `count`/`hasMore`/`truncated` on any object holding an `items` array | responseMode.mjs | responseMode, supportModules |
| F2 | A bare array truncated at 100 reported `hasMore: false`, implying completeness while dropping records unreachable without a cursor | responseMode.mjs | responseMode |
| F3 | The sort comparator used `localeCompare` while the page boundary advanced with raw `<`; they disagree on case and punctuation, so a boundary could omit or repeat a record | helpers.mjs, client.mjs | paginationInternals |

Class G — infrastructure and supply chain.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| G1 | A `clearClient`/`clearAll` during an in-flight connect was undone by the post-connect write, caching a connection the caller closed; `clearAll` also stops the sweep timer, so it leaked for the process lifetime | pool.mjs | connectionPool |
| G2 | The first fix for G1 disconnected the orphaned client and then returned it, handing the caller a dead connection | pool.mjs | connectionPool |
| G3 | A non-numeric `HULY_POOL_TTL_MS` parsed to `NaN`, making every staleness comparison false and disabling eviction entirely | config.mjs | supportModules |
| G4 | `@hcengineering/*` used caret ranges while the package is unbundled, so a bad upstream publish reaches every fresh install | package.json | — (pinned) |
| G5 | The integration suite created labels and never deleted them; labels are workspace-scoped, so every run permanently polluted the workspace | integration.test.mjs | suite teardown |
| G6 | `_writeCollaboratorField` documented `Promise<boolean>`, returns `undefined` | client.mjs | — (doc) |

## Totals

37 defects: 13 contract drift, 6 fail-open, 5 false success, 6 corrupt values,
4 consistency, 3 pagination, 6 infrastructure. Two of these (G2 and B2) were
defects in earlier fixes made during this same validation pass, both found by
independent review rather than by the test suite.

## Deferred at the time, closed since

All three items held back from the v3 pass were resolved afterwards. Each was
deferred for a reason that turned out not to hold.

| # | Defect | Site | Guard |
| --- | --- | --- | --- |
| H1 | Cursor ordering degenerated to id-descending for `list_statuses`, `list_project_types`, and `list_task_types` | client.mjs (4 builders) | clientReadPaths |
| H2 | `logTime` and the estimation writes recorded 0 for a non-numeric value instead of rejecting | client.mjs (5 write sites) | timeNormalization, clientRemainingPaths |
| H3 | `getHulyContext` reported the `config.mjs` workspace constant while dispatch resolved from `process.env` | config.mjs, mcpShared.mjs | mcpShared |

**H1** was deferred because fixing it looked like it meant adding `createdOn` to
compact list output, growing every response against the byte budgets. It did
not. Those four builders hand-construct their rows while every other paginated
reader passes its source doc through `withExtra`, which already carries
`createdOn` into the cursor tuple. Compact output filters `extra` through an
empty allowlist, so the timestamp reaches the comparator and never reaches the
payload — the budget fixtures are byte-identical after the fix. A live probe
first confirmed the premise: all 6 statuses, 3 project types, and 4 task types
in the validation workspace carry a real `createdOn`, model-level rows included,
sharing a timestamp from when the model was installed.

**H2** was deferred as matching the documented `toHours` contract. The contract
was the problem: one lenient coercion served both reads and writes. Reading 0
for a malformed stored value is right, because one bad record should not fail a
page. Writing 0 for a caller's value discards what they asked for and reports
success — the same class as C1-C5. `toHours` stays lenient for reads; the five
write sites (`logTime`, `setEstimation`, and the estimation field of
`createIssue`, `updateIssue`, and `batchCreateIssues`) now use `parseHours`,
which rejects a non-numeric or negative value and lets 0 through.

**H3** was deferred as reporting-only, which it was — no mutation could reach
the wrong workspace. But `get_huly_context` exists to tell a caller which
workspace it is pointed at, and the server instructions send clients there first
when defaults are unclear. Both now resolve through `resolveDefaultWorkspace()`,
so there is one answer rather than two.
