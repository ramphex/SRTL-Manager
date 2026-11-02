# Watch Sync (Plex and Jellyfin)

Watch sync keeps **watched state** and **resume positions** in sync between Plex and Jellyfin users, so people who move between the two servers never lose their place. Each pair of users syncs one way or both ways.

It works because both servers read the same SRTL symlinks. An item is matched by its exact SRTL path (for example `/mnt/plex/movies/Alpha (2020)/Alpha.mkv`), never by title, year, or metadata IDs, so it cannot pick the wrong movie or episode and works the same in both directions. Movies and episodes are synced; music, photos, home videos, Live TV, and anything else that is not an SRTL media symlink are skipped and counted, never treated as errors.

Watch sync lives in **Settings > Integrations > Watch sync**, next to Radarr and Sonarr.

## 1. Connect the servers

Open the **Servers** tab and add each server. Both the SRTL API and the worker need network access to them. Tokens and API keys are stored on the SRTL server only; the browser never receives them again, and the fields stay empty after saving ("Saved. Leave empty to keep it.").

### Plex: Sign in with Plex

1. **Add Plex server**, enter a name and the server URL (for example `http://192.168.1.10:32400`), and add it.
2. Select **Sign in with Plex**. A plex.tv window opens; sign in as the account that **owns** the server and approve "SRTL Manager". Two-factor authentication works as usual because you sign in at plex.tv itself.
3. SRTL notices the approval within a few seconds, stores the account token, and discovers users.

If the window was blocked, use the "open it here" link that appears. A sign-in that is not approved in about 15 minutes expires; start it again.

**Pasting a token instead.** If you cannot use the PIN sign-in, paste your Plex account token into **Connection and path mappings > Plex token**. Use your own account's token, never the `PlexOnlineToken` from the server's `Preferences.xml`: that token belongs to the server, and plex.tv would apply SRTL's client details to the server's own registration.

SRTL always identifies itself to Plex as its own client ("SRTL Manager", with a stable client identifier). It does not claim to be a player or controller and never switches Plex Home users.

### Plex users

**Test and discover users** lists everyone who can use the server:

- **Owner**: the account you signed in with.
- **Plex Home** members and **Managed** users (Home users with restrictions).
- **Friends**: accounts the server is shared with.

Each user syncs with their *own* server access token, read from plex.tv's list of shared-server tokens, so every write lands in that user's own history and nobody's restrictions change. A user marked "No server access token" has not been shared any library on this server; share at least one library with them in Plex, then discover users again. Users who lose access stay listed (pairs may refer to them) but stop syncing.

### Jellyfin: API key

1. In Jellyfin, open **Dashboard > API Keys** and create a key, for example named "SRTL Manager".
2. In SRTL, **Add Jellyfin server** with a name, the URL (for example `http://192.168.1.10:8096`), and the key.
3. **Test and discover users** lists the Jellyfin users. Disabled users are listed but cannot be paired.

### Path prefix mappings (optional)

Watch sync needs to turn each server's file path into SRTL's symlink path. When a server mounts the library at the same place as SRTL (for example `/mnt/plex` everywhere), nothing is needed. Otherwise, under **Connection and path mappings**, map the server's prefix to SRTL's. For example, a Plex container that sees the library as `/data/media/...` while SRTL's symlink folder is `/mnt/plex` needs:

| Server path prefix | SRTL path prefix |
| --- | --- |
| `/data/media` | `/mnt/plex` |

The longest matching prefix wins, and prefixes only match whole folder names (`/data/media` does not match `/data/mediaextra`). Each server shows how many SRTL items it has indexed; if that stays at 0 after a preview, a prefix mapping is probably missing.

## 2. Pair users

The **User pairs** tab suggests pairs whose names match once case, punctuation, and digits are ignored, such as Plex `ElJefe_03` and Jellyfin `Eljefe` (shown as "similar name") or `Friend.Bob` and `friendbob`. Check each suggestion before selecting **Pair**. Names that match more than one user are not suggested. You can also pair any two users manually.

- **One-to-many is allowed.** A Plex user can be paired with several Jellyfin users and the other way round. Each pair is independent.
- **Direction**, per pair:
  - **Plex → Jellyfin**: changes made in Plex are copied to Jellyfin. Changes made in Jellyfin are noted but never copied back.
  - **Jellyfin → Plex**: the reverse.
  - **Both ways**: changes on either side are copied to the other. When both sides changed the same item since the last sync, the most recent change wins (Plex `lastViewedAt` against Jellyfin's last played date).
- **Watched** and **Resume position**: each can follow the default from the Options tab or be turned on or off for the pair. With Watched off, only resume positions sync; with Resume position off, only watched and unwatched sync.
- **Enabled** turns a pair off without removing it; **Pause** and **Resume** stop and restart it. **Pause all** at the top stops every pair.

## 3. Preview and approve

Nothing is written for a pair until you approve it.

1. Select **Preview** on the pair. A job reads both users' libraries and works out what the first sync would change, without writing anything.
2. The pair shows the counts per direction (watched, unwatched, resume positions), how many items both servers share, how many were skipped as non-SRTL paths, and up to 50 example titles.
3. Select **Approve and start syncing**. A full sync job applies the changes, then the pair syncs on its own every few minutes.

The first sync of a pair only adds history: an item watched on one side is marked watched on the other, and a resume position is copied, but it never marks anything unwatched. Later syncs do propagate unwatched.

## How syncing works

For every pair and path, SRTL remembers the state each server had when the pair last synced it: watched, resume position, and when it was last played. That snapshot is the base of a three-way comparison:

- A side **changed** when its current state differs from its snapshot. Resume positions within 30 seconds of each other count as the same.
- A change is copied in the directions the pair allows. Marking an item **unwatched** is a change like any other and is copied too.
- SRTL's own writes update the snapshot, so the next check sees nothing new and nothing bounces back and forth.
- A write that fails keeps the old snapshot, so it is retried on the next check.

**Every few minutes** (5 by default, set in Options), the worker asks each server only for what changed since the pair's last check, using the server's own clock:

- **Plex**: items whose `lastViewedAt` changed, newly added items, the user's On Deck (resume positions), and the owner's play history since then. Plex reports nothing when an item is marked unwatched, so each check also re-reads a few hundred of the pair's previously synced items in rotation; an unwatch made in Plex reaches Jellyfin within a few hours on a large library, or sooner after a full reconciliation.
- **Jellyfin**: items whose user data changed since then (`MinDateLastSavedForUser`) and newly added items.

**Every week** (configurable), a **full reconciliation** job reads every paired user's whole library on both servers, page by page with a short pause between pages, rebuilds SRTL's path-to-item index, and fixes any difference. It shows progress on the Jobs page. **Full reconciliation** at the top, or **Full sync now** on a pair, runs one immediately.

Requests use 20-60 second timeouts, small pages, a new connection for each request, and retries with backoff for timeouts, 429, and 5xx responses.

### When a server or user fails

Each pair syncs on its own. If a server is down, or a user's token stops working, that pair records the error (shown on the pair and the server) and retries after a growing delay, up to an hour. Other pairs carry on. Changes made while a server was down are picked up when it returns, because the pair's cursors only advance after a successful check.

## Activity

The **Activity** tab lists every change watch sync made, per pair or for all pairs: what changed, on which server, in which direction, and whether it came from the timer or a job. Errors are listed too. Entries are kept for 30 days. Preview, reconciliation, and restore jobs also write their summaries to the job's event history.

## Backup and restore

**Back up** on a pair downloads its snapshots as JSON: for every path the pair has synced, the watched state and resume position on each server as of the last sync.

To restore, open **Restore from a backup** on the pair, choose **Restore to Jellyfin** or **Restore to Plex**, and choose the backup file. A job writes the backup's states to that server for every item it can find there. It runs even if the pair's direction would not write to that server. The pair's next sync then treats the restored states like any other change. Restoring is useful after rebuilding a server or a user account.

## Notes and limits

- **Tautulli**: watches and positions that SRTL sets through the Plex API are not plays, so they do not appear in Tautulli's history. Plays you make in Plex still do.
- Plex marks an item watched with the time of the write; Jellyfin keeps the original play time that SRTL sends.
- An item that only one server has (for example, not yet scanned into Jellyfin) is skipped until both servers list it.
- Multi-version Plex items are written once even when SRTL has a symlink for each version.
- Removing a server or a pair forgets SRTL's records for it (users, snapshots, index, activity). Nothing is changed on Plex or Jellyfin.
- Emby is not supported.
