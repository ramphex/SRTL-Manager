# Reverse proxy and internet exposure

SRTL Manager is built for a trusted network. If you want to reach it from outside your LAN, put it behind a reverse proxy that terminates HTTPS, and add a second sign-in in front of it. This guide covers Nginx Proxy Manager (NPM) in detail, an Authentik forward-auth setup, and short Caddy and Traefik equivalents. Finish the [checklist](#before-exposing-to-the-internet) before you publish anything.

All names and addresses here are examples. Replace them with your own:

| Example | Meaning |
|---|---|
| `srtl.example.com` | The public name of SRTL |
| `auth.example.com` | Your Authentik address |
| `192.168.1.x` / `192.168.1.0/24` | Your LAN |
| `192.168.1.10` | The machine running the proxy |
| `192.168.1.20` | The machine running SRTL |
| `203.0.113.x` | Addresses on the internet |

## What SRTL needs from the proxy

SRTL reads three things from the connection, so the proxy and SRTL must agree on them.

**`SRTL_PUBLIC_ORIGIN`** is the address people type, for example `https://srtl.example.com`. SRTL then accepts changes (saving settings, starting a copy) only from that origin and any listed in `SRTL_ALLOWED_ORIGINS`, and an `https` origin turns on secure session cookies. Set it in `.env`:

```
SRTL_PUBLIC_ORIGIN=https://srtl.example.com
```

If you also open SRTL by its LAN address, add that origin to `SRTL_ALLOWED_ORIGINS`, for example `http://192.168.1.20:5179`. Browsers refuse `Secure` cookies over plain HTTP, so sign-ins at a listed `http` address use a plain session cookie while the public address keeps its secure one. Leave it empty otherwise.

**`SRTL_TRUST_PROXY`** lists the proxies whose `X-Forwarded-For` and `X-Forwarded-Proto` headers SRTL believes. Those headers decide the client address used for sign-in and request rate limits and for the log, and whether the request counts as HTTPS. Set it to the proxy's address or range, never to `true` (SRTL refuses that value):

```
# NPM on another machine
SRTL_TRUST_PROXY=192.168.1.10
# NPM or Caddy on the same host as SRTL
SRTL_TRUST_PROXY=loopback
# NPM in a container on a shared Docker network (use your network's subnet)
SRTL_TRUST_PROXY=172.18.0.0/16
```

If it is too wide, anyone who can reach SRTL directly can pretend to be any address. If it is wrong or empty, every client looks like the proxy, so one person's failed sign-ins lock out everyone.

**The published port.** Only the proxy should be able to reach SRTL. Either set `SRTL_BIND_HOST=127.0.0.1` when the proxy runs on the same host, or remove the `ports` block from `docker-compose.yml` and put SRTL and the proxy on a shared Docker network (the commented `proxy` network in the compose file shows how), then forward to `http://api:3010`. Do not leave `SRTL_BIND_HOST=0.0.0.0` when the proxy is the intended entrance, because the LAN could then bypass it.

Run the production image only (`docker compose up`). Never point a proxy at `npm run dev`, a Vite server, or `tsx watch`.

## Nginx Proxy Manager

### 1. Proxy host

Open **Hosts > Proxy Hosts > Add Proxy Host**.

**Details tab**

- **Domain Names:** `srtl.example.com`
- **Scheme:** `http`
- **Forward Hostname / IP:** `192.168.1.20` (or `api` on a shared Docker network)
- **Forward Port:** `5179` (your `SRTL_WEB_PORT`), or `3010` on a shared Docker network
- **Block Common Exploits:** on
- **Websockets Support:** optional. Now Playing uses server-sent events, not WebSockets, so SRTL does not need it. Leaving it on does no harm.
- **Cache Assets:** off. SRTL sets its own cache headers.
- **Access List:** leave empty unless you use one for the whole host (see [Webhooks](#4-keep-webhooks-on-the-lan)).

**SSL tab**

- **SSL Certificate:** request a Let's Encrypt certificate for `srtl.example.com`.
- **Force SSL:** on.
- **HTTP/2 Support:** on.
- **HSTS Enabled:** off. SRTL already sends `Strict-Transport-Security` (one year, without `includeSubDomains`), and two copies of the header only confuse browsers. If you turn it on here instead, keep **HSTS Subdomains** off unless all of your subdomains serve HTTPS.

### 2. Advanced tab

Paste this into **Advanced > Custom Nginx Configuration**. It sets the upload size, the Now Playing stream, and the paths that must not be public. The two `location` blocks that use `include conf.d/include/proxy.conf;` rely on NPM's stock proxy headers and on the `$forward_scheme`, `$server` and `$port` values NPM defines from the Details tab.

```nginx
# Largest request: restoring a watch sync backup (64 MB). Lower it if you only restore from the LAN.
client_max_body_size 70m;

# Now Playing streams over server-sent events. SRTL sends a heartbeat every 20 seconds.
location = /api/now-playing/events {
    proxy_pass $forward_scheme://$server:$port;
    include conf.d/include/proxy.conf;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    gzip off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
}

# Worker detail is for local health checks only. Keep /api/health/live public for uptime monitors.
location ~ ^/api/health(/ready)?$ {
    return 404;
}

# Never serve the API documentation from the internet.
location ^~ /documentation {
    return 404;
}
```

What each part does:

- **`client_max_body_size 70m`** is the proxy's own ceiling. nginx defaults to 1 MB, which would break watch sync restores and very large copy or purge selections (SRTL accepts up to 4 MB for those, and 64 MB for a restore). SRTL enforces its own smaller limits on everything else.
- **The event stream** needs buffering off and a long read timeout. Without them the page shows "reconnecting" every minute, because nginx closes an idle upstream after 60 seconds by default and buffers small events until they pile up. SRTL already sends `X-Accel-Buffering: no`, so buffering is usually off anyway; the block also sets the timeout and turns off gzip.
- **`/api/health` and `/api/health/ready`** show worker state. SRTL already refuses them unless the request is a direct local one or comes from a signed-in account, and blocking them at the proxy adds a second layer. `/api/health/live` is left alone: it returns only that the service is running. Docker's own health check talks to the container directly and is not affected.
- **`/documentation`** is the OpenAPI page. It is off unless `SRTL_API_DOCS=true`; the block makes sure it stays off the internet even if someone turns it on.

### 3. Optional: an edge limit on sign-in

SRTL limits sign-in attempts itself. To add a limit at the proxy as well, create `/data/nginx/custom/http_top.conf` in NPM's data volume with:

```nginx
limit_req_zone $binary_remote_addr zone=srtl_auth:10m rate=10r/m;
```

and add this block in the Advanced tab:

```nginx
location ^~ /api/auth/ {
    limit_req zone=srtl_auth burst=5 nodelay;
    proxy_pass $forward_scheme://$server:$port;
    include conf.d/include/proxy.conf;
}
```

### 4. Keep webhooks on the LAN

Radarr and Sonarr call SRTL from inside your network, so the webhook paths should never answer the internet. The paths are:

```
/api/integrations/radarr/webhook
/api/integrations/radarr/<instance id>/webhook
/api/integrations/sonarr/<instance id>/webhook
```

SRTL still demands the per-instance secret on these paths. Restricting the source address is a second lock.

**Option A: allow only the LAN in the same host.** Add this to the Advanced tab:

```nginx
location ~ ^/api/integrations/(radarr|sonarr)/ {
    allow 192.168.1.0/24;
    deny all;
    client_max_body_size 512k;
    proxy_pass $forward_scheme://$server:$port;
    include conf.d/include/proxy.conf;
}
```

Point Radarr and Sonarr at `https://srtl.example.com/api/integrations/...` as usual, or at SRTL's LAN address.

**Option B: a separate host with an NPM access list.** Use this if you prefer to manage the allowed addresses in the NPM interface.

1. **Access Lists > Add Access List.** Name it `lan-only`. Leave **Satisfy Any** off and **Pass Auth to Host** off. Under **Rules** add `allow 192.168.1.0/24`, which also denies everything else.
2. Add a second proxy host, for example `srtl-hooks.example.com`, that forwards to SRTL like the main one, with **Access List** set to `lan-only`. Give it a certificate if you want HTTPS inside your network, or use an internal-only name.
3. In its Advanced tab, answer every path except the webhook paths with 404, and cap the body size:

   ```nginx
   client_max_body_size 512k;
   location ~ ^/(?!api/integrations/(radarr|sonarr)/) { return 404; }
   ```

4. Point Radarr and Sonarr at `srtl-hooks.example.com`, and on the main host add `location ~ ^/api/integrations/ { return 404; }`.

Do not put Authentik in front of the webhook host or paths: Radarr and Sonarr cannot sign in through a browser.

## Authentik forward auth

Forward auth makes the proxy ask Authentik before it lets any request reach SRTL. People sign in to Authentik first (with your usual MFA and policies) and then to SRTL itself. It needs no change in SRTL. Nothing about the Authentik user is passed to SRTL, so the SRTL login stays as it is.

### In Authentik

1. **Applications > Providers > Create > Proxy Provider.**
   - **Name:** `SRTL Manager`
   - **Authorization flow:** your explicit or implicit consent flow
   - **Mode:** **Forward auth (single application)**
   - **External host:** `https://srtl.example.com`
2. **Applications > Applications > Create.** Name it `SRTL Manager`, choose the provider above, and restrict access to a group such as `srtl-admins` with a policy binding. Only members of that group can reach the SRTL host.
3. **Applications > Outposts.** Edit the **authentik Embedded Outpost** and add the application to it. A standalone outpost works the same way; use its address wherever the next section says "outpost".

The embedded outpost is served by the Authentik server itself, on port 9000 inside its Docker network. Your NPM must be able to reach `http://authentik-server:9000` (a shared Docker network) or Authentik's LAN address and port.

### In NPM

NPM writes its own `location /` for the proxy host, so put the sign-in check at server level in the **Advanced** tab instead of redefining `location /`. Add this above the Advanced settings from the previous section. Replace `authentik-server:9000` with how NPM reaches the outpost.

```nginx
# Larger headers: Authentik's cookie can be big.
proxy_buffers 8 16k;
proxy_buffer_size 32k;
port_in_redirect off;

# Ask the outpost before serving anything.
auth_request        /outpost.goauthentik.io/auth/nginx;
error_page          401 = @goauthentik_proxy_signin;
auth_request_set    $auth_cookie $upstream_http_set_cookie;
add_header          Set-Cookie $auth_cookie;

# The outpost itself must be reachable without signing in.
location /outpost.goauthentik.io {
    auth_request            off;
    proxy_pass              http://authentik-server:9000/outpost.goauthentik.io;
    proxy_set_header        Host $host;
    proxy_set_header        X-Original-URL $scheme://$http_host$request_uri;
    add_header              Set-Cookie $auth_cookie;
    auth_request_set        $auth_cookie $upstream_http_set_cookie;
    proxy_pass_request_body off;
    proxy_set_header        Content-Length "";
}

# A 401 from the outpost sends the browser to Authentik.
location @goauthentik_proxy_signin {
    internal;
    add_header Set-Cookie $auth_cookie;
    return 302 /outpost.goauthentik.io/start?rd=$scheme://$http_host$request_uri;
}
```

If the NPM version you run rejects server-level `auth_request`, create a custom location for path `/` on the Details tab instead, forward it to SRTL, and put the four `auth_request`, `error_page`, `auth_request_set` and `add_header` lines in that location's gear menu.

### Bypass rules

Some paths must not go through Authentik. Add `auth_request off;` to each of these locations, in the same Advanced tab.

```nginx
# Radarr and Sonarr webhooks come from the LAN and cannot sign in through a browser.
# Keep the source restriction from the webhook section; add auth_request off to it.
location ~ ^/api/integrations/(radarr|sonarr)/ {
    auth_request off;
    allow 192.168.1.0/24;
    deny all;
    client_max_body_size 512k;
    proxy_pass $forward_scheme://$server:$port;
    include conf.d/include/proxy.conf;
}

# App files the browser fetches without your sign-in cookie: installing the web app
# and updating its service worker would otherwise be redirected to Authentik.
location ~ ^/(manifest\.webmanifest|service-worker\.js|base\.css|theme-init\.js|icons/|assets/) {
    auth_request off;
    proxy_pass $forward_scheme://$server:$port;
    include conf.d/include/proxy.conf;
}
```

These files contain no data. If you skip this second block, sign-in still works but the home-screen install and app updates may fail with an Authentik redirect.

**The future `/join` page.** SRTL does not ship a public invite page yet. When it does, serve it from its own hostname such as `join.example.com`, as its own proxy host with its own certificate and **no** Authentik, and forward only `/join` and `/api/join` to SRTL. A separate hostname also keeps the admin session cookie from ever being sent to it. If you must share the host, add a `location ^~ /join` and a `location ^~ /api/join` with `auth_request off;`, and nothing else.

### Behaviour to expect

- When your Authentik session expires, the open Now Playing stream's reconnect receives a redirect and stops. Reload the page to sign in again.
- Sign-out in SRTL signs you out of SRTL only. Sign out of Authentik separately.
- Keep SRTL's own password strong and unique even with Authentik in front. It is the second lock, and it is what protects SRTL from anything on your LAN that reaches it directly.

## Caddy

A single site block covers the same ground. Caddy gets HTTPS certificates on its own.

```caddyfile
srtl.example.com {
    # Matchers
    @private path /api/health /api/health/ready /documentation /documentation/*
    @webhooks_lan {
        path /api/integrations/*
        remote_ip 192.168.1.0/24
    }
    @webhooks_other path /api/integrations/*
    @protected not path /manifest.webmanifest /service-worker.js /base.css /theme-init.js /icons/* /assets/*

    request_body {
        max_size 70MB
    }

    # route keeps these in the order written.
    route {
        respond @private 404
        # Webhooks: LAN only, no Authentik.
        reverse_proxy @webhooks_lan 192.168.1.20:5179
        respond @webhooks_other 404
        # Everything else asks Authentik first (omit this block if you do not use it).
        forward_auth @protected auth.example.com:9000 {
            uri /outpost.goauthentik.io/auth/caddy
        }
        # flush_interval -1 turns off response buffering for the Now Playing stream.
        reverse_proxy 192.168.1.20:5179 {
            flush_interval -1
        }
    }
}
```

Set `SRTL_TRUST_PROXY` to the address Caddy connects from (`loopback` when Caddy is on the same host). Caddy replaces forwarded headers from clients it does not trust, so no extra step is needed. Point `forward_auth` at your outpost; for the embedded outpost that is the Authentik server's port. Check the current Authentik and Caddy documentation, since the exact directive options change between versions.

## Traefik

With Docker labels on the SRTL `api` service. Names and middleware options vary between Traefik versions; treat this as a starting point.

```yaml
labels:
  - traefik.enable=true
  - traefik.http.routers.srtl.rule=Host(`srtl.example.com`)
  - traefik.http.routers.srtl.entrypoints=websecure
  - traefik.http.routers.srtl.tls.certresolver=letsencrypt
  - traefik.http.routers.srtl.middlewares=srtl-body,authentik
  - traefik.http.services.srtl.loadbalancer.server.port=3010
  # Request size limit (70 MB).
  - traefik.http.middlewares.srtl-body.buffering.maxRequestBodyBytes=73400320
  # Authentik forward auth.
  - traefik.http.middlewares.authentik.forwardauth.address=http://authentik-server:9000/outpost.goauthentik.io/auth/traefik
  - traefik.http.middlewares.authentik.forwardauth.trustForwardHeader=true
  # Webhooks: LAN only, no Authentik.
  - traefik.http.routers.srtl-hooks.rule=Host(`srtl.example.com`) && PathPrefix(`/api/integrations/`)
  - traefik.http.routers.srtl-hooks.entrypoints=websecure
  - traefik.http.routers.srtl-hooks.tls=true
  - traefik.http.routers.srtl-hooks.priority=100
  - traefik.http.routers.srtl-hooks.middlewares=lan-only
  - traefik.http.middlewares.lan-only.ipallowlist.sourcerange=192.168.1.0/24
```

Traefik streams server-sent events without extra settings. Set `SRTL_TRUST_PROXY` to Traefik's address, and configure `forwardedHeaders.trustedIPs` on the Traefik entry point so Traefik passes on only the client addresses it should. Block `/api/health` and `/documentation` with a router that has a higher priority and a `redirectregex` or a dummy service that returns 404, or leave them to SRTL, which already refuses them.

## Before exposing to the internet

Work through this list in order. Each item is something that has gone wrong on real installs.

**Create the account first**
- [ ] Open SRTL on your LAN and finish first-run setup, so the owner account exists before the address is public. Setup needs the one-time setup token from the API log (`docker compose logs api`), but finishing it first leaves nothing to guess.
- [ ] Use a long, unique password for every SRTL account (at least 12 characters). Do not reuse your Authentik or media server password.

**SRTL settings** (in `.env`, then `docker compose up -d`)
- [ ] `SRTL_PUBLIC_ORIGIN=https://srtl.example.com` (secure cookies follow from it).
- [ ] `SRTL_TRUST_PROXY` is the proxy's address or range, not `true` and not a wide range such as `0.0.0.0/0`.
- [ ] `SRTL_ALLOWED_ORIGINS` lists only extra origins you really use, or is empty.
- [ ] `SRTL_API_DOCS` is off.
- [ ] `SRTL_SECRET_KEY` is set, and a copy is kept somewhere other than your database backups.
- [ ] You run the production Docker image, not a development server.

**Network**
- [ ] The SRTL port is reachable only by the proxy: `SRTL_BIND_HOST=127.0.0.1`, or no `ports` block and a shared Docker network.
- [ ] Postgres has no published port, and nothing else on the host is forwarded from your router except the proxy's 80 and 443.
- [ ] Plex, Jellyfin, Radarr and Sonarr are not published through the same proxy unless they have their own protection.

**Proxy**
- [ ] HTTPS with a valid certificate, Force SSL on, HTTP/2 on, and only one source of HSTS.
- [ ] `client_max_body_size` is at least 70 MB.
- [ ] Now Playing stream: buffering off, read timeout of an hour or more.
- [ ] `/api/health` and `/api/health/ready` return 404 from outside. `/api/health/live` may stay public.
- [ ] `/documentation` returns 404 from outside.
- [ ] Webhook paths answer only your LAN, and the webhook secrets are set in every Radarr and Sonarr instance.
- [ ] A second sign-in (Authentik forward auth or a VPN) protects the admin host, restricted to a group of people you trust. The webhook paths and static app files are the only exceptions.

**Test from outside your network** (a phone on mobile data works)
- [ ] `https://srtl.example.com/` shows the Authentik sign-in, not SRTL.
- [ ] Without signing in, `https://srtl.example.com/api/settings/paths` does not return data.
- [ ] `https://srtl.example.com/api/health` and a webhook path return 404 or 403.
- [ ] After signing in to both, SRTL works, a change such as saving a setting succeeds, and Now Playing stays connected for several minutes.

**Afterwards**
- [ ] Treat database dumps and the `data` folder as secrets. Media server tokens and Radarr and Sonarr API keys are stored encrypted with `SRTL_SECRET_KEY`, so keep the key apart from the dumps, and keep both off shared storage.
- [ ] Watch the SRTL [releases](https://github.com/ramphex/SRTL-Manager/releases) and update when a security fix ships.
- [ ] Review account activity from time to time. Settings > User settings lists open sessions and a security activity log of sign-ins, failures, lockouts, account changes, removed media servers and stopped streams. `GET /api/system/action-audit` (signed in) lists copies, purges, discarded partial copies, removed servers and instances, stopped streams, and database backup settings changes and manual runs, with who, when and the item IDs.
- [ ] Decide how long you keep proxy and SRTL logs. They contain client addresses, which are personal data.

## When something goes wrong

An error shown in the app can end with `Reference: <id>`, and every response carries the same value in an `X-Request-Id` header. The details of the failure, which are never sent to the browser, are in the SRTL log under that ID:

```bash
docker compose logs api | grep <id>
```

Quote the ID, not the log contents, when you ask for help, and remove anything private from a log before you share it.
