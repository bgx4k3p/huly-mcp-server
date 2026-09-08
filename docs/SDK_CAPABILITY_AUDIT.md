# Huly SDK Capability Audit

Audit date: 2026-09-07

This audit compares the MCP surface with three distinct sources of truth:

- the installed public Huly packages (`@hcengineering/*` 0.7.423),
- the Huly platform model and UI at tag `v0.7.426`, and
- the self-hosted validation server (`0.7.392`).

Those layers are deliberately separate. The public client is a generic
transaction API, many product capabilities are represented by model classes or
mixins rather than named SDK methods, and an SDK declaration alone does not
prove that an older server supports the same behavior.

At the audit date, npm's `latest` public SDK package was still 0.7.423, which is
already pinned by this repository. Huly platform release 0.7.426 is newer, but
there is no matching 0.7.426 public SDK publication to upgrade to.

## Why the previous CRUD pass missed relationship removal and collaborators

The previous suite proved that every *advertised MCP tool* reached its client
method and that the advertised create/read/update/delete paths persisted. It did
not independently inventory the Huly model and then compare that inventory with
the MCP schemas.

That left four blind spots:

1. An add operation was treated as complete without requiring its inverse.
2. Milestone collaborators are attached `Collaborator` documents supplied by a
   notification mixin, not fields declared on the tracker `Milestone` type.
3. Tool-schema coverage could pass while a client method accepted more fields
   than the MCP schema exposed.
4. Delete tests checked that the target disappeared, but not that referencing
   documents remained valid.

## Gaps closed in this change

| Capability | Previous gap | Resolution and regression gate |
| --- | --- | --- |
| Related issues | Add only | `remove_relation`, including one-sided-data repair and idempotent no-op tests |
| Blockers | Add only | `remove_blocked_by`, with persistence checks |
| Milestone collaborators | Not exposed | Create, read, replace, de-duplicate, and clear attached collaborator records |
| Milestone deletion | Could leave issue references behind | Clear references or move issues to `moveIssuesTo` before deletion |
| Time reports | Create/read/delete only; reads omitted employee, and bare-client edits did not update the issue aggregate | Update hours, description, date, and employee; read employee attribution; atomically adjust the parent issue total |
| Issue references | Assignee, component, and milestone could not be cleared through `update_issue` | Empty values now persist `null` and have exact-value tests |
| Project archive | Archived projects became undiscoverable to the MCP client | Lookups use the SDK `showArchived` option, so restore now round-trips |
| Batch issue creation | Implementation accepted fields hidden by the MCP schema | Batch item schema is mechanically tested against the single-create fields |
| Issue history | Client method existed without an MCP route | Added `get_issue_history` and route coverage |
| Stored issue templates | Convenience generators did not manage Huly's `IssueTemplate` documents | Create/get/list/update/delete, including embedded children, labels, task types, related documents, and editor-valid markup |
| Project members and owners | No mutation path; membership expansions incorrectly resolved account UUIDs as employee document IDs | Create/update complete sets, resolve names correctly on reads, preserve ownership constraints, and remove departed members from project-role assignments |
| Project defaults | Missing status and time-report-day writes and reads | Create/update defaults and read with `include: ["defaults"]`; validate status against the default task workflow |

## Confirmed product capabilities still not exposed

These are real Huly model/account-client capabilities, not spelling aliases for
an existing MCP tool. They should be implemented in risk-sized follow-up work,
with a live consumer-side test for each lifecycle.

### Tracker and task model

- Apply stored issue templates through MCP. The new template CRUD manages the
  same documents the Huly UI consumes; `create_issues_from_template` remains a
  separate convenience generator with its existing predefined templates.
- Comments on milestones, components, and issue templates. Current comment
  tools are deliberately issue-scoped.
- Attachment lifecycle and blob upload/download.
- Issue `ToDo` lifecycle.
- Administrative configuration mutation for statuses, task types, project
  types, and related rank/category data.

### Account client

- Remove/leave workspace membership.
- Release a social identity.
- Subscription read/upsert operations beyond the current compact subscription
  listing.
- Workspace permission and owner-administration operations.

## Requires live behavioral validation before classification

- Deleting a component or label that is still referenced. The target delete
  currently round-trips, but referential cleanup/denial must be verified from
  the consuming Huly UI and model, as was done for milestones.
- Invite revocation/listing. The account client exposes send, resend, and link
  creation, but the supported inverse varies by server deployment.
- Mailbox update/read-by-id semantics. The available account API is not a
  conventional four-operation resource surface.

## Intentionally outside automatic MCP exposure

The account SDK also contains authentication, password reset, OTP/2FA, account
deletion, service-administration, integration-secret, backup, and usage/billing
operations. A literal wrapper around every callable SDK method would expose
security-sensitive or deployment-internal actions. Each needs an explicit
threat model, authorization policy, redaction rules, and operator opt-in before
it can become an MCP tool.

## Coverage gates going forward

The release definition of “full round-trip coverage” now requires all of the
following for every supported entity or relationship:

1. Compare MCP schemas against the model fields, mixins, attached collections,
   and public account-client methods—not only against existing dispatch code.
2. Require inverse-operation tests for every add/link/assign operation.
3. Require create/update schema parity unless a field is explicitly documented
   as immutable.
4. Verify reference integrity after destructive operations.
5. Read persisted state independently of mutation responses and, where the MCP
   reader could mask an invalid storage shape, validate through the real Huly
   consumer/model.
6. Run the lifecycle over both WebSocket and REST transports against the oldest
   supported server version.

This document is the capability backlog, not a claim that every generic Huly
transaction or privileged account operation is currently exposed.

## Validation of the current working change

- Unit suite: 560 tests passed, including template field/child lifecycle,
  pagination, project scoping, account UUID resolution, ownership validation,
  role-assignment cleanup, and create/update field exposure.
- Live CRUD on server 0.7.392: 49 passed on WebSocket and 49 passed on REST;
  each run deliberately skips the workspace-deletion test that permanently
  consumes a workspace slot.
- Live tests independently inspect template markup and stored model references,
  read project members/owners/defaults, and recheck relationship removal,
  milestone collaborators, and the time-report aggregate invariant.
  Custom project-role cleanup has unit coverage;
  the live workspace does not provide an assigned custom-role fixture for that path.
- Lint, response-corpus budgets/privacy scan, and packed project-local/global
  installation smoke tests passed.
- Tool catalogs: full 91 / 53,672 bytes; project 64 / 43,526 bytes;
  read 39 / 19,947 bytes.
