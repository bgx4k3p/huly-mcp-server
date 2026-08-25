# Version 3 upgrade

Version 3 intentionally removes the broad response and expansion APIs. It is a
breaking release with no runtime compatibility layer.

## Removed inputs

- `HULY_RESPONSE_MODE=legacy`
- the per-call `response_mode` argument
- per-call `_meta["com.huly/responseMode"]: legacy`
- `include_details` on project, issue, and milestone reads
- the one-argument direct-client form of `getStatus`

Removed response modes fail validation instead of silently changing behavior.
Unknown tool arguments are not part of the v3 contract.

## V3 replacements

Use `compact` for normal agent traffic and `raw` only for diagnostics. Use
`fields` to select issue base fields and `include` to select related data:

```json
{
  "issueId": "PROJ-42",
  "fields": ["id", "title", "status", "assignee"],
  "include": ["description", "comments"],
  "comments_limit": 5
}
```

Project reads accept `milestones`, `components`, `labels`, and `members` in
`include`. Milestone reads accept `issues`; use `issues_limit` to bound it.

Consumers must treat cursors as opaque and honor `nextCursor`, `hasMore`,
`truncated`, and expansion-specific `*Count`/`*Truncated` metadata.

## AI client behavior

A fresh MCP session receives the v3 tool catalog, so a model should normally
use the replacement arguments automatically. Restart or reconnect the client
after upgrading; an existing session may retain its previously discovered v2
schemas.

Discovery does not migrate saved prompts, application code, fixed workflow
JSON, or response parsers. Those deterministic consumers must be updated. A
model must also act on `*Truncated` and `nextCursor` when the task requires data
beyond the returned bounds; the flag reports omission but cannot decide
whether the omitted content matters to the task.

## Deployment

Upgrade clients and server together. There is no mode switch that restores the
v2 wire contract. If an emergency rollback is required, redeploy the previous
package version as a complete artifact; do not mix v2 callers with v3 servers.
