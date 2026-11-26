# Now Playing

**Now Playing** (in the main navigation) shows what is streaming right now on every Plex, Jellyfin, and Dupelix server connected in [Settings > Media servers](media-servers.md), together with the load on the SRTL host. It is live only: nothing is written to the database and there is no history. Without a connected server, the page links to Settings > Media servers.

## Quick glance

A strip pinned to the top of the page stays visible while you scroll through the streams.

- **Pills**: hardware transcodes, CPU transcodes, direct streams, direct plays, paused streams, and the total streaming bandwidth. Paused streams are counted in their pill but not in the bandwidth. When a Jellyfin stream transcodes video, a separate "engine not reported" pill counts it, because Jellyfin does not say whether that stream runs on the GPU.
- **CPU** and **RAM** of the SRTL host, each with a sparkline of the last five minutes. When a Plex server reports its own resource use (Plex Pass), the CPU card also shows Plex's figure.
- **Network**: total traffic in and out of the host across its physical interfaces. Loopback, Docker, veth, bridge, VM, tunnel, and VPN interfaces are left out, as are VLAN interfaces whose parent is already counted. Next to it, Plex's own LAN and WAN streaming rates from its bandwidth statistics (Plex Pass), averaged over the last 30 seconds. SRTL does not split host traffic into LAN and WAN.
- **GPU** (only when `nvidia-smi` works): utilization, encoder and decoder load, memory, and the number of encoder sessions, with a sparkline of the busiest engine.

Sparkline history is kept in memory while someone has the page open and is lost when everyone leaves or SRTL restarts.

## Servers

Below the strip, each connected server is a toggle with its type icon (Plex, Jellyfin, or Dupelix) and its connection status. All servers are on by default. Turning one off hides its streams and leaves them out of the pills; the host cards are never filtered. The choice is saved with your account, so it follows you to other browsers, and a server added later starts on. With every server off, the page says "No servers selected".

## Stream cards

Each stream shows the title (show, season, and episode for TV), the poster, the player, device, and platform, the SRTL source, and the position and whether it is playing, paused, or buffering.

Below that, the stream's technical details are folded into one line: the play method, the bandwidth, and the quality, such as **Transcode (HW)** `10.5 Mbps · 4K → 1080p`. Quality is a resolution label (4K, 1440p, 1080p, 720p, or SD for anything smaller); the arrow appears when a transcode changes it. The chevron next to the line shows the full details below and hides the line; it works with the keyboard too. Each card remembers whether it is expanded until the browser tab is closed, and new cards start folded.

The bottom row of each card shows the **user**, the **server** with its type icon, and the **location**: LAN or WAN, and the place from plex.tv when the lookup is on: "City, State" for a client in the United States (such as "Austin, Texas") and "City, Country" for everyone else. When a part is unknown it is left out, down to just the state and country, or the country alone. The client address is not printed on the card; hover over, focus, or tap the location to see it.

In detail:

- **Play method**:
  - Plex: any transcoded stream makes it a transcode; otherwise any copied stream makes it a direct stream; otherwise it is a direct play. A transcode that converts only the audio is still a transcode, and it always runs on the CPU. A video transcode counts as hardware when Plex reports a hardware encoder.
  - Jellyfin: the server's play method, refined by whether video and audio are copied. A "transcode" that copies both is a remux, shown as a direct stream.
  - Dupelix: each track's own decision when Dupelix reports it (any converted track makes a transcode, any copied one a direct stream), otherwise the session's route. A direct play or a stored version sent as it is is a direct play, a direct stream (new container, video untouched) is a direct stream, and a transcode is a transcode. A stream that converts only the audio counts as a transcode, as on Plex. A video transcode counts as hardware when Dupelix says its encoder is a hardware one, or names one (NVENC, Quick Sync, VAAPI, VideoToolbox and the like), and as CPU for a software one. Dupelix also reports a hardware decode, HDR tone mapping, the encoder speed, and whether the encoder is throttled.
- **Source and output**: codec, resolution, and HDR format of the original file and of what the player receives, subtitles (and whether they are burned in), and the container.
- **Why it transcodes**: Jellyfin reports its reasons. Plex does not, so SRTL derives them from the source and output streams and labels them "derived". Plex streams also show the transcoder speed and whether it is throttled.
- **Bandwidth**: Plex's reserved bandwidth for the stream, or an estimate from the bitrate (labelled). Placeholder values such as 2,147,483,647 are shown as unknown.
- **LAN or WAN** and the client address, in the bottom row (the address in the location's tooltip). Behind a reverse proxy, Jellyfin reports the proxy's address unless Jellyfin's known proxies are configured.
- **SRTL source**: whether the file plays from local storage (Location 1) or remote storage (Location 2), using the location names from Settings. SRTL maps the server's file path through the server's path prefix mappings to its symlink, then reads its own link and storage records. If a card says "Source unknown" or "Not in SRTL", check the mappings in Settings > Media servers. Nothing is read from disk; each file is looked up once and cached.

Posters load through SRTL, so Plex tokens and Jellyfin and Dupelix API keys never reach the browser. For Dupelix, SRTL reads the title's signed artwork links with the API key, keeps the chosen link for at most six hours (the links last a week or more), and fetches the picture with the signed link alone. Only Dupelix artwork paths are fetched this way.

## Stopping a stream

Owners and admins can stop a stream; moderators can only watch this page. The red X at the top right of a card (**Terminate the stream**) asks for confirmation with an editable message, sends it, and then checks whether the server still lists the stream. If it does, the dialog says so: some players ignore the request.

- **Plex**: needs an active Plex Pass on the account SRTL signed in with (the server owner). SRTL checks the subscription at plex.tv and caches the answer for a day (half an hour when inactive). Without Plex Pass, Stop is hidden on Plex streams and the server line says "Stop needs Plex Pass". Players that report no session id, such as Plexamp, cannot be stopped.
- **Jellyfin**: available when the client accepts remote control. SRTL sends the message (many clients ignore it) and then the stop command.
- **Dupelix**: available when Dupelix says the stream can be stopped and the API key has the `activity.stop` scope. SRTL sends the message (up to 200 characters; apps may not show it) and Dupelix ends playback; the device stays signed in. Without the scope, the card's Stop is hidden; on a Dupelix server too old to stop streams, too.

## Locations of client addresses

When **Look up the location of public client addresses with plex.tv** is on (the default, at the bottom of the page), SRTL asks plex.tv where each public client address is, using the token of a connected Plex server. Private, loopback, link-local, and CGNAT (100.64.0.0/10) addresses are never sent. Each answer is cached in memory for a day (failures for ten minutes) and lookups never delay updates. Without a signed-in Plex server, no lookups happen.

## How updates arrive

Upstream connections run only while at least one browser has Now Playing open, and stop about 15 seconds after the last one leaves.

- SRTL listens to Plex's notification socket and Jellyfin's session socket for changes and polls each server every 30 seconds as a safety net. When a socket cannot be opened, it polls every 5 seconds and tries the socket again later. Dupelix has no socket, so it is always polled every 5 seconds, and that is not an error. The server line shows **Live** or **Polling**.
- After three failed requests in a row a server is marked **Unreachable**, its streams are cleared, and polling backs off up to two minutes. A rejected token shows "Plex token invalid — sign in again in Settings > Media servers" (or the Jellyfin or Dupelix equivalent; for Dupelix the message names the scopes the key needs).
- The browser receives updates over server-sent events from `/api/now-playing/events`. Every route requires the normal admin sign-in.

## Docker: host network totals

Inside a container, SRTL only sees the container's own network interfaces, and the card is labelled **container traffic only**. To show the host's totals, mount the host's `/proc` read-only into the API container:

```yaml
  api:
    volumes:
      - /proc:/host/proc:ro
```

SRTL then reads `/host/proc/1/net/dev` (the host's network namespace). No extra privileges are needed. If the host mounts `/proc` with `hidepid`, the file is not readable by SRTL's user and the card falls back to container traffic. Bonded interfaces count both the bond and its members; the figure is then doubled.

## Docker: NVIDIA GPU card

The GPU card appears when `nvidia-smi` runs inside the API container. With the NVIDIA Container Toolkit installed on the host, give the API container the `utility` capability, which provides `nvidia-smi` and NVML:

```yaml
  api:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [utility]
```

or, with the older runtime setting, `runtime: nvidia` plus the environment variables `NVIDIA_VISIBLE_DEVICES=all` and `NVIDIA_DRIVER_CAPABILITIES=utility`. SRTL never transcodes, so it does not need the `video` or `compute` capabilities. `nvidia-smi` runs once per sample (every 3 seconds) with a 2.5-second timeout, only while the page is open. When it is missing or fails, the card is hidden and SRTL checks again ten minutes later.

The GPU figures cover the whole GPU, so they include Plex, Jellyfin, and anything else using it.

## Credits

The server type icons are the Plex and Jellyfin glyphs from [Simple Icons](https://simpleicons.org) (CC0). Plex and Jellyfin names and logos are trademarks of their respective owners, used only to identify the server type.

## Dupelix

What a Dupelix card shows depends on what the Dupelix server reports. Current servers send the pause and buffering state, duration, show, season and episode, poster, source and output media, per-track decisions, hardware use, encoder speed, how far ahead the stream is prepared, throughput, and the network. Older ones send only the user, device, title, route, encoder, output height, and position, and their cards leave the rest out instead of guessing.

- **Client address, location, and LAN or WAN** need the `activity.network` scope on the key, or the location is left out. Without the address, LAN or WAN still shows when Dupelix says whether the client is local.
- **SRTL source**: Dupelix never reports file paths, so Dupelix cards show no local or remote storage badge.
- **Stop** needs the `activity.stop` scope, as above.
- **Guest profiles** appear only with the `activity.guests` scope.

SRTL reads each detail as soon as Dupelix sends it.
