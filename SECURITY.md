# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 3.x     | Yes       |
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

- The Huly SDK (`@hcengineering/*` 0.7.423) still depends on
  Tiptap 2 and Svelte 4. As of 2026-10-17, moderate advisories remain
  in both packages and propagate to their dependent packages in npm audit.
  Fixed releases are outside the SDK's declared major-version ranges;
  forcing Tiptap 3 or Svelte 5 is not a compatible dependency refresh.
  Track an upstream SDK upgrade or a separately validated migration.
  - Svelte advisories concern SSR and browser rendering, which this server
    does not use.
  - [Tiptap GHSA-cp6q-959q-f8rh](https://github.com/advisories/GHSA-cp6q-959q-f8rh)
    concerns prototype-derived executable DOM attributes. The server uses
    Huly's rich-text conversion code, so no blanket non-exploitability claim
    is made. The upstream fix starts at Tiptap 3.30.4.

- [ProseMirror CVE-2026-104847](https://github.com/ProseMirror/prosemirror-view/security/advisories/GHSA-c8x8-7fp4-3x9w)
  is fixed in `prosemirror-view` 1.42.3. The refreshed lockfile resolves
  1.42.6. Packed-package smoke tests require at least 1.42.3 and one copy
  each of the view, model, state, and transform packages in both local and
  global installs. Published npm packages do not carry this repository's
  lockfile; consumers must also refresh their own lockfiles and images.

- The `--get-token` CLI accepts credentials as command-line
  arguments, which are visible in process listings. Use
  environment variables (`HULY_EMAIL`, `HULY_PASSWORD`) instead.
