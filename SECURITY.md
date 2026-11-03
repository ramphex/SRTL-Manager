# Security Policy

## Supported Versions

Only the newest stable and beta releases receive security fixes while the project is pre-1.0.

## Reporting

Do not open a public issue for a suspected vulnerability. Use [GitHub private vulnerability reporting](https://github.com/ramphex/SRTL-Manager/security/advisories/new) for this repository and include the affected version, reproduction steps, impact, and any proposed mitigation.

Never include real credentials, access tokens, mounted paths, file names, logs, or database contents in a report unless they have been fully redacted.

## Deployment

SRTL Manager is intended for a trusted host and still requires authentication. Do not expose it directly to the public internet. Use HTTPS at a trusted reverse proxy, set `SRTL_PUBLIC_ORIGIN` to the proxied address (which turns on secure cookies for `https`), list only the proxy's addresses in `SRTL_TRUST_PROXY`, keep the published API port reachable only by the proxy, keep `SRTL_API_DOCS` off, and keep Postgres off externally published ports. See [Reverse proxy and network security](README.md#reverse-proxy-and-network-security) and the [reverse proxy guide](docs/reverse-proxy.md), which includes a checklist to finish before exposing SRTL to the internet.
