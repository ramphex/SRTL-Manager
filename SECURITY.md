# Security Policy

## Supported Versions

Only the newest stable and beta releases receive security fixes while the project is pre-1.0.

## Reporting

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/ramphex/SRTL-Manager/security/advisories/new) for this repository and include the affected version, reproduction steps, impact, and any proposed mitigation.

Never include real credentials, access tokens, mounted paths, file names, logs, or database contents in a report unless they have been fully redacted.

## Deployment

SRTL Manager is intended for a trusted host and still requires authentication. Do not expose it directly to the public internet. Use HTTPS at a trusted reverse proxy, set `SRTL_COOKIE_SECURE=true`, configure `SRTL_ALLOWED_ORIGINS`, and keep Postgres off externally published ports.
