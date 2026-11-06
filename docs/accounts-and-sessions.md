# Accounts, Sessions And Security Activity

SRTL Manager has one owner, plus any number of admins and moderators who help run it. This guide covers creating the owner on first start, what each role can do, managing accounts, how sign-in is protected, how long sessions last, and where to review activity.

## First Start: The Setup Token

A new instance cannot be claimed by whoever opens it first. Creating the owner account needs a one-time **setup token** that only someone with access to the server can read.

When SRTL Manager starts and no owner exists yet, it:

- generates a random setup token,
- prints it in the API log, in a line that starts with `SRTL Manager setup required. Setup token:` and also gives the setup address, `/setup`,
- saves it as `setup-token` in the API data directory (`SRTL_DATA_DIR`, which is `/tmp/srtl-data` in the Docker image).

To find it with Docker Compose, run one of these from the folder that holds `docker-compose.yml`:

```bash
docker compose logs api | grep "Setup token"
docker compose exec api cat /tmp/srtl-data/setup-token
```

Without Compose, use `docker logs <api container name>` instead. For a source install, the token is in the terminal running the API and in `data/setup-token` under the project folder unless `SRTL_DATA_DIR` points elsewhere.

Open `/setup` on your SRTL Manager address, for example `https://srtl.example.com/setup`, enter the token on the **Initial setup** screen, then choose a username and a password of at least 12 characters.

- The token works once. After setup it is discarded and the file is deleted.
- Until setup is done, the token stays the same across restarts while its file exists. In the Docker image the data directory is temporary, so a new token is printed each time the API container starts; use the newest one.
- To choose the token yourself, for example in automated installs, set `SRTL_SETUP_TOKEN` to 24 or more letters, digits, `-` or `_`. It is then not printed or saved. Remove it once setup is done.
- The setup screen opens on its own at any address only for browsers on this host or the local network. Behind a reverse proxy with `SRTL_TRUST_PROXY` set, internet visitors see the sign-in screen, which has no setup link, and use `/setup` instead. Either way, setup needs the token.
- `/setup` looks the same whether or not an owner exists. A wrong token, or an attempt after setup is complete, gets the same answer, so neither reveals whether setup is still open. A signed-in browser that opens `/setup` goes to the dashboard.

## Roles

The account made during setup is the owner. There is always exactly one.

| | Owner | Admin | Moderator |
|---|:--:|:--:|:--:|
| See library, jobs and Now Playing | Yes | Yes | Yes |
| Run scans and audits, retry and cancel their jobs | Yes | Yes | Yes |
| Copy titles to local | Yes | Yes | Yes |
| Manage invites and joined users (when invitations arrive) | Yes | Yes | Yes |
| Purge, delete, orphan cleanup | Yes | Yes | No |
| Settings, connections, API keys, paths, backups | Yes | Yes | No |
| Storage policies, copies to remote, stopping a stream | Yes | Yes | No |
| Security activity and action audit | Yes | Yes | No |
| Manage moderators | Yes | Yes | No |
| Manage admins | Yes | No | No |
| Transfer ownership | Yes | No | No |

The server enforces this on every request. Controls a role cannot use are also hidden, and opening a page directly that a role cannot use shows a plain "Not allowed" screen.

**What moderators do not receive.** No route gives a moderator a token, API key, IP address, viewer location, connection address, path setting or backup location, including through job logs, job data, error messages and the Now Playing stream:

- In library data and job logs, the configured folders are replaced with labels, so `/your/remote/Movies/Title.mkv` reads `<remote>/Movies/Title.mkv`. Any other absolute path is shortened to its file name, and addresses read `<address>`.
- Backup, watch sync and path migration jobs appear in the job list with their type and status only. Their logs are empty for moderators.
- IP addresses, both IPv4 and IPv6, are removed everywhere. Location fields such as city, region, country, coordinates and ISP are removed too. In Now Playing a moderator sees who is watching and what is playing, and whether the stream is on the LAN or the WAN, but not the viewer's address or location. Job logs show the username of whoever started a copy, with `<address>` in place of where they were, and **Sessions** leaves out addresses, including their own.

**What a moderator's copy does.** A copy started by a moderator never removes anything. It always keeps the remote source, even when **Delete remote source after copies to local** is on, and if files already exist at the destination it can keep both, with the old file kept under a new name, but not replace them. Moderators can stop scans, audits and copies to local, but not copies to remote, cleanups, backups, watch sync or path migrations.

**Retrying failed copies.** Moderators can use **Retry failed** on a copy to local, and it follows the same rule: a retry of a job that replaced existing files keeps both instead, and the remote source stays. Owners and admins are asked first, and a retry only replaces or deletes if they tick that option. A copy to remote can only be retried by someone who may start one.

## Managing Accounts

**Settings > Accounts** is for owners and admins. It lists every account with its role, status, who created it and when, last sign-in, and the latest account changes with who made them. There is no self sign-up.

- **Adding an account** sets a temporary password, typed or generated, which you share with the person privately. The usual password rule applies. The temporary password opens nothing except the screen that replaces it, at first sign-in.
- **Who you can manage.** The owner manages admins and moderators. Admins manage moderators. Nobody can change their own role or manage an account at or above their own level, apart from the owner managing admins.
- **Disable** blocks sign-in and ends the person's sessions, and **Enable** lets them back in. **Delete** removes the account for good; what it did stays in the logs.
- **Reset password** sets a new temporary password and ends the person's sessions.
- **Changing a role** applies to the person's next request, with no need to sign in again. A Now Playing stream they have open closes and reconnects with the new role.
- **Your own password** is under **Settings > User settings**, on every role. Display preferences there are your own too.

### Transferring Ownership

Only the owner can do this, under **Settings > Accounts > Transfer ownership**, by entering their password again. The chosen account becomes the owner and the previous owner becomes an admin. The account must be enabled and must have replaced its temporary password.

The owner cannot be disabled, deleted or demoted any other way. The database enforces this as well as the app: it allows only one owner, and refuses any change that would leave none.

## Sign-In Protection

- There is no default username. Sign-in needs both the username and the password.
- Wrong usernames and wrong passwords get the same message and take the same time, so sign-in does not reveal which usernames exist.
- A disabled account gets the same message and takes the same time as a wrong password.
- After 5 failed attempts for one username, from any address, that username is locked for 30 seconds. Each further failure doubles the lock, up to 15 minutes. After 20 failed attempts from one address, that address is locked for 1 minute, doubling up to 1 hour. A successful sign-in clears both. Locked attempts get "Too many sign-in attempts. Try again later." Restarting the API also clears lockouts.
- On top of that, each address may try to sign in 5 times a minute and change account settings 5 times a minute.
- New and changed passwords need at least 12 characters. A shorter password set before this rule keeps working until you change it.
- Passwords are stored as scrypt hashes with their cost parameters recorded. A password stored with older, weaker parameters is upgraded the next time you sign in with it.

## Sessions

Each browser you sign in with has its own session.

- A session ends after 12 hours without activity (`SRTL_SESSION_IDLE_HOURS`) and 14 days after sign-in however active it is (`SRTL_SESSION_MAX_AGE_DAYS`).
- **Settings > User settings > Sessions** lists every session with its device, address, sign-in time, last activity, and when it ends. **Sign out** ends one session; **Sign out all other sessions** ends every session except the one you are using.
- Changing the password signs out every session and signs this browser in again. Changing the username starts a new session for this browser.
- Disabling or deleting an account, or resetting its password, ends all of that person's sessions immediately.
- With secure cookies (an `https` `SRTL_PUBLIC_ORIGIN`, or `SRTL_COOKIE_SECURE=true`), the session cookie is named `__Host-srtl_session` (with the port suffix in development). Browsers accept that name only over HTTPS, for this exact host, so other sites and subdomains cannot plant or overwrite it. A plain `http` address listed in `SRTL_ALLOWED_ORIGINS` keeps the plain cookie name, because browsers refuse secure cookies there.

## Security Activity

**Settings > User settings > Security activity** is a read-only log, for owners and admins, of:

- successful and failed sign-ins and lockouts,
- setup, including rejected setup attempts,
- password and username changes, and wrong current passwords when changing them,
- sign-outs and sessions ended from the Sessions list,
- account changes: accounts created, disabled, enabled or deleted, role changes, password resets and ownership transfers, each with who did it and to which account,
- removed media servers and stopped Now Playing streams.

Each entry shows the time, the username, the client address, and the browser and system. Entries are removed after `SRTL_JOB_HISTORY_RETENTION_DAYS` days (90 by default), and only the newest 50,000 are kept.

## Upgrading From An Earlier Version

- You stay signed in. Sessions from before the upgrade keep working; their idle timer starts with their first request after the upgrade.
- With secure cookies, your browser's existing session cookie is accepted once and replaced with the `__Host-` cookie automatically.
- Your password keeps working even if it is shorter than 12 characters. The new minimum applies when you change it.
- Your password hash is upgraded automatically the next time you sign in.
- The setup token only matters for a new instance or an empty database. An existing installation never shows a token.
- The update adds database migration 25 (session activity columns and the security activity log).
- Database migration 28 adds roles. Your existing administrator account becomes the owner and keeps its password and sessions, so you stay signed in.
