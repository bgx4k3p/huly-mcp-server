# Scripts

Utility scripts for maintainers and operators. Run them from a source checkout.
Do not commit secrets; pass credentials through environment variables.

## `repair-reported-time.mjs`

Repairs issue `reportedTime` totals by recomputing them from
`TimeSpendReport` child records.

Use this after upgrading from versions before `2.4.3` if project summaries or
issue time totals show concatenated string values.

### Required Environment

```bash
export HULY_URL=https://your-huly-instance.com
export HULY_TOKEN=...
```

Or use email/password auth:

```bash
export HULY_URL=https://your-huly-instance.com
export HULY_EMAIL=you@example.com
export HULY_PASSWORD=...
```

### Dry-Run

Dry-run is the default and makes no writes:

```bash
node scripts/repair-reported-time.mjs
```

### Apply

Review dry-run output first, back up production data, then apply:

```bash
node scripts/repair-reported-time.mjs --apply
```

### Filters

Limit repair scope when needed:

```bash
node scripts/repair-reported-time.mjs --workspace=my-workspace
node scripts/repair-reported-time.mjs --workspace=my-workspace --project=PROJ
```

### Behavior

- Scans all accessible workspaces unless `--workspace` is provided.
- Scans all projects in each workspace unless `--project` is provided.
- Updates only issues whose stored `reportedTime` differs from the sum of their
  time reports.
- Treats time reports as the source of truth.
- Exits nonzero if any workspace fails.
