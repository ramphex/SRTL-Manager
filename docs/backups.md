# Database backups

SRTL Manager backs up its PostgreSQL database every night and checks each backup before trusting it. Configure it in **Settings > Backups**.

## What it does

Out of the box, backups are on, start at 03:30 server time and keep the 7 newest. The schedule starts at the next 03:30 after the first start, not right away. A start missed while the worker was down runs once when it returns. Turning backups off or changing the time never starts a backup that was already due.

Each run is a job like any other, so it appears in **Logs** and only one can run at a time. It runs next to your scans and copies without using one of their job slots, at a lower CPU priority, and it gives up rather than wait behind a database schema change.

A run takes these steps:

1. Check the location, the PostgreSQL tools and the free space. It needs half the database size, or one and a half times the last dump, plus 64 MB.
2. Run `pg_dump` in custom format to a temporary name, and rename the file only once the dump has finished.
3. Write the SHA-256 file, then verify: re-read the dump against that checksum and run `pg_restore --list`, which must find the SRTL Manager tables.
4. Write the manifest. A backup counts as verified only with its manifest.
5. Remove older backups.

A backup that fails verification is deleted, the job fails, and nothing older is touched.

## The files

Backups are written to a folder named `srtl-manager-backups` inside the location you choose, so SRTL Manager never changes the permissions of a folder it did not create. The folder has mode 700 and every file has mode 600.

| File | What it holds |
| --- | --- |
| `srtl-manager-backup-<UTC time>-j<job>.dump` | The database, in `pg_dump` custom format |
| `<same name>.dump.sha256` | Its checksum, readable by `sha256sum -c` |
| `<same name>.manifest.json` | Time, app version, migration, database size, PostgreSQL versions, checksum |

## What gets removed

After a new backup verifies, the newest ones up to your setting stay and older ones go. At least two verified backups always stay, whatever the setting says.

Only files with this feature's name and a matching manifest can be removed. Your own files, and anything with a backup's name but no valid manifest, stay put, even in the same folder. Damaged backups are shown as **Not verified**, do not count toward what is kept, and go once enough newer verified ones exist.

Changing the location does not move or remove backups already at the old one.

## Choosing a location

The location must be an absolute path that the worker can write. It is refused if it is a system or temporary folder (such as `/etc` or `/tmp`), too broad to be a backup folder (such as `/home` or `/mnt`), a media or symlink root, inside one, or a parent of one. Symbolic links are followed before checking.

In Docker, the worker can only reach folders mounted into it, and the default location, `/backups`, is the folder `SRTL_BACKUP_HOST_PATH` points at. Create that folder before starting, owned by your `SRTL_UID`:

```bash
mkdir -p /path/to/backups
chown "$SRTL_UID:$SRTL_GID" /path/to/backups
chmod 700 /path/to/backups
```

If Docker creates the folder for you it belongs to root, and Settings > Backups will say the worker cannot write there until you change the owner.

Outside Docker, the default is `backups` inside `SRTL_DATA_DIR`. Set `SRTL_BACKUP_DIR` to choose another default.

## PostgreSQL tools

`pg_dump` must be at least as new as the database server. The Docker image includes the PostgreSQL 17 client. Outside Docker, install the client tools for version 17 or newer. If they are not first on `PATH`, set `SRTL_PG_BIN_DIR`, for example `/usr/lib/postgresql/17/bin` on Debian and Ubuntu.

## When something goes wrong

A failed backup, a backup that did not finish within two hours of its start time, or a location or tool problem shows on every page of the app until it is fixed. `/api/health` reports the kind of problem as `backups`: `ok`, `disabled`, `failed`, `unavailable` or `overdue`. Failures also appear in **Logs**. A failed scheduled backup is tried again at the next start time, or use **Back up now**.

## Keep them safe

Dumps contain password hashes, encrypted keys, paths and library history, so treat them like passwords. Only the owner and admins can see backup details, and the app has no way to download a backup. Settings changes and manual runs are recorded in the action audit at `/api/system/action-audit`.

Saved Plex tokens and Jellyfin, Radarr and Sonarr API keys are encrypted with `SRTL_SECRET_KEY`, which is not in the backup. **Keep a copy of that key somewhere separate from the backups.** Without the same key, those credentials cannot be read after a restore; see [Secret key](../README.md#secret-key) for what happens then.

A backup on the same disk as the database does not survive that disk. Copy the backup folder to another machine as well.

## Restoring a backup

Restoring replaces the whole database, so the app has no restore button. These steps have been run against a throwaway database, and the automated tests repeat the same `pg_restore` command on every run.

Set these once, using the name of the backup you chose:

```bash
BACKUP=srtl-manager-backup-20261104T033000Z-j12
FOLDER=/path/to/backups/srtl-manager-backups
```

Check the checksum. It must print `OK`:

```bash
(cd "$FOLDER" && sha256sum -c "$BACKUP.dump.sha256")
```

Stop the API and worker, keeping the database running:

```bash
docker compose stop api worker
```

**This deletes the current database.** Empty it:

```bash
docker compose exec -T postgres sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB" && createdb -U "$POSTGRES_USER" "$POSTGRES_DB"'
```

Restore the dump:

```bash
docker compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --no-owner --exit-on-error' < "$FOLDER/$BACKUP.dump"
```

Start everything, using the same `SRTL_SECRET_KEY` as when the backup was made:

```bash
docker compose up -d
```

The migration service brings an older backup up to the current schema on the way up. Check that the app opens, your library is there, and a Plex, Jellyfin, Radarr or Sonarr connection still tests successfully.

To try a backup without touching the real database, restore it into another one: `createdb` a new name, point `pg_restore -d` at it, look around with `psql`, then `dropdb` it.

Outside Docker, the same `dropdb`, `createdb` and `pg_restore` commands work with your database's `-h`, `-p` and `-U` options, and `PGPASSWORD` in the environment.
