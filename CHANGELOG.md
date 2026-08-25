# Changelog

All notable changes to this project are documented in this file.

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

### Efficiency and validation

- The counted response corpus used 38.9% fewer Claude input tokens than the
  installed-package baseline.
- Live A/B responses were 26.5% to 81.6% smaller across the measured reads,
  with identical record identity/order and candidate p95 latency no worse in
  the four benchmark cases.
- Discovery schema bytes fell 4.1% with `full`, 26.7% with `project`, and 58.6%
  with `read` compared with the installed v2.4.6 package.
- Unit/property, packed-package, WebSocket, REST, pagination, projection,
  privacy, and isolated live regression gates passed. See
  [the release validation report](docs/RELEASE_VALIDATION.md).

### Rollback

Upgrade callers and the server together. An emergency rollback redeploys the
complete prior v2 artifact; v2 and v3 wire contracts must not be mixed.
