# Changelog

All notable changes are documented here. The project follows Semantic Versioning while allowing breaking changes in prerelease builds.

## [Unreleased]

## [0.1.3-beta.2] - 2026-08-12

### Added

- Added an installable progressive web app shell with manifest icons, revisioned static caching, offline-aware startup, and an explicit update prompt that never caches API responses or activates updates without confirmation.
- Added a compact mobile application shell with safe-area-aware top and bottom navigation, an accessible navigation drawer, mobile card layouts for dense operational tables, and touch-sized controls.
- Extended parallel inventory scheduling to queue each selected symlink folder, local folder, and the remote root as independent jobs up to the configured scan capacity.

### Changed

- Reworked the dashboard into clearer library-health, storage-overview, quick-action, section-summary, and recent-activity regions with consistent visual hierarchy and compact expandable scan and audit controls.
- Adapted job history, logs, storage policies, library trees, bulk controls, progress views, and selected-title details for narrow screens instead of relying on desktop tables and hover-only interactions.
- Made the mobile login, application dialogs, and long-running job views use dynamic viewport sizing, safe-area spacing, focus containment, scroll locking, and focus restoration.

### Fixed

- Prevented mobile dashboard tooltips, controls, and long labels from overflowing or being hidden behind persistent navigation.
- Prevented authenticated offline startup from stalling on setup checks before the reconnect screen can render.
- Prevented selected-title disclosures from reopening after dismissal and removed invalid nested interactive markup from job log entries.
- Scoped concurrent inventory reconciliation by storage root, media kind, and local section so one scan job cannot mark another job's files missing or rewrite unrelated storage policy state.
- Added durable inventory-scope claims so overlapping scans, copies, and audits remain serialized while disjoint symlink, local, and remote inventory jobs can run concurrently.

## [0.1.3-beta.1] - 2026-08-12

### Added

- Added a persisted inventory setting that can queue selected symlink folders as independent jobs, allowing disjoint folders to scan concurrently up to the configured scan-job capacity.

### Fixed

- Kept symlink scans running when external library tools remove or replace links during discovery, with one bounded refresh pass to capture replacements without hiding genuine filesystem errors.
- Scoped symlink-only folder scans by library section so they can run with work in unrelated sections while still waiting behind overlapping copies, rescans, and audits.

### Security

- Updated the transitive `nanoid` dependency to its patched release.

## [0.1.2] - 2026-08-04

### Added

- Added immutable database-backed job selections so large jobs retain exact, bounded title details without embedding unbounded link arrays in progress payloads.
- Added operator-assisted copy-reconciliation status and safe automatic recovery for journal entries whose current filesystem identity proves their final state.
- Added separate liveness and readiness health checks, periodic configurable terminal-history and expired-session retention, and indexes for worker, audit, and cleanup workloads.

### Changed

- Paginated audit findings, pushed library filters and inventory counts into Postgres, and removed per-result scanner lookups that made large libraries progressively slower.
- Frozen copy behavior when jobs are admitted, including explicit per-job overrides for source-title mismatches, so later settings changes cannot alter queued work.
- Hardened development synchronization with destination ownership checks, argv-safe transfer options, and a non-mutating dry-run mode.
- Decoupled per-file copy concurrency from job-slot count while retaining an explicit process-wide active-file ceiling, validated legacy integrity constraints, and pinned the PostgreSQL runtime image.
- Added configurable in-process worker slots and independent global, per-job-type, and copy-transfer concurrency limits without an arbitrary worker-count ceiling.
- Kept example deployments at one worker slot by default while honoring any positive `SRTL_WORKER_COUNT` value from `.env`.
- Allowed non-overlapping copy, audit, and targeted title-rescan work to run concurrently while broad scans and path migrations remain exclusive.
- Made targeted title rescans validate readable symlink targets, reconcile their exact storage files, and report persistent read failures.
- Retried transient source and transfer I/O failures before failing a copy.
- Matched administrator usernames case-insensitively for login and account conflicts while preserving display capitalization.
- Replaced layout-shifting dashboard action messages with responsive overlay notifications.
- Displayed a copy job's title directly when all selected links belong to one title, while retaining the title list for multi-title jobs.

### Fixed

- Isolated concurrent copy progress so one file transfer cannot leak totals or current-file details into another job or transfer.
- Prevented replaced destination files from being automatically reconciled unless their recorded identity still matches the durable copy journal.
- Closed legacy destination-only reconciliation journals when the original symlink is intact and no temporary or displaced artifacts remain, preserving the unlinked destination for normal conflict handling instead of indefinitely blocking retries.
- Persisted automatic copy-reconciliation resolutions so later service restarts and path checks cannot reactivate already-settled legacy journals.
- Cleared failed copy-submission state whenever the copy dialog selection changes so an earlier title's admission error cannot appear on a later title.
- Allowed superseded recovery records to age out with their terminal jobs while continuing to preserve genuinely unresolved copy state.
- Prevented queued jobs from being reinterpreted after section settings change, rejected malformed password hashes safely, expired stale sessions promptly, and surfaced corrupt stored settings instead of silently substituting defaults.
- Accepted selections beyond the former 1,000-link request limit and loaded large audit result sets incrementally in the interface.
- Prevented superseded legacy copy-reconciliation records from blocking newly scanned media while retaining exact media and managed-path safeguards for genuinely unresolved filesystem state.
- Limited newly queued scoped copy jobs to their actionable media so already satisfied title links no longer inflate job totals or selected-title details.
- Batched large selected-link title lookups and restored title tooltips for multi-link jobs without exceeding the API request limit.
- Derived storage-file assignment exclusively from current linked symlinks so unlinked files cannot remain assigned to a storage location.
- Reconciled legacy storage-file policies during migration and after scans or policy updates.
- Made queue admission, worker claims, stale-job recovery, and job updates lease-aware so overlapping or superseded workers cannot mutate the same job.
- Preserved immutable job resource scopes so later inventory changes cannot remove an active job's overlap protection.
- Scoped legacy failed-copy reconciliation locks to their exact media records and managed paths so newly scanned items from the same title can still be queued.
- Allowed filesystem-read-only scans and audits to run while terminal legacy copy records await reconciliation; path migration and exact conflicting mutations remain fenced.
- Loaded every page of dashboard work lists and made show and season copy actions server-scoped so large sections are never truncated to the first 250 links.
- Accepted routine FUSE and NFS remounts without a false path migration when the canonical path and stable mount signature are unchanged, while retaining exact identity checks during active mutations.

### Security

- Patched current high- and moderate-severity transitive dependency advisories in `fast-uri`, `brace-expansion`, `undici`, and `postcss`.
- Updated the pinned Docker registry login action to its hardened 4.6.0 release.

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
