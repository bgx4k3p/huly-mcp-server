# Token-efficient Claude and subagent workflows

Use server-side response controls first, then optionally narrow client-side tool
availability. These solve different costs:

- Huly's compact mode, fields, includes, limits, and cursors reduce every
  matching tool result, regardless of which MCP client calls it.
- Claude tool scoping prevents an agent from seeing or calling tools it does
  not need. It does not make an allowed Huly call smaller.

Claude Code currently lets custom subagents inherit MCP tools and narrow them
with `tools` or `disallowedTools`; server-level MCP patterns are supported.
Its CLI also supports `--strict-mcp-config` and `--disallowedTools "mcp__*"`.
See Anthropic's current [subagent tool controls](https://code.claude.com/docs/en/sub-agents#available-tools)
and [CLI reference](https://code.claude.com/docs/en/cli-reference).

Do not assume that parent and subagent sessions automatically share,
summarize, cache, or de-duplicate MCP result content. Tool availability may be
inherited, but each repeated call returns another result to the caller. Pass a
small handoff—stable identifiers, selected facts, and the remaining
question—instead of asking another agent to rediscover the same records.

## Measured workflow comparison

The isolated MCPV benchmark used the same live fixtures for every scenario.
Result tokens are explicitly estimated from UTF-8 response bytes divided by
four; they are not provider-counted input tokens. All scenarios completed the
task with zero retries.

| Scenario | Huly calls | Result bytes | Estimated result tokens | Latency |
| --- | ---: | ---: | ---: | ---: |
| Parent only, raw broad reads | 3 | 60,562 | 15,141 | 1,267 ms |
| Parent only, compact targeted reads | 3 | 3,033 | 759 | 775 ms |
| Two subagents duplicate discovery/detail | 4 | 3,968 | 992 | 616 ms |
| Coordinated identifier handoff | 2 | 1,988 | 497 | 552 ms |

Targeted compact reads reduced estimated result tokens by 95.0% without more
calls, retries, or task failure. Coordinating two agents around one discovery
result reduced calls by 50% and estimated result tokens by 49.9%. Latency is a
single live observation rather than a release gate; rerun with
`npm run benchmark:workflows:live` in an isolated workspace.

## Agent scoping

A code-review subagent that does not need Huly should not inherit it:

```yaml
---
name: local-reviewer
description: Review local code and tests only
tools: Read, Grep, Glob, Bash
---
```

For a Huly research agent, allow only its read workflow:

```yaml
---
name: huly-researcher
description: Find and summarize relevant Huly issues
tools: Read, Grep, mcp__huly__search_issues, mcp__huly__list_issues, mcp__huly__get_issue
---
```

Add a mutation tool only to an agent whose task requires that mutation. Tool
scoping is optional: keeping Huly available is reasonable when the agent may
need it, because compact projections and bounds still control result size.

## Prompt patterns

Search before detail:

```text
Search MCPV for "pagination" with limit 5. Return only issue IDs, titles, and
status. Do not fetch issue details yet.
```

List the smallest useful page:

```text
List up to 10 Todo issues in MCPV with fields [id, title, status, priority].
Follow nextCursor only if those 10 do not answer the question.
```

Fetch one issue with intentional expansions:

```text
Get MCPV-42 with fields [id, title, status, assignee] and include
[description, comments], comments_limit 5. The full description is required;
do not request unrelated relations, activity, time reports, or children.
```

Follow a mutation without rediscovery:

```text
Use the already selected ID MCPV-42. Update only its status to Done. If
verification is required, re-read fields [id, status, modifiedOn]; do not
repeat the prior search or full-detail call.
```

Subagent handoff:

```text
Analyze MCPV-42. The parent already found it while searching "pagination".
Known facts: title="Cursor completeness", status=Todo. Fetch only the
description needed for analysis and return a concise recommendation with the
same issue ID.
```

## When to parallelize Huly reads

Parallel reads help when records are independent and their combined result is
required—for example, fetching two already-known issue IDs for a comparison.
Give each agent disjoint IDs or filters and bounded output requirements.

Parallel reads duplicate context when agents repeat discovery, query the same
project page, or fetch full details for the same issue. Run discovery once,
deduplicate IDs, assign disjoint follow-ups, and have each worker return a
summary plus identifiers. If one result determines what to fetch next, keep
the workflow sequential.

## Session measurement checklist

Record Huly result bytes/estimated tokens, call count, retries, elapsed time,
and task success for the whole parent-plus-subagent session. Use provider token
counts when available, but label byte-derived estimates honestly. A change is
an improvement only if total session tokens fall without increasing retries or
breaking the task; moving the same duplicate calls into subagents is not an
optimization.
