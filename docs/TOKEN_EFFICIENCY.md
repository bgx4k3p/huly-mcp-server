# Huly MCP token-efficiency engineering

Response bytes are the deterministic transport metric; counted model-input
tokens are the final efficiency metric. Byte-derived token figures are always
labeled estimates.

## Response contract

Version 3 exposes two modes:

- `compact`: reviewed fields, minified JSON, no unreviewed SDK `extra` data
- `raw`: full SDK fields, minified JSON, intended for diagnostics

Compact is the default. Per-call metadata, captured session mode, and
`HULY_RESPONSE_MODE` override it in that order. Only
`compact` and `raw` are valid.

List tools default to 50 records and cap at 100. Issue pages with expansions
default to 20 and cap at 50. Signed cursors expire after 24 hours and bind to
workspace, tool, normalized filters, projection, expansion limits, and the
total ordering tuple `createdOn + immutable ID`.

Compact collection envelopes expose `count`, `hasMore`, and `truncated`.
Expansion arrays expose their total `*Count` and whether the returned subset
was `*Truncated`.

## Tool discovery profiles

`HULY_TOOL_PROFILE` reduces schema context before any tool call:

| Profile | Tools | Catalog bytes | Approx. bytes/4 |
| --- | ---: | ---: | ---: |
| Installed 2.4.6 full baseline | 82 | 45,016 | 11,254 |
| V3 `full` | 82 | 43,740 | 10,935 |
| V3 `project` | 55 | 33,594 | 8,399 |
| V3 `read` | 36 | 18,688 | 4,672 |

The byte/4 column is not a provider token count. The deterministic catalog
budgets are enforced in unit tests. `full` remains the default to avoid hiding
capabilities; Claude sessions should choose `read` or `project` according to
their task. Disabled tools are neither advertised nor callable.

## Explicit reads

Issue `fields` selects base fields and always retains `id`. Issue `include`
selects any of `description`, `comments`, `activity`, `timeReports`,
`relations`, `blockedBy`, and `children`. Each collection defaults to 20 and
caps at 100 independently.

Compact issue lists default to the concise documented projection and no
expansions. Single-issue reads default to the complete base fields plus the
full description. Requested list descriptions use a deterministic 500-character
preview unless `description_preview_chars: 0` requests the complete text.

Project reads support `include: [milestones, components, labels, members]` and
query only selected relationships for the current page. Milestone reads
support `include: [issues]`; `issues_limit` defaults to 20 and caps at 100.

## Counted offline corpus

The privacy-reviewed corpus is in `test/fixtures/response-corpus.json`.
`response-budgets.json` binds every count to exact response hashes. The
installed-package baseline has 2,923 UTF-8 bytes and 1,327 Claude CLI
differential input tokens. V3 compact output has 1,738 bytes and 796 counted
tokens: 40.5% fewer bytes and 40.0% fewer counted tokens.

Recount intentionally with the official Anthropic API:

```sh
ANTHROPIC_API_KEY=... node scripts/response-benchmark.mjs --update-tokens --model=claude-sonnet-5
```

Or use the authenticated Claude CLI differential counter:

```sh
node scripts/response-benchmark.mjs --update-tokens --claude-cli --model=claude-sonnet-5
```

Offline verification is `npm run test:response-budgets`.

## Installed-package A/B benchmark

The live benchmark imports both the currently installed package and the v3
working tree, alternates execution order, and compares bytes, SDK read calls,
p50/p95 latency, task identity, and ordering. Run it only in a disposable
workspace/project:

```sh
HULY_INSTALLED_PACKAGE_PATH=/path/to/installed/@bgx4k3p/huly-mcp-server \
HULY_BENCHMARK_WORKSPACE=workspace-slug \
HULY_BENCHMARK_PROJECT=MCPV \
npm run benchmark:live
```

The benchmark is read-only and prints aggregate metrics, not Huly content.

## Runtime telemetry

Telemetry is off by default. It records tool name, response mode, output bytes,
an explicitly labeled byte estimate, duration, error state, and session totals.
It never records arguments, content, identities, credentials, or URLs.

```sh
HULY_METRICS=stderr huly-mcp-server
HULY_METRICS=file HULY_METRICS_FILE=/secure/path/huly-metrics.jsonl huly-mcp-server
```

See [CLAUDE_WORKFLOWS.md](CLAUDE_WORKFLOWS.md) for agent workflow guidance,
[V3_UPGRADE.md](V3_UPGRADE.md) for the breaking API, and
[RELEASE_VALIDATION.md](RELEASE_VALIDATION.md) for release gates.

## Release gates

- At least 35% fewer counted model-input tokens on the pinned corpus.
- No unapproved per-fixture byte or token increase.
- Installed-package A/B cases preserve task identity and ordering.
- Representative workflows retain success without added retries or calls.
- Candidate p95 may not regress more than 10% without explicit acceptance.
- Lint, unit, budget, package, integration, transport, and privacy tests pass.
