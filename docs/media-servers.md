# Media Servers (Plex, Jellyfin, and Dupelix)

**Settings > Media servers** holds SRTL's connections to Plex, Jellyfin, and Dupelix. Each server is added once and shared by every feature that reads media servers: [watch sync](watch-sync.md) (Plex and Jellyfin) and [Now Playing](now-playing.md) (all three) today, and invitations as they arrive. Other integrations stay in **Settings > Integrations**.

Each server shows its type, URL, status (connected, error, not checked, or not signed in), the server version, and, for Plex, the plex.tv account it is signed in as. Both the SRTL API and the worker need network access to the servers.

## Add a server

**Add server** opens a menu of the server types; pick one to open its form. The button is unavailable while a form is open or when SRTL already has the most servers it supports.

- **Plex**: select **Add server > Plex**, enter a name and the server URL (for example `http://192.168.1.10:32400`), and select **Add and sign in with Plex**. SRTL adds the server and opens a plex.tv window straight away; sign in as the account that **owns** the server and approve "SRTL Manager". Two-factor authentication works as usual. SRTL notices the approval within a few seconds, stores the account token, and tests the connection. If the window was blocked, use the "open it here" link on the server's card; a sign-in that is not approved in about 15 minutes expires, and **Sign in with Plex** on the card starts a new one.
- **Jellyfin**: create an API key in Jellyfin under **Dashboard > API Keys**, then select **Add server > Jellyfin** with a name, the URL (for example `http://192.168.1.10:8096`), and the key.
- **Dupelix**: as a Dupelix administrator, create an API key. It needs one scope, `activity.read`, which lets SRTL list the streams playing now; streams carry their own artwork. Four more are optional: `activity.stop` for the Stop button, `activity.network` for client addresses, their location, and the LAN or WAN label, `activity.guests` for guest profiles' streams (and stopping them), and `library.read`, which lets SRTL look up a title's artwork when a stream carries none. A key that never expires suits SRTL; keys survive their creator signing out or changing their password. Use one key per address: once Dupelix sees a key over plain HTTP, it marks the key LAN only and refuses it on its HTTPS address. Then select **Add server > Dupelix** with a name, the server's address without `/api/v1`, and the key, which starts with `msk_`. The address can be the public HTTPS one the Dupelix apps use, or a local integration route Dupelix offers, such as its name on a shared Docker network or the host's LAN address with the integration port. SRTL sends the key on every request, including the version check, only in a single `Authorization` header, never in a URL, and never adds forwarding headers. See [Dupelix](#dupelix) below for what SRTL does with it.

If you cannot use the Plex sign-in, open **Or enter a token manually** in the add form (or in **Edit**) and paste your Plex account token; the button then reads **Add Plex server** and no plex.tv window opens. To find your token, open any item in Plex Web, choose **Get Info > View XML**, and copy the `X-Plex-Token` value from the address bar. Use your own account's token, never the `PlexOnlineToken` from the server's `Preferences.xml`. SRTL always identifies itself to Plex and Jellyfin as its own client ("SRTL Manager") with a stable client identifier.

**Sign in with Plex again** on a connected server's card reconnects it through plex.tv, for example after a Plex password change or when the connection stops working.

## Test, edit, and remove

- **Test connection** reaches the server with its token or key, records the version and status, and, for Plex, the machine identifier and owner account. For Dupelix it reads the server's version and API revision and asks Dupelix to describe the key: its name, effective scopes, expiry, and whether it works only on the LAN. A local integration route answers 404 to anything it does not accept, so a 404 there reads "This address is not a Dupelix integration route", while an invalid or revoked key reads "Dupelix rejected the API key". A missing required scope fails the test and the message names the scope; the card then lists the key's scopes, its expiry, and the optional scopes it lacks with what each one adds. When the key is LAN only and the address is HTTPS, the card says so, because every request would be refused. A Dupelix server too old to describe its keys is checked with one page of streams instead. Features that use the server record their own failures on it too, so the status reflects the last request any of them made.
- **Edit** changes the name, URL, token or key, and path prefix mappings. Saved tokens and keys are never shown again; leave the field empty to keep the saved one. Changing a Jellyfin or Dupelix URL requires entering the API key again, so a saved key is never sent to an address you have not confirmed. Changing a Plex URL signs the server out for the same reason: its token and its users' tokens are cleared, so use **Sign in with Plex** again (then watch sync finds the users again), or paste a token with the change. Tokens and keys are stored encrypted with `SRTL_SECRET_KEY`.
- **Remove** forgets the connection and the per-server records SRTL kept for it (such as discovered users and the item index). Nothing changes on the server. A server that watch sync pairs still use cannot be removed; the message names the pairs to remove first.

## Path prefix mappings

Features match media by SRTL's symlink path. When a server mounts the library at the same place as SRTL (for example `/mnt/plex` everywhere), nothing is needed. Otherwise, map the server's prefix to SRTL's under **Edit > Path prefix mappings**; for example, a Plex container that sees `/data/media/...` while SRTL's symlink folder is `/mnt/plex` maps `/data/media` to `/mnt/plex`. The longest matching prefix wins, and prefixes only match whole folder names.

## Dupelix

Dupelix servers feed [Now Playing](now-playing.md). SRTL polls Dupelix's own API (`/api/v1/activity/sessions`) every 5 seconds while someone has Now Playing open; Dupelix has no push channel yet, so its server line reads **Polling** as its normal state. Guest profiles are listed when the key has `activity.guests`. SRTL reads the key's scopes again every ten minutes, so a scope added in Dupelix takes effect without a new test. Dupelix limits how many requests each key makes per minute (120 by default); a 5-second poll uses 12, artwork is cached by its signed link, and when Dupelix answers "too many requests" SRTL waits as long as it asks while the cards keep the last streams. Watch sync does not use Dupelix servers yet: they do not appear in it, and discovering users on one is refused.

Some details are not available from Dupelix yet, and the cards leave them out rather than guess. See [Now Playing](now-playing.md#dupelix) for the list. As Dupelix adds them, SRTL picks them up without a change in settings.

## Security

Plex tokens and Jellyfin and Dupelix API keys are stored only in SRTL's database. The browser never receives them; the API only reports whether one is saved. Up to 10 media servers can be connected.

Upgrading to a version with database migrations 39 and 40 lets media servers be Dupelix servers and keeps what Dupelix reports about each key. Existing Plex and Jellyfin servers are unchanged.

## Upgrading

Upgrading to a version with database migration 24 moves the servers that watch sync already had into Settings > Media servers. Each keeps its id, token or key, path mappings, and last status, so pairs, snapshots, and activity carry on without signing in again.
