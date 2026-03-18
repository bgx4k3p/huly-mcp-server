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
- **Unit tests:** `npm test`
- **Full tests:** Requires a running Huly instance with
  `HULY_URL`, `HULY_TOKEN`, and `HULY_WORKSPACE` env vars set.

## Pull Request Process

1. Create a feature branch from `main`
2. Make your changes
3. Run `npm test` and ensure all tests pass
4. Run `npx markdownlint-cli README.md` for markdown lint
5. Push and open a PR against `main`
6. CI must pass before merge

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
