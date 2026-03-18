# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.x     | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability, please report it
responsibly:

1. **Do NOT open a public issue**
2. Email the maintainer or use GitHub's private vulnerability
   reporting feature (Security tab > "Report a vulnerability")
3. Include steps to reproduce and potential impact
4. Allow reasonable time for a fix before public disclosure

## Known Limitations

- The Huly SDK (`@hcengineering/*`) includes transitive
  dependencies on Svelte with moderate SSR XSS vulnerabilities.
  These are **not exploitable** in this server — it never renders
  HTML via Svelte. The vulnerabilities exist only in Svelte's
  server-side rendering path, which this project does not use.

- The `--get-token` CLI accepts credentials as command-line
  arguments, which are visible in process listings. Use
  environment variables (`HULY_EMAIL`, `HULY_PASSWORD`) instead.
