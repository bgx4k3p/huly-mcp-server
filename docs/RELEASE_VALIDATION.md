# Version 3 release validation

Version 3 remains staged until every gate is green. Product-data validation
uses only the disposable `HMCP MCP Validation 20260824` workspace and `MCPV`
project; it does not mutate the planning workspace.

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
HULY_BENCHMARK_WORKSPACE=workspace-slug HULY_BENCHMARK_PROJECT=MCPV \
npm run benchmark:live

HULY_BENCHMARK_WORKSPACE=workspace-slug HULY_BENCHMARK_PROJECT=MCPV \
npm run validate:pagination:live

HULY_BENCHMARK_WORKSPACE=workspace-slug HULY_BENCHMARK_PROJECT=MCPV \
npm run validate:projection:live

HULY_BENCHMARK_WORKSPACE=workspace-slug HULY_BENCHMARK_PROJECT=MCPV \
npm run benchmark:workflows:live

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
- Unit/property suite: 217/217 passed.
- Live WebSocket suite: 200/200 passed.
- Live REST suite: 200/200 passed.
- Counted Claude corpus: 1,300 to 794 input tokens, a 38.9% reduction.
- Cursor traversal returned all 125 unique fixtures in identical order at page
  sizes 7, 37, and 100; query mismatch and tampering were rejected.
- Ten-iteration installed 2.4.6 versus v3 A/B retained identity/order in all
  cases. Bytes fell 81.6% for a 50-issue list, 57.8% for an expanded 20-issue
  list, 26.5% for an expanded issue, and 28.5% for a project summary. Candidate
  p95 was faster in all four cases; SDK reads fell or stayed equal.
- Targeted compact workflows used 93.6% fewer estimated result tokens than raw
  broad reads. Coordinated identifier handoff used 49.9% fewer estimated tokens
  and 50% fewer calls than duplicate agent discovery, with zero retries.
- Claude Opus reviewed the implementation plan. A separate external final-code
  disclosure/review was not performed.
