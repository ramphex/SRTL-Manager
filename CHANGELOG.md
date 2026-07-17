# Changelog

All notable changes are documented here. The project follows Semantic Versioning while allowing breaking changes in prerelease builds.

## [Unreleased]

### Changed

- Documented a reproducible contributor database, secure backup permissions, MIT contribution terms, and structured issue reporting.
- Prepared `0.1.1-beta.1` with Brotli/gzip responses, immutable hashed assets, and on-demand loading for library, job, history, logs, integration, and settings views.

### Security

- Made path-migration rollback fail closed when a symlink changes during recovery.
- Required stable releases to match `main`, scan the published versioned image before promoting `latest`, upload CodeQL results, and use a pinned runtime base image.
- Refused empty or published-placeholder database passwords before application startup.

## [0.1.0] - 2026-07-14

### Added

- Guided first-run setup, inventory, policy assignment, audits, copy workflows, job timelines, and path-change recovery.
- Postgres-backed API and worker services with durable copy-operation journals.
- Production container, hardened Compose deployment, CI, browser smoke tests, and security analysis.

### Changed

- Storage policies now use stable location identities, while the interface presents each policy with its editable friendly name and reserves "Assign" for actions.
- Stable setup follows the `main` branch and `latest` image, and container publication requires an explicit validated release.

### Removed

- Removed the unused interactive setup script; deployment configuration remains the documented `.env` and Docker Compose flow.

### Security

- Added single-admin setup serialization, login throttling, strict session cookies, origin checks, response headers, filesystem containment, bounded child-process output, command timeouts, and non-root containers.
