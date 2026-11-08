# Orphan review and purge

An orphan is a media file on a storage location with no library symlink pointing to it. **Library > Local orphans** and **Library > Remote orphans** list them for review, and you choose what to purge. Files changed in the last 24 hours or involved in an unfinished copy are protected. They are not listed; the header only counts them.

Video files, folders with no video and the holding area each have their own tab. Selecting anything brings up a bar at the bottom of the screen with the count and size, the choice between **Hold 7 days** and **Delete now**, the option to ask Radarr or Sonarr for a new copy, and **Purge selected**, which asks once more before anything happens. **Purge all eligible** in the header purges everything that can be purged, behind its own confirmation. Hold is the default on local storage. Remote storage cannot move files into the holding area, so Hold is turned off there and every purge deletes immediately. If a purge job fails or partly fails, a red banner shows its first error and links to the job until you dismiss it.

## Reading the labels

| Label | What it means |
| --- | --- |
| Other versions of linked titles | Another file of the same movie or episode is linked. Check the size against the linked file before deleting. |
| Copy leftovers | SRTL already copied this file to the other storage location. |
| Not in library | No symlink exists for this title or episode anymore. |
| SRTL leftovers | Temporary, kept, or backup files that SRTL created. |
| Title is in the library, episode is not linked | The release name looks like a title in the library, but no link for that title holds this episode. |
| Title is in the library | No symlink points to this file, but its release name looks like a title in the library. |
| No title match | No symlink points to this file, and its release name does not look like a title in the library. The title may still be in the library under another name, so review before deleting. |

**The last three are a name comparison and can be wrong.** SRTL compares the name of the folder the file arrived in, then the file's own name, with the library's title folders. The whole title has to match, never just part of it. When both sides have a year, the years must be within one of each other. A title with fewer than two meaningful words, such as `Lamp` or `The Lamp`, also needs a matching year, unless the release has a season tag and the title is in a shows folder. A release with a season tag never matches a title in a movies folder. Titles can share a name, and unusual release names are missed.

A library title also matches a release that leaves out its `&`, the dots in its initials (`E.R.` and `Er`), or its country tag (`Show (US)` and `Show`), and a release that replaced an apostrophe with a separator (`Sam_s`). If the release names a different country, it does not match. When several titles could be the release, the name as written is shown first.

**Not linked does not mean missing.** A file lands under **episode is not linked** when none of the titles it could be has a link holding that episode. A title that numbers its seasons differently lands here too, so compare before deleting.

The API keeps reporting these files with the `unlinked` category; the split is in the `label` field. None of these labels changes what can be purged.

Filters can narrow the list further:

- **Release**: whether no file in the release is linked, or the release is partly linked, such as a season pack with some episodes in use. A release is the folder a file arrived in, counting season and disc folders as part of the folder above them.
- **Size against the linked file**: an older or duplicate copy is usually smaller, so a file flagged as larger deserves a look. A larger file is not always a better one: it can just be a less efficient encode.

A multi-episode file such as `S01E01E02` only counts as another version when every episode it holds has a linked file. If only some do, it stays under **Not in library** with a note, because deleting it would lose the only copy of the others.

## When a purge is refused

The list is only as good as the symlink inventory, so a purge needs a **complete symlink scan of every library folder that started in the last 24 hours**. Rescans of single titles, scans that failed or were cancelled, and storage-only scans do not count. A folder with nothing in it, or none on disk, does not need a scan. The daily scheduled scan covers this; otherwise the warning names the folders to scan.

Every file is checked again right before it is touched. See [the README](../README.md) for the holding area.

## Symlinks kept by other tools

SRTL only scans its own symlink folder. If another tool, such as a download client, keeps its own folder of symlinks pointing at files on your storage, SRTL cannot see those links and would list their targets as orphans. Name those folders so they are checked too:

1. In `.env`, list the folders, comma separated:

   ```bash
   SRTL_EXTRA_SYMLINK_DIRS=/path/to/other-tool/symlinks
   ```

2. Mount each one read-only into **both** the `api` and `worker` containers, at the same path, using a `docker-compose.override.yml` next to `docker-compose.yml`. Compose reads it automatically, and it is not replaced when you download a new `docker-compose.yml`.

   ```yaml
   services:
     api:
       volumes:
         - type: bind
           source: /path/to/other-tool/symlinks
           target: /path/to/other-tool/symlinks
           read_only: true
     worker:
       volumes:
         - type: bind
           source: /path/to/other-tool/symlinks
           target: /path/to/other-tool/symlinks
           read_only: true
   ```

3. Run `docker compose up -d` so both containers pick up the change.

With that in place:

- Files a link points to, or that sit under a folder a link points to, are left out of the review and only counted. They are refused if a purge asks for them. Folders with no video get the same protection.
- The folders are read again right before each file or folder is touched, so a link made after the purge was queued still stops it. Each purge step walks the whole of every folder, so very large folders slow large purges down.
- SRTL only ever reads these folders. A folder cannot be, or contain, a symlink or storage root, or sit inside a storage root or a library folder, because SRTL changes files there.
- If a folder is missing, unreadable, or empty, as an unmounted folder usually is, purging is refused and the review says why, rather than treating it as having no links. If a folder is meant to be empty, remove it from the setting.

A link only protects a file if it uses the same path SRTL sees. If the other tool's container sees storage under a different path, its links will not match, and the review warns how many links point outside both storage locations. Links pointing to another symlink are followed. Deleting from **Library > Damaged files** does not check these folders.

With `SRTL_EXTRA_SYMLINK_DIRS` unset, nothing changes and no override is needed. When running outside Docker, set the same variable in the environment or in `.env`.
