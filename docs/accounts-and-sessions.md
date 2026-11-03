# Accounts, Sessions And Security Activity

SRTL Manager has one administrator account. This guide covers creating it on first start, how sign-in is protected, how long sessions last, and where to review sign-in activity.

## First Start: The Setup Token

A new instance cannot be claimed by whoever opens it first. Creating the administrator account needs a one-time **setup token** that only someone with access to the server can read.

When SRTL Manager starts and no administrator exists yet, it:

- generates a random setup token,
- prints it in the API log, in a line that starts with `SRTL Manager setup required. Setup token:`,
- saves it as `setup-token` in the API data directory (`SRTL_DATA_DIR`, which is `/tmp/srtl-data` in the Docker image).

To find it with Docker Compose, run one of these from the folder that holds `docker-compose.yml`:

```bash
docker compose logs api | grep "Setup token"
docker compose exec api cat /tmp/srtl-data/setup-token
```

Without Compose, use `docker logs <api container name>` instead. For a source install, the token is in the terminal running the API and in `data/setup-token` under the project folder unless `SRTL_DATA_DIR` points elsewhere.

Open SRTL Manager, enter the token on the **Initial setup** screen, then choose a username and a password of at least 12 characters.

- The token works once. After setup it is discarded and the file is deleted.
- Until setup is done, the token stays the same across restarts while its file exists. In the Docker image the data directory is temporary, so a new token is printed each time the API container starts; use the newest one.
- To choose the token yourself, for example in automated installs, set `SRTL_SETUP_TOKEN` to 24 or more letters, digits, `-` or `_`. It is then not printed or saved. Remove it once setup is done.
- The setup screen opens on its own only for browsers on this host or the local network. Behind a reverse proxy with `SRTL_TRUST_PROXY` set, internet visitors see the sign-in screen, which has a **First start? Set up with a setup token** link. Either way, setup needs the token.
- A wrong token, or an attempt after setup is complete, gets the same answer, so it does not reveal whether setup is still open.

## Sign-In Protection

- There is no default username. Sign-in needs both the username and the password.
- Wrong usernames and wrong passwords get the same message and take the same time, so sign-in does not reveal which usernames exist.
- After 5 failed attempts for one username, from any address, that username is locked for 30 seconds. Each further failure doubles the lock, up to 15 minutes. After 20 failed attempts from one address, that address is locked for 1 minute, doubling up to 1 hour. A successful sign-in clears both. Locked attempts get "Too many sign-in attempts. Try again later." Restarting the API also clears lockouts.
- On top of that, each address may try to sign in 5 times a minute and change account settings 5 times a minute.
- New and changed passwords need at least 12 characters. A shorter password set before this rule keeps working until you change it.
- Passwords are stored as scrypt hashes with their cost parameters recorded. A password stored with older, weaker parameters is upgraded the next time you sign in with it.

## Sessions

Each browser you sign in with has its own session.

- A session ends after 12 hours without activity (`SRTL_SESSION_IDLE_HOURS`) and 14 days after sign-in however active it is (`SRTL_SESSION_MAX_AGE_DAYS`).
- **Settings > User settings > Sessions** lists every session with its device, address, sign-in time, last activity, and when it ends. **Sign out** ends one session; **Sign out all other sessions** ends every session except the one you are using.
- Changing the password signs out every session and signs this browser in again. Changing the username starts a new session for this browser.
- With secure cookies (an `https` `SRTL_PUBLIC_ORIGIN`, or `SRTL_COOKIE_SECURE=true`), the session cookie is named `__Host-srtl_session` (with the port suffix in development). Browsers accept that name only over HTTPS, for this exact host, so other sites and subdomains cannot plant or overwrite it.

## Security Activity

**Settings > User settings > Security activity** is a read-only log of:

- successful and failed sign-ins and lockouts,
- setup, including rejected setup attempts,
- password and username changes, and wrong current passwords when changing them,
- sign-outs and sessions ended from the Sessions list,
- removed media servers and stopped Now Playing streams.

Each entry shows the time, the username, the client address, and the browser and system. Entries are removed after `SRTL_JOB_HISTORY_RETENTION_DAYS` days (90 by default), and only the newest 50,000 are kept.

## Upgrading From An Earlier Version

- You stay signed in. Sessions from before the upgrade keep working; their idle timer starts with their first request after the upgrade.
- With secure cookies, your browser's existing session cookie is accepted once and replaced with the `__Host-` cookie automatically.
- Your password keeps working even if it is shorter than 12 characters. The new minimum applies when you change it.
- Your password hash is upgraded automatically the next time you sign in.
- The setup token only matters for a new instance or an empty database. An existing installation never shows a token.
- The update adds database migration 25 (session activity columns and the security activity log).
