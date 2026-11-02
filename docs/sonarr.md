# Sonarr Integration

The optional Sonarr adapter is the TV counterpart of the [Radarr integration](radarr.md). It keeps two Sonarr tags matched to SRTL storage policies, can unmonitor the episodes a copy makes local and monitor them again when they go back to remote, and can rescan a series when Sonarr imports files. It works with any number of Sonarr instances, for example one each for 1080p, 4K, and anime. Tags describe **intended storage policy**, not proof of a successful copy. Copies remain manual, and existing transfer verification and rollback safeguards are unchanged.

## Instances

**Settings > Integrations > Sonarr** lists every connected Sonarr instance with its status, the SRTL folders it maps, and when it last synced or what last failed. Select an instance to see its settings tabs: Connection, Folder mappings, Policy sync, Copy monitoring, Webhooks, and Activity. **Add instance** asks for a name, such as "Sonarr 4K" or "Anime", and the pencil button renames one. Names must be unique among Sonarr instances.

Each instance has its own connection, API key, policy tag names, copy monitoring default, webhook URL and secret, mappings, preview, and activity. Instances run independently of each other and of Radarr: an instance that is offline, slow, or failing shows its own error and never delays the others.

**Each SRTL folder belongs to one instance.** Only Shows sections can be mapped. Saving a mapping to a folder another Sonarr instance already maps is refused with a message naming that instance. Automatic mapping only takes free folders that match the instance's own root folders; roots that match a folder owned by another instance are listed separately and excluded.

Storage policies belong to titles, not folders. When the same series exists in several folders, for example `shows` and `shows4k`, every instance that holds it tags it the same way, using its own tag names.

Removing an instance asks for confirmation and deletes only SRTL's records for it. Tags and monitoring in Sonarr are never changed by removal, and its folders become free for another instance. SRTL supports up to 25 Sonarr instances.

## Connect

1. Open **Settings > Integrations > Sonarr**, then add an instance or select one. Enter the Sonarr URL, for example `http://sonarr:8989`, and the API key from **Sonarr Settings > General > Security**, then test the connection. Both the SRTL API and worker need network access to Sonarr.
2. Choose **Automatic** or **Manual** folder mapping. Automatic matches full Sonarr root paths against Shows sections beneath SRTL's configured symlink directory, so a Sonarr root of `/mnt/plex/shows` maps to the `shows` section when SRTL's symlink directory is `/mnt/plex`. Use Manual when container paths differ. A series belongs to SRTL only when its folder sits **directly** under a mapped root, and the series folder name must match the SRTL title folder exactly.
3. Choose the two policy tags, for example `local` and `ignored`. They start empty; the placeholders are examples. Missing tags are created in Sonarr when first needed.
4. Optionally choose whether copies update Sonarr monitoring by default (see below).
5. Use the instance's save button, for example **Save Sonarr 4K settings**.

The URL and API key are enough to test or save a paused connection. Enabling requires both policy tags and at least one folder mapping. A webhook secret is optional and only needed to accept webhooks.

## Policy Tags

While the integration is enabled, SRTL is the source of truth for the two policy tags on each mapped series:

- **Location 1 policy:** the Location 1 tag is added and the Location 2 tag is removed.
- **Location 2 policy:** the Location 2 tag is added and the Location 1 tag is removed.
- **Unassigned:** both policy tags are removed.

Only those two tags are ever added or removed, through Sonarr's series editor. Other tags, quality profiles, file locations, and series monitoring are left alone.

When synchronization is first enabled, or after the tags or mappings change, series with neither policy tag, or whose tag already matches SRTL, follow SRTL automatically. Series where Sonarr already carries the other policy tag, or both tags, show **Needs review** and are not changed until you decide. Any policy you set in SRTL afterward updates the series' tags. In the preview you can also select series and choose:

- **Use SRTL policies:** let SRTL manage the tags using SRTL's current assignments.
- **Import existing tags:** assign a matching SRTL policy from one Sonarr policy tag. Both tags, or a conflicting existing SRTL assignment, cannot be imported.

SRTL re-reads the Sonarr catalog every 30 minutes, and on **Refresh preview**.

## Copy Monitoring

Copy buttons for mapped Shows sections show an **Unmonitor in Sonarr** (copy to Location 1) or **Monitor in Sonarr** (copy to Location 2) checkbox. Its starting value comes from **Update Sonarr monitoring after copies by default** in the Copy monitoring tab of the instance that owns the section. Changing the checkbox affects only copies you start from that view.

Sonarr monitoring changes **episodes, not series**. The series stays monitored, so new episodes keep downloading.

- While a copy with the option runs, SRTL records each episode file as soon as it is copied and verified, in the instance that owns its folder.
- The worker then matches each file to its episodes through Sonarr's episode file paths (`/api/v3/episodefile` and `/api/v3/episode` for the series). A file holding several episodes, such as `S01E03-E04`, changes each of them.
- Copying to Location 1 unmonitors those episodes; copying back to Location 2 monitors them again. Changes are sent in batches through `/api/v3/episode/monitor`.
- Each episode is changed at most once per copy and instance, however often the copy reports it.
- Episodes whose files failed or were skipped are never changed; they are listed as skipped. Files Sonarr has no episode for are left alone and noted on the copy job.
- When the copy ends, SRTL checks the whole selection again and records anything not yet handled.
- Terminating a copy rolls its files back to the source, so SRTL puts episode monitoring back as it was and cancels changes still waiting to be sent.
- Copies that finished before an instance was added, and copies started without the option, never change monitoring.

Results appear in the instance's Activity tab, one row per episode, and in the copy job's event history as one line per series, for example "Unmonitored 8 episodes in Sonarr 4K: Show (2020)".

## Media Checks Before Copying

Before copying an episode, SRTL asks the instance that owns the folder for that series' episode files. When the file being copied matches a Sonarr episode file by path (or, failing that, by a unique file name), Sonarr's recorded size is used to reject partial files, as Radarr's is for movies. Samples and extras have no Sonarr size and are checked as usual. Episode lists are cached for a minute, so copying a whole season asks Sonarr once.

## Configure Sonarr Webhooks (Optional)

Webhooks let Sonarr trigger series rescans after imports. Tag synchronization and copy monitoring do not need them. Each instance has its own webhook URL, `/api/integrations/sonarr/<instance id>/webhook`, and its own secret.

The instance's Webhooks tab walks through these steps, with a **Copy** button for the URL, header key, and a generated secret. The steps are open until the instance has a saved secret, then collapsed under **Webhook setup**.

1. **In SRTL:** choose **Generate secret** (or enter your own: at least 24 characters using letters, numbers, hyphens, or underscores), copy it, then save the instance's settings. Save first: Sonarr's Test is rejected until SRTL has the secret.
2. **In Sonarr:** open **Settings > Connect**, choose **+**, then **Webhook**. Name it `SRTL`.
3. Turn on exactly these triggers: **On File Import**, **On File Upgrade**, **On Rename**, **On Series Add**, **On Series Delete**, and **On Episode File Delete**. Leave all others off, including On Grab, On Health Issue, On Application Update, On Manual Interaction Required, and On Episode File Delete For Upgrade. SRTL rejects event types it doesn't handle with HTTP 400.
4. **Webhook URL:** paste the instance's URL. **Method:** POST. Leave **Username** and **Password** empty.
5. **Headers** (choose **Show Advanced** if they're hidden): add a header with key `X-SRTL-Webhook-Secret` and your secret as the value.
6. Choose **Test**; it should pass. Then choose **Save**.
7. To confirm it works: after the next import, the instance's **Activity** tab shows the webhook event and a title rescan job.

SRTL handles the Sonarr events Test, Download (imports and upgrades), Rename, SeriesAdd, SeriesDelete, and EpisodeFileDelete. A Download waits until the imported episode's symlink exists in the series folder, then queues a rescan of **just that series folder**. A season pack or a season deletion arrives as one notification per episode, so SRTL waits until a series has had no new notification for 10 seconds (and never longer than 60 seconds after its first pending one) and then handles all of its pending notifications together, queuing a single rescan that every notification in the Activity tab links to; the job log notes how many notifications it covers. A Download in the batch holds the whole series until its symlink exists. A SeriesAdd notification only updates the catalog and policy tracking: no rescan is queued while the series folder holds no media symlinks, since the Download notifications that follow do the real rescan. If the folder already holds media, the notification queues a rescan. Payload paths are never trusted: the series and episode file are re-read from Sonarr, and a deleted series is rescanned from SRTL's stored mapping. Duplicate deliveries are suppressed per instance, and each instance's webhook URL has its own rate limit.

## Status And Recovery

Policy synchronization, monitoring updates, and webhook activity appear per instance in Settings > Integrations > Sonarr. Pending notifications, episode lookups, tag updates, and monitoring updates survive restarts and retry with backoff, up to five minutes between attempts, while Sonarr is unreachable. Processed records are retained for 30 days.

Pausing an instance stops its tag updates, monitoring updates, and webhook processing, not scan jobs already queued. Changing the Sonarr address or mappings requires another policy review; changing the address also clears that instance's cached preview and activity.

## Security

The same rules as Radarr apply: use a trusted private network or HTTPS; redirects, credential-bearing URLs, and link-local or metadata destinations are rejected; each webhook secret only authorizes its own instance's endpoint and is stored as a one-way hash; settings require an administrator session. No additional environment variables, containers, or public ports are required.

Sonarr's [webhook implementation](https://github.com/Sonarr/Sonarr/tree/develop/src/NzbDrone.Core/Notifications/Webhook) defines the notification payloads and custom headers.
