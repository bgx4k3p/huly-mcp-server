# Huly MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22+-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-blue)](https://modelcontextprotocol.io)
[![Huly SDK](https://img.shields.io/badge/Huly%20SDK-0.7.x-purple)](https://huly.io)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](Dockerfile)

MCP server providing full coverage of the [Huly](https://huly.io) SDK —
issues, projects, workspaces, members, and account management.
Two transports: **stdio** for local tools and **Streamable HTTP** for
remote clients. Tested against self-hosted Huly.
May also work with [Huly Cloud](https://app.huly.io) (not yet tested).

## Why This Exists

Huly has no public API. The only programmatic access is through their JavaScript SDK,
which connects via WebSocket. This server wraps that SDK and exposes **MCP tools**
over both stdio and **Streamable HTTP** transports — compatible with Claude Code,
VS Code, n8n, and any MCP client.

## Install

```bash
git clone https://github.com/bgx4k3p/huly-mcp-server.git
cd huly-mcp-server
npm install
```

> **Note:** The Huly SDK publishes packages with pnpm `workspace:`
> protocol in transitive dependencies, which prevents `npx` and
> global npm installs from working. Clone from source is required.

---

## Quick Start

### Authentication

You can authenticate with either **email/password** or a **token**.

#### Email and Password

```bash
export HULY_URL=https://your-huly-instance.com
export HULY_EMAIL=your@email.com
export HULY_PASSWORD=your-password
export HULY_WORKSPACE=your-workspace
```

#### Token (recommended)

Get a token from your Huly credentials — no env vars needed beforehand:

```bash
node src/index.mjs --get-token -e your@email.com -p your-password -u https://your-huly-instance.com
```

Then use it:

```bash
export HULY_URL=https://your-huly-instance.com
export HULY_TOKEN=<paste-token-from-above>
export HULY_WORKSPACE=your-workspace
```

The token does not expire. You can store it in a secrets manager
and stop exposing your password in environment variables.

---

## Integrations

### Claude Code (stdio)

After cloning and running `npm install`, register the server:

```bash
claude mcp add huly \
  -e HULY_URL=https://your-huly-instance.com \
  -e HULY_TOKEN=your-token \
  -e HULY_WORKSPACE=your-workspace \
  -- node /absolute/path/to/huly-mcp-server/src/index.mjs
```

Or add to your `.mcp.json` manually (token auth — recommended):

```json
{
  "mcpServers": {
    "huly": {
      "command": "node",
      "args": ["/path/to/huly-mcp-server/src/index.mjs"],
      "env": {
        "HULY_URL": "https://your-huly-instance.com",
        "HULY_TOKEN": "${HULY_TOKEN}",
        "HULY_WORKSPACE": "${HULY_WORKSPACE}"
      }
    }
  }
}
```

Or with email/password:

```json
{
  "mcpServers": {
    "huly": {
      "command": "node",
      "args": ["/path/to/huly-mcp-server/src/index.mjs"],
      "env": {
        "HULY_URL": "https://your-huly-instance.com",
        "HULY_EMAIL": "${HULY_EMAIL}",
        "HULY_PASSWORD": "${HULY_PASSWORD}",
        "HULY_WORKSPACE": "${HULY_WORKSPACE}"
      }
    }
  }
}
```

Then ask Claude things like:

- "List my issues in the OPS project"
- "Create a bug report for the login page crash"
- "Summarize the PROJ project — what's overdue?"
- "Break down this feature into subtasks using the feature template"

All tools have detailed descriptions optimized for AI agents.
MCP Resources are also available at `huly://projects/{id}` and `huly://issues/{id}`.

### Streamable HTTP (n8n, VS Code, remote clients)

Start the HTTP MCP server:

```bash
npm run start:server
# MCP endpoint: http://localhost:3001/mcp
# Health check: http://localhost:3001/health
```

Any MCP client that supports Streamable HTTP can connect to
`http://localhost:3001/mcp`. This includes n8n (v1.88+),
VS Code, and other MCP-compatible tools.

To secure the endpoint, set a bearer token:

```bash
MCP_AUTH_TOKEN=your-secret npm run start:server
```

Clients must then include `Authorization: Bearer your-secret` in requests.

### Docker

```bash
docker build -t huly-mcp-server .

# Streamable HTTP server (recommended)
docker run -d \
  -p 3001:3001 \
  -e HULY_URL=https://your-huly-instance.com \
  -e HULY_TOKEN=your-token \
  -e HULY_WORKSPACE=my-workspace \
  huly-mcp-server

# MCP stdio mode
docker run -i \
  -e HULY_URL=https://your-huly-instance.com \
  -e HULY_TOKEN=your-token \
  -e HULY_WORKSPACE=my-workspace \
  huly-mcp-server node src/mcp.mjs
```

---

## Server Configuration

### Environment Variables

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| **Huly Connection** | | | |
| `HULY_URL` | No | `http://localhost:8087` | Huly instance URL |
| `HULY_TOKEN` | No | - | Auth token (alternative to email/password) |
| `HULY_EMAIL` | No | - | Huly login email (required if no token) |
| `HULY_PASSWORD` | No | - | Huly login password (required if no token) |
| `HULY_WORKSPACE` | Yes* | - | Default workspace slug |
| `HULY_TRANSPORT` | No | `ws` | SDK transport: `ws` (WebSocket) or `rest` (REST API) |
| `HULY_POOL_TTL_MS` | No | `1800000` | Connection pool TTL in ms (30 min) |
| **HTTP Server** | | | |
| `PORT` | No | `3001` | HTTP server port (auto-assigns if taken) |
| `MCP_AUTH_TOKEN` | No | - | Bearer token for HTTP auth (disabled if unset) |
| `HULY_RATE_LIMIT` | No | `200` | Max requests per minute per IP |
| `ALLOWED_ORIGINS` | No | `*` | CORS allowed origins (comma-separated) |

*`HULY_WORKSPACE` is required for MCP stdio mode. For HTTP mode it can
be omitted if every request specifies a workspace via the tool arguments.

### HTTP Server Authentication

The HTTP server optionally requires a bearer token. This protects **your server**
from unauthorized access — it's separate from Huly's own authentication.

```bash
# Generate a token
openssl rand -hex 32

# Start with auth enabled
MCP_AUTH_TOKEN=your-token-here npm run start:server
```

If `MCP_AUTH_TOKEN` is not set, auth is disabled (fine for local-only usage).

MCP stdio mode (Claude Code) does not use this token — stdio is inherently local.

### Multi-Workspace

All tools accept an optional `workspace` parameter. The connection pool
caches clients by workspace slug with configurable TTL:

```json
{"tool": "list_projects", "arguments": {"workspace": "workspace-a"}}
```

If omitted, the `HULY_WORKSPACE` env var is used as the default.

---

## Testing

Uses Node.js built-in `node:test` and `node:assert` — no test framework dependencies.
Tests run twice: once with WebSocket transport, once with REST transport.

```bash
npm test              # Both transports (ws + rest)
npm run test:ws       # WebSocket only
npm run test:rest     # REST only
```

194 tests across 101 suites:

| Suite | Tests | Description |
| --- | --- | --- |
| **Unit** | 28 | Constants, ID parsing, rate limiting, auth logic |
| **Integration** | 55 | Full CRUD lifecycle against live Huly |
| **Dispatch** | 45 | Schema to dispatch to client param forwarding for all tools |
| **Account-level** | 11 | Workspaces, profile, social IDs |
| **Mock** | 44 | Destructive ops, token auth via mocks |
| **Streamable HTTP** | 11 | MCP protocol over HTTP: init, tools, resources, auth, rate limiting |

**100% dispatch coverage** — every tool's params are traced end-to-end
through the dispatch table to the client method.

---

## Network Configurations

- **Local:** `HULY_URL=http://localhost:8087`
- **Remote:** `HULY_URL=https://huly.example.com`
- **Behind nginx proxy:** Point to the proxy port

### Cloudflare Access / Tunnel

If Huly is behind Cloudflare Access with MFA, create a
bypass Application for `/_*` or these individual paths:

- `/_accounts`
- `/_transactor`
- `/_collaborator`
- `/_rekoni`
- `/config.json`

---

## Architecture

```text
src/
  client.mjs    # HulyClient — all business logic and SDK calls
  helpers.mjs   # Shared constants, markup conversion, JSDOM polyfills
  dispatch.mjs  # Tool-to-method dispatch table
  pool.mjs      # Connection pool — caches clients by workspace with TTL
  mcpShared.mjs # Shared MCP server factory — tool definitions + resources
  mcp.mjs       # MCP stdio entry point (Claude Code)
  server.mjs    # MCP Streamable HTTP entry point (n8n, VS Code, remote)
  index.mjs     # CLI entry point — --get-token mode + MCP re-export
```

```text
Claude Code  -> stdio           -> mcp.mjs    -> mcpShared.mjs -> pool -> client -> Huly SDK
n8n / remote -> Streamable HTTP -> server.mjs -> mcpShared.mjs -> pool -> client -> Huly SDK
```

---

## Response Format

All read operations return **known fields** at the top level with
resolved, human-readable values (e.g., status names instead of IDs,
formatted dates). Any additional fields from the Huly SDK that aren't
explicitly mapped appear in an `extra` object — this future-proofs
the API so new SDK fields are visible without a code update.

```json
{
  "id": "PROJ-42",
  "title": "Fix the bug",
  "status": "In Progress",
  "priority": "High",
  "type": "Task",
  "parent": "PROJ-10",
  "childCount": 3,
  "createdOn": 1719700000000,
  "completedAt": null,
  "extra": {
    "_id": "69bab168...",
    "_class": "tracker:class:Issue",
    "space": "69b819b7...",
    "kind": "tracker:taskTypes:Issue"
  }
}
```

Text fields (`description`, `comment`) support three input formats
via `descriptionFormat` / `format` parameter:

- **markdown** (default) — rendered as rich text in the Huly UI
- **html** — raw HTML, converted to rich text
- **plain** — stored as unformatted text

## API Reference

Full list of all MCP tools available through this server.

### Account and Workspace Management

| Tool | Description |
| --- | --- |
| `list_workspaces` | List all accessible workspaces |
| `get_workspace_info` | Get workspace details by slug |
| `create_workspace` | Create a new workspace |
| `update_workspace_name` | Rename a workspace |
| `delete_workspace` | Permanently delete a workspace |
| `get_workspace_members` | List workspace members and roles |
| `update_workspace_role` | Change a member's role |
| `get_account_info` | Get current user's account info |
| `get_user_profile` | Get current user's profile |
| `set_my_profile` | Update profile fields |
| `change_password` | Change password |
| `change_username` | Change username |

### Invites

| Tool | Description |
| --- | --- |
| `send_invite` | Send workspace invite email |
| `resend_invite` | Resend pending invite |
| `create_invite_link` | Generate shareable invite link |

### Integrations, Mailboxes, Social IDs, Subscriptions

| Tool | Description |
| --- | --- |
| `list_integrations` / `get_integration` / `create_integration` / `update_integration` / `delete_integration` | Full CRUD for integrations |
| `list_mailboxes` / `create_mailbox` / `delete_mailbox` | Mailbox management |
| `find_person_by_social_key` / `get_social_ids` / `add_email_social_id` | Person/social ID management |
| `list_subscriptions` | List account subscriptions |

### Projects

| Tool | Description | Text Format |
| --- | --- | --- |
| `list_projects` | List all projects (supports `include_details`) | -- |
| `get_project` | Get project by identifier (supports `include_details`) | -- |
| `create_project` | Create a new project | `descriptionFormat`: md/html/plain |
| `update_project` | Update project name, description, privacy, default assignee | `descriptionFormat`: md/html/plain |
| `archive_project` | Archive or unarchive a project | -- |
| `delete_project` | Permanently delete a project | -- |
| `summarize_project` | Aggregated project metrics and health | -- |

### Issues

| Tool | Description | Text Format |
| --- | --- | --- |
| `list_issues` | List issues with filters (supports `include_details`) | -- |
| `get_issue` | Get full issue details (supports `include_details`) | -- |
| `create_issue` | Create a new issue | `descriptionFormat`: md/html/plain |
| `update_issue` | Update issue fields | `descriptionFormat`: md/html/plain |
| `delete_issue` | Permanently delete an issue | -- |
| `search_issues` | Full-text search across projects | -- |
| `get_my_issues` | Issues assigned to current user | -- |
| `batch_create_issues` | Create multiple issues at once | `descriptionFormat` per item |
| `move_issue` | Move issue between projects | -- |
| `create_issues_from_template` | Create from predefined templates | -- |

### Labels

| Tool | Description |
| --- | --- |
| `list_labels` | List all labels in the workspace |
| `get_label` | Find a label by name |
| `create_label` | Create a new label with optional color |
| `update_label` | Update label name, color, or description |
| `add_label` | Add a label to an issue |
| `remove_label` | Remove a label from an issue |

### Relations

| Tool | Description |
| --- | --- |
| `add_relation` | Add bidirectional "related to" link |
| `add_blocked_by` | Add "blocked by" dependency |
| `set_parent` | Set parent issue (epic/task hierarchy) |

### Components

| Tool | Description | Text Format |
| --- | --- | --- |
| `list_components` | List components in a project | -- |
| `get_component` | Find a component by name | -- |
| `create_component` | Create a new component | `descriptionFormat`: md/html/plain |
| `update_component` | Update component fields | `descriptionFormat`: md/html/plain |
| `delete_component` | Delete a component | -- |

### Milestones

| Tool | Description | Text Format |
| --- | --- | --- |
| `list_milestones` | List milestones (supports `include_details`) | -- |
| `get_milestone` | Get milestone details (supports `include_details`) | -- |
| `create_milestone` | Create a new milestone | `descriptionFormat`: md/html/plain |
| `update_milestone` | Update milestone fields | `descriptionFormat`: md/html/plain |
| `delete_milestone` | Delete a milestone | -- |
| `set_milestone` | Set or clear milestone on an issue | -- |

### Members

| Tool | Description |
| --- | --- |
| `list_members` | List all active workspace members |
| `get_member` | Find a member by name (fuzzy match) |

### Comments

| Tool | Description | Text Format |
| --- | --- | --- |
| `list_comments` | List all comments on an issue | -- |
| `get_comment` | Get a specific comment by ID | -- |
| `add_comment` | Add a comment to an issue | `format`: md/html/plain |
| `update_comment` | Update comment text | `format`: md/html/plain |
| `delete_comment` | Delete a comment | -- |

### Time Tracking

| Tool | Description | Text Format |
| --- | --- | --- |
| `log_time` | Log actual time spent | `descriptionFormat`: md/html/plain |
| `list_time_reports` | List time reports for an issue | -- |
| `get_time_report` | Get a specific time report by ID | -- |
| `delete_time_report` | Delete a time report | -- |

### Metadata

| Tool | Description |
| --- | --- |
| `list_task_types` | List task types for a project |
| `get_task_type` | Find a task type by name |
| `list_statuses` | List issue statuses |
| `get_status` | Find a status by name |

> **Text format**: All text fields default to `markdown`.
> Set `descriptionFormat` (or `format` for comments) to
> `"markdown"`, `"html"`, or `"plain"`. Content is passed
> through unmodified -- the format tells Huly how to render it.

### include\_details Flag

Several read tools support an `include_details` boolean parameter that
fetches related data in a single call:

| Tool | Extra data when `include_details=true` |
| --- | --- |
| `get_issue` | Comments, time reports, relations, children |
| `list_issues` | Descriptions, comments, time reports, relations, children (limit reduced to 50) |
| `get_project` | Milestones, components, labels, members |
| `list_projects` | Milestones, components, labels, members per project (limit 20) |
| `get_milestone` | Full list of issues in the milestone |
| `list_milestones` | Issues list per milestone |

### CRUD Coverage

| Entity | Create | Read | List | Update | Delete |
| --- | --- | --- | --- | --- | --- |
| Project | `create_project` | `get_project` | `list_projects` | `update_project` | `delete_project` |
| Issue | `create_issue` | `get_issue` | `list_issues` | `update_issue` | `delete_issue` |
| Label | `create_label` | `get_label` | `list_labels` | `update_label` | `remove_label` |
| Component | `create_component` | `get_component` | `list_components` | `update_component` | `delete_component` |
| Milestone | `create_milestone` | `get_milestone` | `list_milestones` | `update_milestone` | `delete_milestone` |
| Comment | `add_comment` | `get_comment` | `list_comments` | `update_comment` | `delete_comment` |
| Time Report | `log_time` | `get_time_report` | `list_time_reports` | -- | `delete_time_report` |
| Member | -- | `get_member` | `list_members` | -- | -- |
| Status | -- | `get_status` | `list_statuses` | -- | -- |
| Task Type | -- | `get_task_type` | `list_task_types` | -- | -- |

### Issue Templates

Use `create_issues_from_template`:

| Template | Creates |
| --- | --- |
| `feature` | Parent + design/implement/test/docs/review sub-issues |
| `bug` | Parent + reproduce/root-cause/fix/regression-test sub-issues |
| `sprint` | Planning/standup/review/retro ceremony issues |
| `release` | Parent + freeze/QA/changelog/staging/prod/verify sub-issues |

Templates use task types like Epic/Bug when available, falling back
to the workspace default type otherwise.

---

## Security

`npm audit` reports moderate vulnerabilities in Svelte (SSR XSS).
These come from Huly SDK transitive dependencies — the SDK shares packages
with Huly's web frontend. MCP server never renders HTML or uses Svelte.
The vulnerabilities are **not exploitable** in this context.

---

## License

[MIT](LICENSE)
