# Default Policy For New Titles

Titles that arrive after the library was set up, for example ones requested through Seerr and imported by Radarr or Sonarr, start **unassigned**: no policy, no Radarr tag, and no copy until someone acts. A folder can instead give its new titles a default storage policy.

## Set A Default

Open **Settings > Library > Default policy for new titles**, choose **None**, **Location 1**, or **Location 2** for a folder, and save. **None** is the default and keeps today's behavior. The choices use your location names.

## When It Applies

- Policies are per folder, so defaults are too. A title gets a folder's default the first time a symlink scan or a title rescan (including one started by a Radarr webhook) records it **in that folder**. It counts as new to a folder when no link with its name has ever been recorded there.
- It applies only to folder copies that have **no policy**. An existing policy, manual or imported, is never changed.
- It is **not retroactive**. Titles already in the library when you turn a default on stay as they are.
- A title found in several folders gets each folder's own default, for example Location 1 in `movies` and Location 2 in `movies4k`. A folder without a default leaves its copy unassigned.
- The policy is recorded with source `default`, and the scan's job events list how many titles received it.

## Apply To Unassigned Titles Now

For a folder with a saved default, **Apply to unassigned titles now** assigns the default to titles in that folder that have no policy. It shows how many titles it will change and asks for confirmation first. Titles that already have a policy and titles in other folders are not touched.

## Copies And Radarr

- A default only assigns a policy. **No copy starts automatically.** Titles assigned Location 1 whose files are on Location 2 appear as **Copy to Location 1** candidates; you start the copy.
- A default assignment is a normal policy change, so a managed Radarr movie receives its policy tag exactly as after a manual assignment.
- If the Radarr instance that maps the folder already carries the **opposite** policy tag on a new movie, the default leaves that folder's copy unassigned so it stays in the Radarr review list instead of being overwritten. **Apply to unassigned titles now** reports how many titles it left for review.
