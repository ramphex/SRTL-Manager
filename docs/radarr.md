# Radarr Integration

The optional Radarr adapter keeps two Radarr tags matched to SRTL storage policies, can update Radarr monitoring after copies, and can rescan titles when Radarr imports files. It works with any number of Radarr instances, for example one each for 1080p, 4K, anime, and remuxes. Tags describe **intended storage policy**, not proof of a successful copy. Copies remain manual, and existing transfer verification and rollback safeguards are unchanged. Sonarr has its own integration; see the [Sonarr guide](sonarr.md).

## Instances

**Settings > Integrations > Radarr** lists every connected Radarr instance with its status, the SRTL folders it maps, and when it last synced or what last failed. Select an instance to see its settings tabs. **Add instance** asks for a name, such as "Radarr 4K" or "Anime", and the pencil button renames one. Names must be unique.

Each instance has its own connection, API key, policy tag names, copy monitoring default, webhook URL and secret, mappings, preview, and activity. Instances run independently: an instance that is offline, slow, or failing shows its own error and never delays the others.

**Each SRTL folder belongs to one instance.** Saving a mapping to a folder another instance already maps is refused with a message naming that instance. Automatic mapping only takes folders that match the instance's own Radarr root folders and are free; roots that match a folder owned by another instance are listed separately and excluded. Remove a folder from one instance before mapping it to another.

Storage policies belong to a folder and a title, not to the title alone. When the same title exists in several folders, for example `movies` and `movies4k`, each folder's copy has its own policy, and each instance tags its movies from the policy of the folders it maps. So a 1080p instance can tag a title for Location 1 while a 4K instance tags the same title for Location 2. Assigning a policy in one folder never changes the other folder's copy, its tags, or its files.

Removing an instance asks for confirmation and deletes only SRTL's records for it: its connection, mappings, preview, and activity. Tags and monitoring in Radarr are never changed by removal, and its folders become free for another instance. SRTL supports up to 25 instances.

Upgrading from a version with a single Radarr connection turns that connection into the first instance, named "Radarr", with its API key, webhook secret, mappings, and synchronization state intact. Its original webhook URL keeps working.

## Connect

1. Open **Settings > Integrations > Radarr**, then add an instance or select one. Enter the Radarr URL and API key, then test the connection. Both the API and worker need network access to Radarr. Each integration has its own tab; Sonarr is set up the same way in its own tab.
2. Choose **Automatic** or **Manual** folder mapping. New connections default to Automatic: testing or saving matches full Radarr root paths against movie-type sections beneath SRTL's configured symlink directory. Unmatched roots are shown and excluded, never guessed from similar names. Use Manual when container paths differ; for example, Radarr's `/library/films` can map to SRTL's `films` section. Each root and section can be mapped only once, a section can belong to only one instance, and title-folder names must match exactly in either mode. Existing mappings remain Manual. Saving rechecks automatic matches; changed mappings require another policy review.
3. Choose the two policy tags, for example `local` and `ignored`. Each instance has its own tag names. They start empty: the placeholders are examples, not enabled defaults. Use distinct lowercase names; the UI labels the fields with your storage locations' friendly names. Missing tags are created in Radarr when first needed.
4. Optionally choose whether copies update Radarr monitoring by default (see below).
5. Use the instance's save button, for example **Save Radarr 4K settings**, to apply the configuration. The current status beside the heading reflects saved settings, not the draft toggle.

The URL and API key are enough to test or save a paused connection. Enabling requires both policy tags and at least one folder mapping. A webhook secret is optional and only needed to accept webhooks.

Settings are grouped into Connection, Folder mappings, Policy synchronization, Copy monitoring, and Webhooks. One save area per instance applies configuration changes across all sections. An unsaved-changes indicator remains until saving succeeds, on the tab and on the instance in the list; switching instances keeps each one's unsaved edits. Preview and policy actions always use the saved connection and tag settings.

## Policy Tags

While the integration is enabled, SRTL is the source of truth for the two policy tags:

- **Location 1 policy:** the Location 1 tag is added and the Location 2 tag is removed.
- **Location 2 policy:** the Location 2 tag is added and the Location 1 tag is removed.
- **Unassigned:** both policy tags are removed.

Only those two tags are ever added or removed. Other tags, quality profiles, file locations, and monitoring are left alone. A failed transfer does not erase the intended policy tag.

When synchronization is first enabled, or after the tags or mappings change:

- Titles with neither policy tag, or whose tag already matches SRTL, follow SRTL automatically.
- Titles where Radarr already carries the other policy tag show **Needs review** and are not changed until you decide.

Any policy you set in SRTL after that, including re-applying the same policy to a title in review, updates the title's tags. For reviewed titles you can also select them in the preview and choose:

- **Use SRTL policies:** let SRTL manage the tags using SRTL's current assignments.
- **Import existing tags:** assign a matching SRTL policy from one Radarr policy tag. Both tags, or a conflicting existing SRTL assignment, cannot be imported silently. The policy is imported for the folder the instance maps the movie to; the same title in another folder is not changed.

**Select all matching** selects every mapped title in the current filter, up to 1,000 at a time. Tag updates are batched, so large libraries converge within minutes. SRTL re-reads the Radarr catalog every 30 minutes, and on **Refresh preview**, so titles added out of band are picked up. If a managed title's policy tag is changed directly in Radarr, SRTL restores it to match the SRTL policy.

## Copy Monitoring

Copy buttons for mapped Movies sections show a **Unmonitor in Radarr** (copy to Location 1) or **Monitor in Radarr** (copy to Location 2) checkbox. Its starting value comes from **Update Radarr monitoring after copies by default** in the Copy monitoring tab of the instance that owns the section. Changing the checkbox affects only copies you start from that view.

While a copy with the option runs, SRTL updates each mapped movie as soon as all of its files are copied and verified, in the instance that owns its folder, so the rest of a long batch is not left monitored and open to Radarr upgrades. A movie counts as copied when every media file of it now points to the destination; SRTL then unmonitors it in Radarr (copied to Location 1) or monitors it again (copied to Location 2), usually within a few seconds while the next title copies. Each movie is updated at most once per copy and instance. When the copy ends, SRTL checks the whole selection again: it catches any movie that was not updated yet and lists movies with failed or skipped files as skipped, leaving their monitoring unchanged. A movie whose files finished copying is updated even if the job later fails on other titles or never finishes. Terminating a copy rolls its files back to the source, so SRTL puts monitoring back as it was for movies it had already changed and cancels changes still waiting to be sent. Copies that finished before an instance was added never change that instance's monitoring. Copies started without the option never change monitoring. Results appear under **Recent monitoring updates** and in the copy job's event history as each movie is updated.

## Re-Requesting After A Delete

When you delete a file from **Library > Damaged files** or an orphan review, you can tick **Also ask Radarr or Sonarr to search for a new copy**. It is off for every delete until you tick it. Before anything is deleted, the confirmation lists how many files can be re-requested, in which instance, and why the others cannot: for example a title that is not in Radarr, a folder no instance manages, or a spare file of a title that still has a linked copy.

SRTL only asks once the delete has happened. A file held for restoring counts as deleted. For each file, in the instance that owns its folder (a separate 4K instance gets its own titles):

1. SRTL reads the movie again and checks it is still the same one. It removes the movie's file record, but only when that record is the deleted file. If Radarr already has a different file, or a new copy is already linked, nothing is removed or searched.
2. It monitors the movie. This comes after the record is removed, because Radarr can be set to unmonitor a movie when its file goes. An unmonitor still waiting from an earlier copy is cancelled.
3. It sends a movie search, the same as pressing Search in Radarr.

Policy tags are not changed. The movie stays monitored, which is right for a title with no local copy; copying it to Location 1 again with **Unmonitor in Radarr** ticked unmonitors it as usual.

**Pacing.** Each instance is sent at most 6 searches a minute, a few seconds apart, and waiting items survive a restart. Lower or raise this with **Re-request searches per minute** in **Settings > Advanced**. An indexer with a small daily limit may need a lower rate.

**Results.** Damaged files and orphan reviews list recent re-requests, and each result also appears in the delete job's history. "Search sent" means the search started, not that a copy was found. If a request fails, the delete stands and the row shows why, with **Retry** for that row or for all failed rows. A failed request is not retried on its own.

Restoring a held file cancels a request that has not been sent, and puts back its symlink if nothing has taken its place. If the search was already sent, you may end up with two copies, and Radarr will not list the restored file until it rescans.

Deleting and re-requesting need the owner or admin role. Removing a failed copy's symlink and discarding a partial copy do not offer a re-request.

## Asking Radarr To Rescan After A Delete

When SRTL removes a library symlink, Radarr still lists the file until it rescans the movie's folder. Two deletes offer **Ask Radarr/Sonarr to rescan**, off until you tick it for that delete:

- **Remove failed-copy symlinks**, from the Failed list of a copy job's status window.
- **Library > Damaged files**, when at least one selected file is in the library.

Orphans have no library symlink, so Radarr never saw them and the orphan review does not offer it.

Once the symlinks are gone, SRTL finds each title's instance the same way a re-request does and queues **one `RescanMovie` per movie**, however many of its symlinks went. A rescan only reads the movie's folder: Radarr then shows the movie as missing, and it can be grabbed again. Rescans share each instance's re-request pacing (**Re-request searches per minute**), so a large cleanup is spread out.

The job's status window and history say how many rescans were asked and which titles were not, with the reason: a title not in Radarr, a folder no instance manages, or a paused instance. None of these fails the delete. Each rescan's result appears in the job's history and in the re-request list, marked **Rescan**; a rescan that failed or waited on a paused instance can be retried there once the instance is resumed.

If Radarr's **Unmonitor Deleted Movies** setting is on, the rescan can unmonitor the movie. A re-request keeps it monitored.

**With a re-request.** On Damaged files you can tick both. A title that also gets a re-request is not rescanned: a search alone does not make Radarr look at the disk, but a re-request first removes the deleted file's record from Radarr, which is what the rescan would have found, and then keeps the movie monitored.

## Configure Radarr Webhooks (Optional)

Webhooks let Radarr trigger title rescans after imports. Tag synchronization and copy monitoring do not need them. Each instance has its own webhook URL, `/api/integrations/radarr/<instance id>/webhook`, and its own secret. The original URL, `/api/integrations/radarr/webhook`, keeps working for an instance migrated from the single-connection settings.

The instance's Webhooks tab walks through these steps, with a **Copy** button next to everything you paste into Radarr. The steps are open until the instance has a saved secret, then collapsed under **Webhook setup**.

1. **In SRTL:** choose **Generate secret** (or enter your own: at least 24 characters using letters, numbers, hyphens, or underscores), copy it, then choose **Save settings**. Save first: Radarr's Test is rejected until SRTL has the secret.
2. **In Radarr:** open **Settings > Connect**, choose **+**, then **Webhook**. Name it `SRTL`.
3. Turn on exactly these triggers: **On File Import**, **On File Upgrade**, **On Rename**, **On Movie Added**, **On Movie Delete**, and **On Movie File Delete**. Leave all others off, including On Grab, On Health Issue, On Application Update, On Manual Interaction Required, and On Movie File Delete For Upgrade. SRTL rejects event types it doesn't handle, and On Movie File Delete For Upgrade only repeats On File Upgrade.
4. **Webhook URL:** paste the instance's URL. **Method:** POST. Leave **Username** and **Password** empty. If Radarr can't reach the address your browser uses, use SRTL's address as Radarr sees it, with the same path. Never put the secret in the URL.
5. **Headers** (choose **Show Advanced** if they're hidden): add a header with key `X-SRTL-Webhook-Secret` and your secret as the value.
6. Choose **Test**; it should pass. Then choose **Save**. If Test fails, check that the secret is saved in SRTL and the URL is reachable from Radarr.
7. To confirm it works: after the next import, the instance's **Activity** tab shows the webhook event and a title rescan job.

Generated secrets are 32 random bytes from the browser's cryptographic generator, shown as 43 URL-safe characters. SRTL stores only a hash, so a generated secret stays on screen, including after you save, only until you leave the page; copy it into Radarr before then. A generated secret counts as an unsaved change until you save. If the instance already has a secret, saving a new one replaces it, and Radarr must be updated with the new value. Saved secrets are never returned to the browser; blank fields preserve them.

Radarr often sends several notifications for one movie in a short time, so SRTL waits until a movie has had no new notification for 10 seconds (and never longer than 60 seconds after its first pending one) and then handles all of its pending notifications together, queuing a single rescan that every notification in the Activity tab links to. Import and upgrade notifications still wait until the expected symlink exists (the whole batch for that movie waits with them), then queue an ordinary title-rescan job. A MovieAdded notification only updates the catalog and policy tracking: no rescan is queued while the movie folder holds no media symlinks, since the import notification that follows does the real rescan. If the folder already holds media (for example a movie added with an existing file), the notification queues a rescan. The entire mapped title folder is scanned, not the entire section. Duplicate deliveries are suppressed per instance, each instance's webhook URL has its own rate limit, and overlapping work waits behind existing jobs. Webhook payload paths are never trusted as filesystem instructions: movie identity and paths are re-read from Radarr. New titles discovered through webhooks follow the same policy-tag rules as other titles.

## Status And Recovery

Policy synchronization, monitoring updates, and webhook activity appear per instance in Settings > Integrations. Scan jobs also appear in Recent Jobs and have the usual progress and event history. Pending notifications, tag updates, and monitoring updates survive restarts. Transient failures retry with backoff, up to five minutes between attempts; they do not turn a successful copy into a failed copy. Unmapped notifications are ignored with a recorded reason. Processed webhook and monitoring records are retained for 30 days, with the newest 100 of each displayed.

Pausing an instance stops its tag updates, monitoring updates, and webhook processing, not scan jobs already queued. Other instances keep running. Changing the Radarr address or mappings requires another policy review. Changing the address also clears that connection's cached preview, webhook activity, and monitoring activity; job history remains.

## Security

Use a trusted private network or HTTPS with valid certificates. Local HTTP endpoints are supported deliberately; HTTP does not encrypt API keys or webhook secrets. Redirects, credential-bearing URLs, and link-local/metadata destinations are rejected. Each webhook secret only authorizes its own instance's webhook endpoint; settings still require an administrator session. The API key is stored in Postgres and must be protected along with database backups; the webhook secret is stored as a one-way hash. No additional environment variables, containers, or public ports are required.

Radarr's [webhook implementation](https://github.com/Radarr/Radarr/tree/develop/src/NzbDrone.Core/Notifications/Webhook) defines the supported notification payloads and custom headers.
