# Media Servers (Plex and Jellyfin)

**Settings > Media servers** holds SRTL's connections to Plex and Jellyfin. Each server is added once and shared by every feature that reads media servers: [watch sync](watch-sync.md) today, and Now Playing and invitations as they arrive. Radarr and Sonarr stay in **Settings > Integrations**.

Each server shows its type, URL, status (connected, error, not checked, or not signed in), the server version, and, for Plex, the plex.tv account it is signed in as. Both the SRTL API and the worker need network access to the servers.

## Add a server

- **Plex**: select **Add Plex server**, enter a name and the server URL (for example `http://192.168.1.10:32400`), and add it. Then select **Sign in with Plex**. A plex.tv window opens; sign in as the account that **owns** the server and approve "SRTL Manager". Two-factor authentication works as usual. SRTL notices the approval within a few seconds, stores the account token, and tests the connection. If the window was blocked, use the "open it here" link; a sign-in that is not approved in about 15 minutes expires.
- **Jellyfin**: create an API key in Jellyfin under **Dashboard > API Keys**, then select **Add Jellyfin server** with a name, the URL (for example `http://192.168.1.10:8096`), and the key.

If you cannot use the Plex PIN sign-in, paste your Plex account token into **Edit > Plex token** instead. Use your own account's token, never the `PlexOnlineToken` from the server's `Preferences.xml`. SRTL always identifies itself to Plex and Jellyfin as its own client ("SRTL Manager") with a stable client identifier.

## Test, edit, and remove

- **Test connection** reaches the server with its token or key, records the version and status, and, for Plex, the machine identifier and owner account. Features that use the server record their own failures on it too, so the status reflects the last request any of them made.
- **Edit** changes the name, URL, token or key, and path prefix mappings. Saved tokens and keys are never shown again; leave the field empty to keep the saved one. Changing a Jellyfin URL requires entering the API key again, so a saved key is never sent to an address you have not confirmed.
- **Remove** forgets the connection and the per-server records SRTL kept for it (such as discovered users and the item index). Nothing changes on the server. A server that watch sync pairs still use cannot be removed; the message names the pairs to remove first.

## Path prefix mappings

Features match media by SRTL's symlink path. When a server mounts the library at the same place as SRTL (for example `/mnt/plex` everywhere), nothing is needed. Otherwise, map the server's prefix to SRTL's under **Edit > Path prefix mappings**; for example, a Plex container that sees `/data/media/...` while SRTL's symlink folder is `/mnt/plex` maps `/data/media` to `/mnt/plex`. The longest matching prefix wins, and prefixes only match whole folder names.

## Security

Plex tokens and Jellyfin API keys are stored only in SRTL's database. The browser never receives them; the API only reports whether one is saved. Up to 10 media servers can be connected.

## Upgrading

Upgrading to a version with database migration 24 moves the servers that watch sync already had into Settings > Media servers. Each keeps its id, token or key, path mappings, and last status, so pairs, snapshots, and activity carry on without signing in again.
