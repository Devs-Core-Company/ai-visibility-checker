# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

- GitHub: **Security → Report a vulnerability** on this repository, or
- email **contact@devs-core.com** with "AVC security" in the subject.

Include what you found, how to reproduce it, and the version (`avc --version`). We will acknowledge
the report, keep you updated, and credit you in the release notes if you wish.

## Supported versions

Security fixes go into the latest release.

## How the app protects you

- **Local by default.** Data stays in `~/.avc` (or `AVC_DATA_DIR`). There is no telemetry. The app
  only contacts the sites you audit and the services you configure.
- **Secrets.** Keys live in environment variables or `~/.avc/config.json`, written with file mode
  600. They are never written to `avc.config.json`, reports or logs, and the dashboard shows them
  masked.
- **Dashboard.** Binds to `127.0.0.1`; needs a random per-start session token (HttpOnly,
  SameSite=Strict cookie); refuses unexpected `Host` headers (DNS rebinding) and cross-origin form
  posts; strict Content Security Policy.
- **Changes to your site.** Fixes are previewed first. Applying needs an explicit confirmation in
  the CLI, the dashboard and the MCP server. WordPress changes save a rollback snapshot first.
- **Spending.** AI runs show an estimate first and stop at the per-run and monthly caps.

## Scope

In scope: this repository's code, installers, Docker image and GitHub Action. Out of scope: the
sites you audit, third-party APIs, and the free web checker at devs-core.com (report those to
contact@devs-core.com).
