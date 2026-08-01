# Changelog

All notable changes are documented here. The project follows Semantic Versioning while allowing breaking changes in prerelease builds.

## [Unreleased]

## [0.1.2-beta.4] - 2026-08-01

### Fixed

- Prevented superseded legacy copy-reconciliation records from blocking newly scanned media while retaining exact media and managed-path safeguards for genuinely unresolved filesystem state.
- Limited newly queued scoped copy jobs to their actionable media so already satisfied title links no longer inflate job totals or selected-title details.
- Batched large selected-link title lookups and restored title tooltips for multi-link jobs without exceeding the API request limit.
- Derived storage-file assignment exclusively from current linked symlinks so unlinked files cannot remain assigned to a storage location.
- Reconciled legacy storage-file policies during migration and after scans or policy updates.

## [0.1.2-beta.3] - 2026-07-31

### Changed

- Added configurable in-process worker slots and independent global, per-job-type, and copy-transfer concurrency limits without an arbitrary worker-count ceiling.
- Kept example deployments at one worker slot by default while honoring any positive `SRTL_WORKER_COUNT` value from `.env`.
- Allowed non-overlapping copy, audit, and targeted title-rescan work to run concurrently while broad scans and path migrations remain exclusive.

### Fixed

- Made queue admission, worker claims, stale-job recovery, and job updates lease-aware so overlapping or superseded workers cannot mutate the same job.
- Preserved immutable job resource scopes so later inventory changes cannot remove an active job's overlap protection.
- Scoped legacy failed-copy reconciliation locks to their exact media records and managed paths so newly scanned items from the same title can still be queued.
- Allowed filesystem-read-only scans and audits to run while terminal legacy copy records await reconciliation; path migration and exact conflicting mutations remain fenced.
- Loaded every page of dashboard work lists and made show and season copy actions server-scoped so large sections are never truncated to the first 250 links.
- Accepted routine FUSE and NFS remounts without a false path migration when the canonical path and stable mount signature are unchanged, while retaining exact identity checks during active mutations.

## [0.1.2-beta.2] - 2026-07-29

### Changed

- Made targeted title rescans validate readable symlink targets, reconcile their exact storage files, and report persistent read failures.
- Retried transient source and transfer I/O failures before failing a copy.
- Matched administrator usernames case-insensitively for login and account conflicts while preserving display capitalization.

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
