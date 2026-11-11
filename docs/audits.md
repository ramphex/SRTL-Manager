# Audits

An audit reads media files and checks that they play. It is a read-only job: it never moves, repoints or deletes anything. Results are listed under **History > Audits**, and a file whose last audit failed is listed on **Library > Damaged files**.

## Fast And Deep

- **Fast** reads every byte of the file and its streams without decoding them (a demux with stream copy). It runs at disk speed for local files and at download speed for remote files.
- **Deep** decodes every frame in software. It catches more, but it is CPU bound: on a modest shared server a single film can take as long as watching it.

Before an audit starts, the audit window shows how many files it covers, their total size, and a rough time for a fast and a deep audit. When remote files are included, it says how much would be read through the remote mount.

## Byte Compare

When a file was copied by SRTL, its copy source is recorded. Byte compare reads that source again and compares it byte for byte with the file. It is **off by default** for audits, because:

- copies already byte-compare every file when they are made, and
- the source of a local copy is usually on the remote mount, so byte compare downloads it again.

**Settings > Advanced > Audit defaults > Byte compare when source is known** sets where the checkbox in the audit window starts. Each audit can still turn it on for that run. Copy verification is set separately and is not affected.

Upgrading to this version turns a saved **on** into **off** (database migration 34). Earlier versions saved the whole audit block whenever any advanced setting was saved, and byte compare was on by default, so a saved **on** cannot be told apart from never having touched it. A saved **off** was a choice and is kept. Turn it back on if you want it.

## What Can Be Audited

Audits are started from:

- **Dashboard > Audits**, for chosen local folders (fast only),
- a title in the library or on **Storage Policies**,
- a folder, a path or a selection of files in the library,
- **Library > Damaged files**, for one file or a selection, including files no symlink points at.

Two kinds of audit are refused when they are not limited to a title, a folder, a path or a selection:

- **Library-wide remote audits.** An audit reads every byte, so a remote audit downloads every remote file through the remote mount. For a large remote library that is many terabytes from the provider.
- **Library-wide deep audits.** Decoding a whole library in software would keep the CPU busy for weeks or months, next to the media server.

The API refuses both with the same reason the window shows (`400`). Remote and deep audits of a title, a folder, a path or a selection work as before.

## Nightly Audit Of Local Files

**Settings > Advanced > Audit defaults > Audit local files every night** runs a fast audit of local files in a nightly window. It is **off by default**.

- **Starts at** is an hour in server time (01:00 by default) and **window** is its length in hours (4 by default, up to 12).
- It reads local files only, in fast mode, without byte compare.
- Files that were never audited go first, then the files checked longest ago. Each result is saved on the file as it goes.
- At the end of the window it stops, abandoning a file still being read, and the next night carries on from where it stopped. A file that changed since its last audit counts as never audited.
- It gives way to work someone starts: another audit, a full scan, or a local storage scan. It stops early, and is queued again in the same window once that work is done. A local storage scan that is already running makes it wait.
- Files that are part of an unfinished copy, and files that disappeared since the last scan, are left for another night.

Below the setting, a line shows how much of the local library audits checked in the last 30 days, how many files were never audited, and how many nights a full pass takes at the current window. It uses the speed of recent nightly runs, or a typical disk speed before the first one.

Each nightly run is listed under **History > Audits** as **Nightly**, with how much it read and why it stopped. Only failures are kept as audit result rows; passes are recorded on the file.

## Damaged Files

**Library > Damaged files** lists local files that:

- are **hollow** or **damaged** by scan sampling, or
- **failed their last audit**, manual or nightly.

A failed audit stays listed until a later audit of the file passes or a scan sees its contents change. The **Last audit** column shows the mode, result and time; hover for the reason. **Audit** on a row, or **Audit selected**, opens the audit window for just those files, where a deep audit gives the clearest verdict. Failed files can be deleted and re-requested like other damaged files.
