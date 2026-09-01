# Contributing

Thanks for your interest in contributing to huly-mcp-server!

## Getting Started

```bash
git clone https://github.com/bgx4k3p/huly-mcp-server.git
cd huly-mcp-server
npm install
```

## Development

- **MCP server:** `node src/index.mjs`
- **HTTP server:** `node src/server.mjs`
- **Unit tests:** `npm run test:unit` — offline, no Huly instance needed.
- **Live tests:** `npm test` runs the integration suite over both transports
  against a real Huly instance. It needs `HULY_URL`, `HULY_TOKEN`, and
  `HULY_WORKSPACE`, plus `HULY_TEST_PROJECT` naming a project that exists in
  that workspace. Without them the suite reads workspace `default` and project
  `START` and fails on missing fixtures rather than on your change.
  `docs/RELEASE_VALIDATION.md` describes the full fixture setup, and
  `scripts/seed-validation-fixtures.mjs` builds a disposable workspace to run
  against.
- **Coverage:** `npm run coverage`.

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm run preflight` (lint, unit tests, response budgets, packed-package
   smoke test) and ensure it passes
4. Run the live suite too if you touched a read or write path
5. Run `npx markdownlint-cli README.md` for markdown lint
6. Push and open a PR against `main`
7. CI must pass before merge

## Code Standards

- No new npm dependencies unless absolutely necessary
- JSDOM polyfills must stay at top of client.mjs before SDK imports
- Use `nameMatch()` for case-insensitive string comparisons
- Every write operation must have a round-trip read-back test
- No silent error swallowing — throw or log, never return defaults

## Reporting Bugs

Open an issue with:

- Steps to reproduce
- Expected vs actual behavior
- Huly SDK version (`npm ls @hcengineering/api-client`)
- Node.js version (`node -v`)
