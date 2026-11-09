# Changelog

All notable changes are documented here. The project follows Semantic Versioning while allowing breaking changes in prerelease builds.

## [Unreleased]

## [0.1.4] - 2026-11-09

Everything from 0.1.4-beta.1 to 0.1.4-beta.7. The beta sections below have the full detail.

### Added

- Radarr and Sonarr integrations, for any number of instances each: policy tags that follow SRTL storage policies, copy monitoring, size and runtime checks before copies, and optional webhooks that rescan only the affected title.
- Orphan review and purge for both storage locations. It lists every video nothing in the library links to, and folders left with no video. Labels say whether the title is in the library, whether its release is partly linked, and how its size compares with the linked file. Purges hold files in a restorable area or delete them, and recheck every file right before touching it. A purge job has a status window with live progress and its failures.
- Damaged file detection: hollow and partially hollow local files, with a **Library > Damaged files** view that can delete them.
- Optional re-requests: an orphan purge or damaged file delete can ask Radarr or Sonarr to search for a new copy.
- Accounts and roles: one owner plus admins and moderators, each with their own password, sessions and display preferences.
- Scheduled, verified database backups with **Back up now**.
- **Now Playing**: live Plex and Jellyfin streams with host load, and **Settings > Media servers** for shared Plex and Jellyfin connections.
- **Watch sync**: watched state and resume positions between Plex and Jellyfin per user pair.
- **Retry failed** for copy jobs, a daily full inventory scan, a default storage policy for new titles, `SRTL_EXTRA_SYMLINK_DIRS` for symlink folders kept by other tools, and **Discard partial copy** for interrupted copies.

### Changed

- The runtime is Node.js 26 LTS.
- Copies and audits check media much more strictly: source checks before every copy, and truncated or damaged files fail validation. An MKV missing only its last few KB is accepted with a warning.
- Search is forgiving everywhere: case, punctuation, word order and small typos no longer matter.
- The orphan review page is redesigned, and secondary buttons stand out from text across the app.
- Disc formats such as `.vob`, `.iso` and `.img` count as video, and a link to any file counts as use. Remote orphans are deleted immediately, since debrid FUSE mounts can't hold files.
- Purges need a complete symlink scan from the last 24 hours, and no longer ask for a typed confirmation phrase.
- Webhook events are batched per title, symlink scans are faster on large libraries, and Recent Jobs groups repeated jobs for the same title.

### Fixed

- Scans stop with a clear message when a storage root is unmounted or unreadable, instead of marking everything on it missing.
- Deleting folders on a debrid FUSE mount works, one file at a time, and a failed purge is shown as failed with its first error.
- Files opened for a read check are always closed, which Node.js 26 requires.

### Security

- Every API route needs a signed-in account with the right role, first-run setup needs a one-time token, and sign-in has backoff and lockouts.
- Saved Plex tokens and Jellyfin, Radarr and Sonarr API keys are encrypted at rest with `SRTL_SECRET_KEY`.
- Outbound connections are limited to allowed addresses, reverse-proxy headers are trusted only from listed proxies, and error responses no longer leak internals.
- Dependencies and the container base image are updated to clear the known critical and high advisories.

### Upgrade notes

Upgrading from 0.1.3 applies database migrations up to 30 automatically. **Back up the database first**: migrations can't be undone by going back to an older image. Then check:

- **Docker installs must set `SRTL_SECRET_KEY`** (`openssl rand -base64 32`), and keep a copy apart from database backups.
- **Set `SRTL_BACKUP_HOST_PATH`** to a folder owned by `SRTL_UID`, outside your media roots, for scheduled backups.
- **`SRTL_TRUST_PROXY=true` is refused.** List your proxy's addresses instead, or `loopback`.
- **Plex, Jellyfin, Radarr or Sonarr on a loopback address** need `SRTL_OUTBOUND_ALLOW_CIDRS=private,public,loopback`.
- **Installs outside Docker** need Node.js 26 and the PostgreSQL 17 client tools.
- New passwords need at least 12 characters, and the API docs are off unless `SRTL_API_DOCS=true`.

## [0.1.4-beta.7] - 2026-11-09

### Added

- Orphan purge and damaged file delete jobs have a status window, like scans, copies and audits. Open it with the magnifier button in **Recent Jobs** or **View purge status** in **Logs**. It shows live progress with a progress bar, the file being worked on, deleted, held, already missing, failed and remaining counts, the rate and time left, and the first error. Failed items are listed with their reasons and held files with how long they are held, 100 at a time with **Load more**, and **Open holding area** goes to the restore list. **Logs** also shows the purge progress panel for the selected job. New API: `GET /api/jobs/:id/purge-items?outcome=failed|held&offset=&limit=` (up to 500 per page).

### Changed

- Purging all eligible orphans and deleting damaged files no longer ask you to type a confirmation phrase. The dialog still shows the count, size and mode, and the purge starts only when you press its button.

## [0.1.4-beta.6] - 2026-11-09

### Changed

- Disc formats count as video: DVD rips (`.vob`, `.ifo`, `.bup`), disc images (`.iso`, `.img`) and other containers such as `.divx`, `.rmvb`, `.ogm`, `.ogv`, `.asf`, `.f4v`, `.m2v` and `.evo`. DVD rip folders no longer show as folders with no video, and links to these files count as media links.
- The orphan review API leaves out anything a symlink uses, files and folders alike, instead of listing it as protected. It returns `skippedInUse`, with how many files and folders were left out and whether a library link or an extra symlink folder link holds them. This includes targets of symlinks in extra symlink folders. Purges still refuse these items.
- Search is forgiving everywhere: the orphan review, **Search work** on the dashboard, **Search current folder**, the storage policy title filter, **Logs**, and the Radarr and Sonarr title lists. Case, accents and punctuation no longer matter, so `Alpha Bravo` finds `Alpha.Bravo` and `Charlies Lab` finds `Charlie's Lab`. Words can come in any order, and longer words can have a typo: one in words of 5 to 8 letters, two in longer ones. Short words, episode codes such as `S01E02` and years still have to match exactly. An empty search shows the same list as before. The upgrade adds a search column to the symlink table (migration 30), which takes a few seconds on a large library.
- The orphan review page is redesigned so it can be read at a glance. A header gives the total that can be purged, with **How this works** and a separate **Purge all eligible** button. Video files, folders with no video and the holding area are separate tabs. Labels are coloured filter chips with counts, and their explanations sit behind an info button. Each row shows the file name first, with its folder and release state on one muted line, a label chip, and the size with an arrow against the linked file. Once anything is selected, a bar stays at the bottom of the screen with the count and size, **Hold 7 days** or **Delete now**, the Radarr or Sonarr re-request choice, **Clear** and **Purge selected**. Hold is the default on local storage. On remote storage, which cannot move files into the holding area, Hold is turned off with the reason and purges delete immediately. Protected and in-use files are counted instead of listed with checkboxes that could not be ticked. A purge job that fails or partly fails now shows a red banner with its first error, where it used to say it had finished.
- Secondary buttons now stand out from text and input fields across the app: they are raised, semibold and have their own background and border. Segmented controls show unselected options flat, so the selected one is clearer.

### Fixed

- Deleting folders with no video on a debrid FUSE mount failed with EIO and deleted nothing, because the mount refuses to remove a folder that still holds files. Folders are now deleted one file at a time, then the folders that held them, and a folder the mount already removed counts as gone. Only files the check right before the delete saw are touched, each with its own time limit. If one fails, the job says how many files went before it stopped.
- A link to any file, not only video, and a link to a folder now count as use when deciding orphans and folders with no video. Files under a linked folder are no longer listed as orphans, and purges check for a link to the folder or one above it right before each delete. The dashboard's orphan counts and the storage tree still only count exact links, so they can include files under a linked folder.
- An orphan purge job now records its first error, the file and the reason, in its progress beside the failed count, so a failed or partly failed purge can be shown as one without reading the log. The progress shape is the shared `OrphanPurgeJobProgress` type.

## [0.1.4-beta.5] - 2026-11-07

### Added

- Added `SRTL_EXTRA_SYMLINK_DIRS`, for folders of symlinks kept by other tools. Their targets show as still linked in the orphan review and purges refuse them, checking again right before each delete, and refusing altogether if a folder cannot be read. The folders need a read-only mount in the API and worker containers. See [Symlinks kept by other tools](docs/orphan-review.md#symlinks-kept-by-other-tools).
- Added **Retry failed** to copy jobs that finished with failed items, on the job's window, on **Logs** and in **Recent Jobs**. The label says how many items it will retry. It starts a new job through the same checks as any other copy and leaves the old job's history alone. Items that no longer need it are skipped, and it says how many and why: already copied by a later job, a link that has gone or changed, waiting for reconciliation, or already queued. If the original job replaced local files or deleted remote sources, it asks first, and neither happens unless you tick it. See [what a moderator's retry does](docs/accounts-and-sessions.md#roles).

### Changed

- The runtime is now Node.js 26, an LTS release. The container image uses the Node.js 26 bookworm-slim base and stays on the same Debian release and ffmpeg version.
- Orphan purges now need a complete symlink scan of every library folder that started in the last 24 hours. Before, rescanning one title made its whole folder look scanned. Rescans of single titles and scans that failed or were cancelled no longer count, and the warning names the folders to scan. Folders with nothing in them do not hold purges up. Damaged file deletes follow the same rule.
- The orphan review is easier to judge. Unlinked files are split into **Title is in the library**, **Title is in the library, episode is not linked** and **No title match**, a name comparison that the page says can be wrong. Each file shows whether its release is partly linked, and **Older or duplicate versions**, now **Other versions of linked titles**, shows how each file's size compares with the linked file and flags larger ones. The list can be filtered and sorted by all of these. The API keeps its existing fields, and adds `label` and the others beside them. See [Orphan review and purge](docs/orphan-review.md).

### Fixed

- Files opened for a read check are now always closed, including when a slow mount finishes opening one after its time limit, or when the second file of a byte comparison cannot be opened. Node.js 24 only warned about these, but Node.js 26 stops the process.
- Multi-episode names such as `S01E01E02` are now read as their episodes, in the orphan review. They were read as having no episode at all, so a multi-episode file was called an older version whenever anything of that show was linked. It now only is when every episode it holds has a linked file.

### Upgrade notes

Docker installs get Node.js 26 with the image. Installs outside Docker need Node.js 26 before updating.

## [0.1.4-beta.4] - 2026-11-06

### Added

- Added scheduled database backups in **Settings > Backups**: on by default, nightly at 03:30 server time, keeping 7, with a **Back up now** button, the last result, the next run, and a list of backups with their age, size and verified state. Each run is a job in Logs, and runs next to other jobs without using one of their slots. A backup counts only once its checksum and `pg_restore --list` pass, older ones are removed only after that, and at least two verified backups always stay. A failed or overdue backup, or a location that cannot be written, shows on every page and in `/api/health`. Restoring is done by hand, following the tested steps in the [database backups guide](docs/backups.md) (requires database migration 27).
- Added accounts and roles, so several people can help run an instance: one owner, plus admins and moderators, each with their own password, sessions and display preferences. **Settings > Accounts** adds, disables, deletes and resets accounts, changes roles, shows who created and changed what, and transfers ownership. Moderators can see the library, jobs and Now Playing, run scans and audits, retry jobs and copy titles to local. See [Accounts, Sessions And Security Activity](docs/accounts-and-sessions.md#roles).
- Added an option to re-request files when SRTL deletes them. Orphan purges now offer **Also ask Radarr or Sonarr to search for a new copy**, off for every delete until you tick it. The right instance, including a separate 4K one, clears its record of the file, monitors that movie or those exact episodes, and searches, at up to 6 searches a minute per instance (**Settings > Advanced**). The confirmation says which files cannot be re-requested and why, and damaged files and orphan reviews list each result, with a retry for any that failed. See [Radarr](docs/radarr.md#re-requesting-after-a-delete) and [Sonarr](docs/sonarr.md#re-requesting-after-a-delete).
- Added deleting from **Library > Damaged files**, including files that are still in the library, which had no way to be removed before. It follows the same rules as orphan purges: hold or delete now, restorable while held, and files changed in the last 24 hours or part of an unfinished copy are protected. A library file's symlink is removed with it and put back if the file is restored. Owners and admins only.

### Changed

- Display preferences in **Settings > User settings** now belong to each account. Accounts without their own read the ones saved before this version.
- Copies and audits now accept an MKV that is missing only its last few KB, up to 16 KiB less than its header declares, instead of failing it with `File ended prematurely` on every retry. The copy finishes with a warning that says how many bytes are missing, shown on the item and in the job's events, and an audit lists it under **Audit findings** as a warning. The job does not count as failed. A larger shortfall, another container, an MKV with an unknown size, any other structural error, and a copy that does not match its source all still fail.

### Fixed

- Fixed the **Library > Damaged files** link on the dashboard, which opened Library on its Overview tab instead of the Damaged files tab.

### Upgrade notes

The migration service applies database migrations 27, 28 and 29 automatically. Migration 28 makes your existing administrator the owner, keeping their password and sessions, so you stay signed in. On a new install, the account made during first-run setup is the owner.

Backups are on after the upgrade and start at the next 03:30.

- **Docker installs should create the backup folder.** Set `SRTL_BACKUP_HOST_PATH` in `.env` to a folder owned by `SRTL_UID`, outside your media roots. Without it, Compose creates `./backups` owned by root, and Settings > Backups says it cannot be written until you change the owner. A custom Compose file needs the same folder mounted at `/backups` in the worker.
- **Installs outside Docker need the PostgreSQL 17 client tools.** Install `pg_dump` and `pg_restore` version 17 or newer, and set `SRTL_PG_BIN_DIR` if they are not first on `PATH`. Backups go in `backups` inside `SRTL_DATA_DIR` unless `SRTL_BACKUP_DIR` says otherwise.
- **Keep `SRTL_SECRET_KEY` separately from the backups.** A backup cannot restore saved Plex tokens and API keys without it.

### Security

- The sign-in page no longer has a setup link, so it never appears on a server that is already set up. Browsers on the host or the local network still get the setup form on their own while no administrator exists. Anyone else opens `/setup`, an address printed in the API log with the setup token. It looks the same whether or not an administrator exists, and setup still needs the token. See [Accounts, sessions and security activity](docs/accounts-and-sessions.md).
- Every route now resolves to a required permission through one table, and a route with no entry is refused. Webhooks keep their own secret and have no role.
- There is always exactly one owner, enforced by the database as well as the app. Ownership moves only by a transfer that asks for the owner's password again, and leaves the previous owner an admin.
- New accounts and password resets set a temporary password, which opens nothing except the screen that replaces it. Disabling, deleting and resetting end that person's sessions at once, and a role change applies to their next request. A disabled account gets the same sign-in answer as a wrong password.
- Moderators receive no tokens, API keys, IP addresses, viewer locations, connection addresses, path settings or backup locations from any route, including through job logs, job data, error messages and the Now Playing stream. They do still see whether a stream is on the LAN or the WAN, and can read whether Now Playing's location lookup is on. A copy a moderator starts never deletes a file, whatever the settings say.
- Account, role and ownership changes are written to the security activity and the action audit, with who did what. Only owners and admins can read those logs.

## [0.1.4-beta.3] - 2026-11-03

### Added

- Added **Now Playing**, a live-only page in the main navigation: current Plex and Jellyfin streams with play method (hardware or CPU transcode, direct stream, direct play), source and output formats, transcode reasons, bandwidth, LAN or WAN, optional plex.tv location lookup, and whether each file plays from local or remote storage in SRTL; a pinned strip with stream counts, total bandwidth, and host CPU, RAM, network, and NVIDIA GPU sparklines; and Stop with a message (Plex needs Plex Pass). Nothing is stored. See the [Now Playing guide](docs/now-playing.md) for the optional Docker `/proc` mount and GPU setup.
- Added **Settings > Media servers**: Plex and Jellyfin connections now live in one shared place, with type, URL, status, and version for each server, plus add, edit, remove, Test connection, and Sign in with Plex. Watch sync uses these connections (its Servers tab becomes Users, for per-server user discovery), and a server that watch sync pairs still use cannot be removed. Existing watch sync servers move there with their ids, tokens, and status, so nothing needs to be signed in again (requires database migration 24). See the [media servers guide](docs/media-servers.md).

### Security

- Every API route now requires a signed-in admin unless it is explicitly public (sign-in, first-run setup, the liveness check, and the static app files) or a webhook with its secret, and the check runs before the request body is read.
- First-run setup now needs a one-time setup token. It is printed in the API log (`docker compose logs api | grep "Setup token"`) and saved as `setup-token` in the API data directory, or can be set with `SRTL_SETUP_TOKEN`. Whether setup is still pending is reported only to local clients. See [Accounts, sessions and security activity](docs/accounts-and-sessions.md).
- Hardened sign-in: per-username and per-address backoff with lockouts capped at 15 minutes and 1 hour, the same response and timing for unknown usernames and wrong passwords, no default username, a 12-character minimum for new and changed passwords, and a rate limit on account changes.
- Password hashes now record their scrypt parameters and use a higher cost. Older hashes are upgraded on the next sign-in.
- Sessions now end after 12 hours without activity and 14 days after sign-in (`SRTL_SESSION_IDLE_HOURS`, `SRTL_SESSION_MAX_AGE_DAYS`). **Settings > User settings** lists sessions with device, address and last activity, and can sign out one session or all others. Changing the username starts a new session. With secure cookies, the session cookie is named with the `__Host-` prefix.
- Added a security activity log for sign-ins, failures, lockouts, setup, password and username changes, ended sessions, removed media servers, and stopped Now Playing streams, shown read-only in **Settings > User settings** and kept for `SRTL_JOB_HISTORY_RETENTION_DAYS` (requires database migration 25).
- SRTL now records who started a copy or an orphan purge, discarded a partial copy, removed a media server or a Radarr or Sonarr instance, or stopped a Now Playing stream, with the time and the item IDs. Signed-in admins can read the record at `/api/system/action-audit`; copies and purges also note the requester in the job's event log. It needs no database migration.
- Saved Plex tokens and Jellyfin, Radarr and Sonarr API keys are now encrypted at rest with AES-256-GCM using `SRTL_SECRET_KEY` (requires database migration 26, which encrypts the existing values in place). SRTL refuses to start with a different key than the one that encrypted them; `SRTL_DISCARD_UNREADABLE_CREDENTIALS=true` removes only the unreadable credentials when the key is lost.
- A saved token or API key is only sent to the address it was entered for. Changing a Plex server's address signs that server out; Jellyfin, Radarr and Sonarr addresses already required their API key again.
- Added `SRTL_OUTBOUND_ALLOW_CIDRS` for the addresses SRTL may call for Plex, Jellyfin, Radarr and Sonarr. Loopback addresses are refused unless allowed, link-local and cloud metadata addresses are always refused, and every connection, including Now Playing sockets, goes to the address that was checked.
- Now Playing streams now close when their session signs out or expires, and are limited to 4 per session and 32 in total.
- `SRTL_TRUST_PROXY` now takes the addresses or CIDR ranges of your reverse proxies, or `loopback` for a proxy on the same host. Only those peers may set forwarding headers.
- Added `SRTL_PUBLIC_ORIGIN` for reverse-proxy installs. Changes from that origin are accepted, and an `https` origin turns on secure session cookies by default; `SRTL_COOKIE_SECURE=false` together with an `https` public origin is refused at startup. A plain `http` address listed in `SRTL_ALLOWED_ORIGINS` keeps working: sign-ins there use a plain session cookie, because browsers refuse secure ones over plain HTTP.
- `/api/health` and `/api/health/ready` now answer only direct local requests (such as a container health check) or a signed-in admin. `/api/health/live` stays public and returns only that the service is running.
- The API documentation at `/documentation` is now off unless `SRTL_API_DOCS=true`, whatever `NODE_ENV` is, and needs a signed-in admin when on.
- Requests without a session are limited to 600 a minute per client address (`SRTL_ANONYMOUS_REQUESTS_PER_MINUTE`), request bodies are limited to 256 KB except on the signed-in routes that need more (watch sync restore, large copy, audit and purge selections, bulk policy changes), and sign-in bodies to 16 KB.
- Unknown paths under `/api`, `/documentation` and `/assets` now always return a plain 404.
- Error responses no longer include stack traces, file paths, database text, or upstream response bodies. Expected failures keep their plain-language messages (for example "Radarr rejected the API key."); anything unexpected returns a generic message with a request ID, also sent as `X-Request-Id`, that matches the full error in the server log.
- Responses now send `Permissions-Policy`, deny framing (`X-Frame-Options: DENY`, `frame-ancestors 'none'`), and send `Strict-Transport-Security` without `includeSubDomains`.
- Added a [reverse proxy guide](docs/reverse-proxy.md) with Nginx Proxy Manager settings, Authentik forward-auth, brief Caddy and Traefik examples, and a checklist for exposing SRTL to the internet.

### Upgrade notes

The migration service applies database migrations 24, 25 and 26 automatically. Existing sessions keep working, and an existing session cookie moves to the `__Host-` name on its own. Before upgrading, check these:

- **`SRTL_TRUST_PROXY=true` is refused at startup.** Replace it with your proxy's addresses or CIDR ranges, for example `SRTL_TRUST_PROXY=192.168.1.10` or `SRTL_TRUST_PROXY=172.18.0.0/16`, or `loopback` for a proxy on the same host. `false` and an empty value are unchanged.
- **Docker installs must set `SRTL_SECRET_KEY`.** Generate it once with `openssl rand -base64 32` and add it to `.env` before upgrading; the compose file will not start without it. Keep a copy separately from your database dumps, for example in a password manager: a dump cannot be restored with its credentials without the same key. Outside Docker, a key is created once as `secret.key` in the data directory when none is set; back up that file separately as well.
- **Loopback connections need `SRTL_OUTBOUND_ALLOW_CIDRS`.** If Plex, Jellyfin, Radarr or Sonarr is reached at a loopback address such as `127.0.0.1` or `localhost`, set `SRTL_OUTBOUND_ALLOW_CIDRS=private,public,loopback`. LAN and internet addresses work without changes.
- **New installs need a setup token.** First-run setup asks for the token from the API log or the `setup-token` file in the data directory. Installs that already have an administrator are not affected.
- **New passwords need at least 12 characters.** Existing shorter passwords keep working until they are changed.
- **Changing a Plex server's address signs it out.** Use **Sign in with Plex** again or paste a token after the change.
- **The API docs are off by default.** Set `SRTL_API_DOCS=true` to serve `/documentation` to signed-in admins.

## [0.1.4-beta.2] - 2026-11-02

### Added

- Recent Jobs now collapses back-to-back finished jobs for the same title (for example repeated webhook-triggered rescans) into one row with a count, a combined status summary such as "3 jobs · 1 failed", and a chevron that expands the individual jobs with their usual actions. Only adjacent jobs of the same type and exactly one title created within 30 minutes of each other are grouped; running and queued jobs, multi-title jobs and whole-section jobs are never grouped.
- The dashboard Storage overview orphan counts are now links to the orphan review for that location (the total opens the first location, with a picker in Library). The review adds "Purge all eligible", which holds or deletes every unprotected orphan through the existing purge job, with leftover folders only when you opt in. A confirmation dialog shows the count, size, category breakdown, mode, and stale-inventory warnings, defaults to hold, and requires typing a phrase for deletes on remote storage and for any purge over 1,000 items. Purges over 50,000 items are queued as several jobs, and the dialog links to their progress.
- Added the Sonarr integration, replacing the "Coming soon" tab: any number of Sonarr instances, each owning SRTL Shows folders; two policy tags on series that follow SRTL storage policies, with review and import actions for conflicts; copy monitoring that unmonitors exactly the copied episodes when they reach Location 1 and monitors them again on the way back, as each file is verified, while the series stays monitored; Sonarr's episode file size in the pre-copy media check; and optional per-instance webhooks with a generated secret that rescan just the affected series folder. The copy dialog's monitoring checkbox now takes its default from the Radarr or Sonarr instance that owns the folder. See the [Sonarr guide](docs/sonarr.md).
- Added **Watch sync** between Plex and Jellyfin in Settings > Integrations: watched state and resume positions follow each user across both servers, one way or both ways per user pair. Items are matched by their exact SRTL symlink path, so titles never need to match. Plex connects with **Sign in with Plex** (PIN sign-in, two-factor friendly) and every user, including Home, managed, and friend accounts, syncs with their own server token; Jellyfin uses an API key. SRTL suggests pairs from similar names (such as `alex_03` and `Alex`), allows one-to-many pairs, and writes nothing for a pair until you approve its preview. A snapshot of the last synced state lets unwatched propagate and the newest change win without bouncing back. Checks every 5 minutes read only what changed; a weekly full reconciliation runs as a job. Each pair is isolated with retries, so one offline server never stops the others. Pairs can be paused, backed up, and restored, and an activity log lists every change. See the [watch sync guide](docs/watch-sync.md).
- Added partially hollow file detection. Local storage scans now read 24 evenly spaced 256 KB samples (about 6 MB) from files of 50 MB or more that have under 90% of their size stored on disk, and mark a file Damaged when 2 or more samples are all zeros. Files are only sampled when their size, modification time, or stored size changes, remote files are skipped, and read errors are recorded as unknown, never as damaged. Well-compressed files with no zero samples stay fine. Storage views show a Damaged pill, the orphan review counts damaged files, and a new Library > Damaged files view lists every hollow and damaged local file with its size, percent stored, zero samples, whether it is linked, and whether a remote copy exists, with a CSV export. Audits and the pre-copy source check use the same rules (requires database migration 23).
- Added a per-folder default storage policy for new titles in Settings > Library. Titles first seen after it is set (for example Seerr requests imported by Radarr) get Location 1 or Location 2 instead of staying unassigned, recorded with source `default`. Existing titles and existing policies are never changed, a movie that already has the opposite Radarr tag stays in review, and no copy starts automatically. **Apply to unassigned titles now** assigns the default to a folder's unassigned titles after a confirmation. See [Default Policy For New Titles](docs/default-policy.md).

### Changed

- Radarr and Sonarr webhooks now batch per title: events for one movie or series are processed together once it has been quiet for 10 seconds (at most 60 seconds after its first pending event), and queue a single rescan that every event links to. Deleting a season in Sonarr used to create two rescans for ten events; it now creates one, and the job log reads "Title refresh requested by Sonarr (10 events)". Movie and series "added" events only update the catalog and queue no rescan unless the title folder already holds media symlinks.

## [0.1.4-beta.1] - 2026-11-02

### Added

- Added an optional Radarr integration: two configurable policy tags follow SRTL storage policies (only those tags are added or removed), automatic or manual folder mapping, a policy preview with review and import actions, and optional webhook-triggered title rescans. See the [integration guide](docs/radarr.md).
- Added source media checks before every copy, in every verification profile: header and container signature, zero-filled start, end, and sampled regions, hollow (sparse placeholder) files, and a bounded ffprobe that requires a video stream, a duration, and a plausible bitrate. Junk sources fail before any bytes are transferred.
- Added Radarr size and runtime checks for mapped movies: a source smaller than Radarr's recorded file or under half of the movie's runtime is rejected as incomplete or a sample.
- Added orphan purge for both storage locations: a review panel groups orphans into older or duplicate versions, copy leftovers, titles no longer in the library, SRTL leftovers, and unlinked files, with sizes, bulk selection, and a stale-inventory warning. Purges run as durable jobs that recheck every file immediately before touching it, can hold files in a restorable `.srtl-purged` area for a configurable period or delete them immediately, and clean up subtitles, artwork, and empty folders with the last video in a folder.
- Added an option to delete the remote source after a verified, byte-compared copy to local when no other symlink uses it.
- Added Radarr copy monitoring: copies to Location 1 can unmonitor movies in Radarr and copies back to Location 2 can monitor them again, once every file of the movie reaches the destination. A checkbox beside copy buttons defaults to a setting in Settings > Integrations.
- Added a daily full inventory scan, on by default after 05:00 server time and configurable in Settings > Advanced. The worker queues it once a day through the configured folder scheduling, starting the day after the upgrade, and skips it while another scan is queued or running.
- Symlink scans now queue the remote storage scan, usually a few seconds, as a separate job by default, so new downloads are inventoried with the links that point to them.
- Added hollow file detection to storage scans: files of 50 MB or more with almost nothing stored on disk show a Hollow pill in storage views and are counted in the orphan review.
- Added "Folders with no video" to the orphan review: folders left with only subtitles, artwork, samples, or nothing at all. They can be held or deleted with the same purge job, which walks each folder again right before touching it and skips it if a video, symlink, unfinished copy, or recent change appears.
- The orphan review now warns when the storage inventory is unknown or more than 24 hours old. The warning does not block purges, which re-check every file.
- Added support for any number of Radarr instances, such as 1080p, 4K, anime, and remuxes. Each instance has its own connection, policy tag names, copy monitoring default, webhook URL and secret, preview, and activity, and owns the SRTL folders mapped to it; a folder can belong to only one instance. Instances synchronize independently, so one offline Radarr never delays the others. Copy monitoring and media checks use the instance that owns the copied folder. Settings > Integrations > Radarr lists all instances with their status, folders, and last sync, and can add, rename, and remove them. Removing an instance only forgets SRTL's records; tags and monitoring in Radarr are left unchanged. An existing Radarr connection becomes the first instance with its key, secret, and sync state intact, and its webhook URL keeps working.
- Added **Generate secret** to each Radarr instance's Webhooks tab. It fills in a random 43-character webhook secret, shows it once with a Copy button, and applies it when you save. Typing your own secret still works.
- Added a copyable `X-SRTL-Webhook-Secret` header key to each Radarr instance's Webhooks tab, next to the webhook URL and the secret value, each with its own Copy button.
- Turned Radarr webhook setup into seven numbered steps with inline Copy buttons, in the order the work is done. The steps stay open until the instance has a saved secret, then collapse, and the setup guide and `docs/radarr.md` list the same steps and the six triggers to enable.
- Copy buttons now work on plain HTTP installs, where the browser's clipboard API is unavailable, and the webhook URL has its own Copy button.
- Added a per-operation **Discard partial copy** action to Settings > Advanced > Copy recovery for copies interrupted mid-transfer. It previews the temporary file and its size, requires confirmation, and the server re-checks that no active job touches the media before deleting anything.

### Changed

- Radarr copy monitoring now updates each movie as soon as all of its files are copied and verified, instead of after the whole copy job ends, so long batches no longer leave copied movies monitored for hours. Each movie is updated once per copy and instance; the end-of-job pass still catches anything missed and lists titles that did not fully copy, and a job that fails on other titles or never finishes keeps the updates for titles that did copy. Terminating a copy now restores the monitoring of movies it had already changed, since their files are rolled back.
- Media validation after copies and in audits now fails truncated streams (playback ending before the stated duration), structural container errors, and bursts of damaged packets or decoding errors. Previously only ffmpeg's exit status was checked, which let truncated, half-zeroed, and partially corrupted files pass.
- Audits run the same source media checks before ffmpeg and report hollow or junk files directly.
- Symlink scans check up to twelve link targets at once, and scan results are written in batches. Scans of large libraries on NFS finish much sooner.
- Split the Radarr settings into tabs (Connection, Folder mappings, Policy sync, Copy monitoring, Webhooks, and Activity) under one persistent header with the status, enable toggle, and a single Save. Tabs with unsaved edits show a marker, a save blocked by an invalid field on a hidden tab switches to that tab, and the selected tab is remembered per browser.
- Sped up the orphan review on large libraries. Review queries now use set-based joins with indexed path columns, so a library with about 19,000 remote files and 72,000 links loads in under a second instead of about three minutes.

### Fixed

- Scans now stop with a clear message when a storage root they depend on is unreadable or empty, as an unmounted NFS share or FUSE mount is, instead of marking every link on it broken or every file on it missing.
- A read error on the NAS no longer fails a local storage scan. Unreadable folders are retried once at the end, reported as warnings, and their files are not marked missing.
- Links added after the last storage scan now resolve to a storage file: every symlink scan records the files its links point to, without marking any unseen file missing.
- Copy jobs that partially failed no longer leave the replaced local versions of their successful copies behind; upgrades now clean up the previous local file even when another item in the same job fails. Year-numbered seasons such as `S1941E38` are now matched when detecting earlier local versions.
- Mount checks now accept a FUSE or NFS mount whose listing fails partway through a large directory, since one readable entry proves it is mounted. The error is reported instead of the mount being treated as unmounted or empty, and storage walks keep the entries they read before the error without marking anything under the unscanned folder as missing.

### Security

- Cleared the critical and high npm advisories for Fastify, Zod, undici, the router's serializer, Vite, and related packages by updating runtime and development dependencies and refreshing the lockfile.
- Upgraded Vitest to 5 and jsdom to 30; jsdom 30 requires Node.js 24.15 or newer, which CI and release workflows already use.
- Pinned GitHub Actions to their newer releases, each checked against its release tag.
- Pinned a newer Node.js 24 bookworm-slim base image, so the container no longer ships the fixed critical and high vulnerabilities in Debian's perl and pcre2 packages.

## [0.1.3] - 2026-09-03

### Added

- Added an installable progressive web app shell with revisioned static caching, offline-aware startup, explicit update prompts, and mobile-safe application icons.
- Added a compact mobile interface with safe-area-aware navigation, an accessible drawer, touch-sized controls, card layouts for dense operational views, and responsive dialogs and progress screens.
- Added safe failed-copy symlink cleanup with per-link deletion, multi-selection, confirmation, server-side path revalidation, durable cleanup jobs, and audit events.

### Changed

- Extended parallel inventory scheduling across selected symlink folders, local folders, and the remote root so disjoint sources can run on separate worker slots up to the configured scan capacity.
- Reworked the dashboard and mobile navigation with clearer visual hierarchy, more compact controls, and responsive treatments for storage, jobs, logs, libraries, and settings.
- Updated supported application dependencies, Fastify, the pinned Node.js image, CodeQL, and the container build action.

### Fixed

- Scoped concurrent inventory reconciliation and durable resource claims by storage root, media kind, and local section so disjoint jobs can run together without marking one another's files missing or rewriting unrelated policy state.
- Prevented symlink discovery from failing when external library tools replace links during a scan, while retaining bounded refreshes and real filesystem error reporting.
- Prevented authenticated offline startup from stalling before the reconnect screen can render.
- Corrected inventory selection summaries so disabled or cleared sources do not contribute stale folder counts.
- Kept copy-progress fixtures, selected-title disclosures, mobile tooltips, long labels, and interactive job entries aligned with the real job scope and accessible UI behavior.

### Security

- Patched the newly disclosed `fast-uri` vulnerabilities by resolving the runtime dependency to 3.1.7 and 4.1.4, and updated Fastify to 5.12.1.
- Passed npm audit, dependency review, CodeQL, the full test/build/browser suite, and container vulnerability scanning before stable promotion.

## [0.1.3-beta.3] - 2026-09-01

### Added

- Added safe cleanup of symlinks left behind by failed copy jobs, with eligibility determined from durable copy-operation records and revalidated by the worker immediately before unlinking.
- Added per-item trash actions and multi-select cleanup controls directly in failed-copy progress details, including explicit confirmation and cleanup-job progress.
- Protected media and directories during cleanup: it only unlinks the selected managed symlink and refuses links that changed, were superseded, require reconciliation, or cannot be safely verified.

### Changed

- Made the mobile navigation drawer more compact, with reduced dead space, clearer hierarchy, and touch-sized controls.

### Fixed

- Corrected inventory-scan folder counts when a source such as Local files is not selected.

### Security

- Updated browser compatibility metadata to resolve the current high-severity Browserslist advisories used by the development toolchain.

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
