# Version 3 release validation

Version 3 remains staged until every gate is green.

## Validation workspace

Every live gate runs against the disposable `hmcpmcpvalidation20260824`
workspace and its `MCPV` fixture project. Export all five variables; the
integration suite silently falls back to the `default` workspace when
`HULY_WORKSPACE` is unset.

```sh
export HULY_WORKSPACE=hmcpmcpvalidation20260824
export HULY_TEST_PROJECT=MCPV
export HULY_ACCOUNT_TEST_WORKSPACE=hmcpmcpvalidation20260824
export HULY_BENCHMARK_WORKSPACE=hmcpmcpvalidation20260824
export HULY_BENCHMARK_PROJECT=MCPV
```

Address the workspace by **slug, never by UUID**. The fixtures previously lived
in a real workspace because a UUID was assumed to name the disposable one; it
did not. A slug is checkable at a glance, a UUID is not.

Rebuild the fixtures with:

```sh
HULY_SEED_WORKSPACE=hmcpmcpvalidation20260824 node scripts/seed-validation-fixtures.mjs
```

That script refuses any workspace holding a project with issues outside the
fixture project. That check is a guard, not a guarantee: it does not detect a
real workspace whose projects happen to be empty or that holds only non-issue
data, and `--force` bypasses it. Confirm the target by slug before running it.

What the suites touch: the integration suite creates and deletes its own
`MCPT` and `AUD****` projects, reads from `HULY_TEST_PROJECT` without writing
to it, and cleans up every label it creates. Labels matter because they are
workspace-scoped in Huly — an uncleaned test label pollutes every project in
the workspace. `HULY_ACCOUNT_TEST_WORKSPACE` is read-only, asserted against
`list_workspaces`, `get_workspace_info`, and `get_workspace_members` only.

## Coverage matrix

| Area | Required validation |
| --- | --- |
| Modes | Compact default, raw diagnostic path, removed-mode rejection |
| Transports | stdio and Streamable HTTP over WebSocket and REST SDK paths |
| Projections | Every supported issue field/expansion and project/milestone expansion |
| Bounds | Top-level pagination, signed cursor scope/expiry, nested limits and truncation metadata |
| Correctness | Filter postconditions, identity/order equality, mutation round trips, orphan relations |
| Isolation | Concurrent compact/raw HTTP sessions and per-call precedence |
| Privacy | Fixture scan, metadata-only telemetry, zero stdio stdout contamination |
| Packaging | Packed artifact startup and version consistency |
| Performance | Installed package versus v3 bytes, SDK calls, p50/p95, and task success |
| Discovery | Full/project/read catalog counts and byte budgets |

## Commands

Offline gate:

```sh
npm run preflight
```

Isolated live gate:

```sh
HULY_INSTALLED_PACKAGE_PATH=/path/to/installed/@bgx4k3p/huly-mcp-server \
npm run benchmark:live

npm run validate:pagination:live
npm run validate:projection:live
npm run benchmark:workflows:live

# WebSocket and REST integration suites, both against the same workspace.
npm run test
```

## Gates

| Gate | Requirement |
| --- | --- |
| Counted tokens | At least 35% below installed-package corpus baseline |
| Budgets | No unapproved fixture increase |
| Contract | Removed inputs reject; compact/raw schemas and metadata agree |
| Correctness | No failed task, changed identity/order, filter violation, or added retry |
| Latency | Candidate p95 no more than 10% slower without explicit acceptance |
| Regression | Offline, package, WebSocket, REST, and HTTP suites all pass |

Final measured evidence is recorded here only after the commands above are
rerun against the release candidate.

## Final v3 evidence (2026-08-25)

- Lint, privacy scan, and packed project-local/global install/startup passed.
- Unit/property suite: 493/493 passed.
- Live WebSocket suite: 200/200 passed.
- Live REST suite: 200/200 passed.
- Counted Claude corpus: 1,327 to 796 input tokens, a 40.0% reduction.
- Cursor traversal returned all 125 unique fixtures in identical order at page
  sizes 7, 37, and 100; query mismatch and tampering were rejected.
- Ten-iteration installed 2.4.6 versus v3 A/B retained identity/order in all
  cases. Bytes fell 81.6% for a 50-issue list, 57.8% for an expanded 20-issue
  list, 26.5% for an expanded issue, and 28.5% for a project summary. Candidate
  p95 was faster in all four cases; SDK reads fell or stayed equal.
- Targeted compact workflows used 93.6% fewer estimated result tokens than raw
  broad reads. Coordinated identifier handoff used 49.9% fewer estimated tokens
  and 50% fewer calls than duplicate agent discovery, with zero retries.
- Claude Opus reviewed the implementation plan.

## Post-candidate review (2026-08-29)

Claude Opus performed the final-code review that the release commit lacked,
reading the working tree locally rather than uploading the branch. It found and
this revision fixes: eight dispatch-forwarded parameters that strict argument
validation rejected because no schema advertised them; `update_project`
advertising `isPrivate` while reading `private`; `startDate` advertised on both
milestone writes but implemented nowhere; list pagination metadata inferred
from payload shape instead of stated by the producer; and caret ranges on the
now-unbundled `@hcengineering/*` runtime dependencies.

It also exposed a defect no prior run could reach: `createLabel` chose its
storage space with `findOne(tracker.class.Project, {})`, which in a workspace
whose first project is Huly's built-in `DefaultProject` writes the
`TagElement` to a model-level space, where it is silently discarded. The call
reported success while nothing persisted. Every earlier run passed because the
suite leaked its labels, so `createLabel` always took the "already exists"
branch and the creation path never executed. The suite now deletes every label
it creates, so that path is exercised on every run.

Re-run after those fixes, all against the pinned validation workspace:

- Lint, markdown lint, and privacy scan passed.
- Unit/property suite: 493/493 passed, including the new
  `test/dispatchSchemaAlignment.test.mjs` guard that fails whenever a handler
  reads an unadvertised argument or advertises one it never reads.
- Live WebSocket suite: 200/200 passed. Live REST suite: 200/200 passed.
- Live pagination: 125 unique fixtures, no gaps or duplicates; scope-mismatch
  and tampered cursors rejected; envelope metadata correct.
- Live projection: comments 5 of 8, activity 4 of 13, time reports 3 of 5, each
  reporting truncation; full description preserved.
- Live workflow benchmark: coordinated handoff used 2 calls and 550 estimated
  tokens against 4 calls and 1,099 for duplicate reads, with no retries.
- Post-run audit: zero leaked labels or projects in either workspace.
- Unit coverage is 97.1% of lines and 93.4% of functions across 493 tests;
  every module is at or above 95% of lines. `client.mjs` rose from 43.4% to
  95.5% of lines and 32.2% to 88.5% of functions. Collect it with
  `npm run coverage`; `npm run coverage:live` reports the live WebSocket
  suite's coverage.
- Two figures are deliberately short of 95%: `responseMode.mjs` functions
  (90%), whose uncovered function sits behind a deliberately empty allowlist and
  cannot execute, and `client.mjs` functions (88.5%), whose remainder is the
  transport-selection code in `connect` that cannot be stubbed without a
  dependency-injection refactor. Branch coverage is 86.6% overall; `config.mjs`
  branches are module-load-time defaults with no logic.

- Packed artifact project-local and global install/startup passed.
- Response budgets regenerated against the corrected envelope and re-counted
  with the Claude CLI differential counter.
- Discovery catalog: 43,740 bytes `full`, 33,594 `project`, 18,688 `read`,
  each still below the 45,016-byte v2.4.6 catalog.
- Pre-existing, not introduced by v3: one historical `gitleaks` hit in a March
  2026 README curl example, 19 unfixable moderate Svelte advisories through the
  Huly SDK, and a Dockerfile that runs as root.

## Why the suite missed a shipped defect

`create_label` had been broken in any fresh workspace and no gate caught it.
Four independent weaknesses had to hold at once, and all four did:

1. Unit tests mock `createDoc`, and a recording mock cannot reproduce a server
   that accepts a write and discards it. The assertion "createDoc was called"
   was true; persistence was what failed.
2. The integration suite leaked the labels it created, so `createLabel` always
   took its "already exists" branch and the creation path never ran. The suite
   exercised the wrong branch on every run while appearing to test creation.
3. Assertions trusted the return value, which reported success unconditionally.
4. Only one workspace shape was ever exercised, and the defect requires the
   first project to be Huly's built-in default.

The countermeasures are: the suite now deletes every label it creates, tests
assert on the arguments reaching the SDK rather than on return values,
`createLabel` verifies persistence before reporting success, and the fixtures
live in a workspace the seeder can rebuild from scratch.
