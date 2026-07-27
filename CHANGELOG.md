# Changelog

All notable changes are documented here. The project follows Semantic Versioning while allowing breaking changes in prerelease builds.

## [Unreleased]

## [0.1.2-beta.1] - 2026-07-27

### Changed

- Replaced layout-shifting dashboard action messages with responsive overlay notifications.
- Displayed a copy job's title directly when all selected links belong to one title, while retaining the title list for multi-title jobs.

## [0.1.1] - 2026-07-25

### Added

- Added persistent, scrollable summaries for completed and failed copy items, including single-file failures.
- Added complete job event timelines and automatic inventory refreshes after background work finishes.
- Added contributor database guidance, structured issue forms, and clearer beta setup documentation.

### Changed

- Reduced client startup work with Brotli/gzip responses, immutable hashed assets, and on-demand loading for library, job, history, logs, integration, and settings views.
- Updated the runtime to Node.js 24 LTS and refreshed supported application dependencies, Lucide icons, and pinned GitHub Actions.
- Improved copy-result presentation and kept open inventory work lists synchronized with completed scans and copies.

### Security

- Patched newly disclosed dependency vulnerabilities and kept unsupported TypeScript 7 upgrades out of automated update proposals until the lint toolchain supports them.
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
