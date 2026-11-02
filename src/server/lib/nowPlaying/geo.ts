import { isIP } from "node:net";
import { z } from "zod";
import type { NowPlayingGeo } from "../../../shared/nowPlaying";
import { plexEndpoints, plexHeaders } from "../plexClient";
import { watchSyncJson } from "../watchSyncHttp";

export function normalizeAddress(value: string): string {
  let address = value.trim();
  // "[2001:db8::1]:8096" and "192.168.1.20:52000" both appear in session reports.
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(address);
  if (bracketed) address = bracketed[1]!;
  else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(address)) address = address.slice(0, address.lastIndexOf(":"));
  address = address.toLowerCase();
  if (address.startsWith("::ffff:") && isIP(address.slice(7)) === 4) address = address.slice(7);
  return address;
}

// Private, loopback, link-local, CGNAT (100.64/10), and other non-routable addresses never leave SRTL.
export function isPrivateAddress(value: string): boolean {
  const address = normalizeAddress(value);
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number, number, number];
    return a === 10 || a === 127 || a === 0
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 169 && b === 254)
      || (a === 100 && b >= 64 && b <= 127)
      || a >= 224;
  }
  if (family === 6) {
    return address === "::1" || address === "::"
      || /^fe[89ab]/.test(address) // link-local fe80::/10
      || /^f[cd]/.test(address) // unique local fc00::/7
      || /^ff/.test(address); // multicast
  }
  // Not an address at all (a hostname or garbage): never looked up.
  return true;
}

export interface GeoLookupOptions {
  // Returns an owner Plex token to call plex.tv with, or null when no Plex server is signed in.
  token: () => string | null;
  clientIdentifier: () => string | null;
  enabled: () => boolean;
  onResolved: () => void;
  ttlMs?: number;
  negativeTtlMs?: number;
  timeoutMs?: number;
  maxEntries?: number;
  // Tests replace the plex.tv request.
  fetch?: (ip: string, token: string, clientIdentifier: string, timeoutMs: number) => Promise<NowPlayingGeo | null>;
}

const geoSchema = z.object({
  code: z.string().nullish(),
  country: z.string().nullish(),
  city: z.string().nullish(),
  subdivisions: z.union([z.string(), z.array(z.unknown())]).nullish()
}).loose();

// Tautulli's approach: plex.tv answers where a public address is, for any signed-in Plex account.
export async function plexTvGeoLookup(ip: string, token: string, clientIdentifier: string, timeoutMs: number): Promise<NowPlayingGeo | null> {
  const { data } = await watchSyncJson({
    url: `${plexEndpoints.plexTv}/api/v2/geoip?ip_address=${encodeURIComponent(ip)}`,
    service: "plex.tv",
    headers: plexHeaders(clientIdentifier, token),
    timeoutMs,
    retries: 0,
    maxBytes: 64 * 1024
  });
  const parsed = geoSchema.safeParse(data);
  if (!parsed.success) return null;
  const region = Array.isArray(parsed.data.subdivisions) ? parsed.data.subdivisions.find((entry): entry is string => typeof entry === "string") ?? null : parsed.data.subdivisions || null;
  const geo = { city: parsed.data.city || null, region, country: parsed.data.country || null, code: parsed.data.code || null };
  return geo.city || geo.region || geo.country ? geo : null;
}

// Looks up each public address once, lazily, and never makes a caller wait: get() answers from the cache and
// starts a lookup in the background when there is nothing cached.
export class GeoLookup {
  private readonly cache = new Map<string, { value: NowPlayingGeo | null; expiresAt: number }>();
  private readonly inFlight = new Set<string>();
  private readonly ttlMs: number;
  private readonly negativeTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly fetcher: NonNullable<GeoLookupOptions["fetch"]>;

  constructor(private readonly options: GeoLookupOptions) {
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60_000;
    this.negativeTtlMs = options.negativeTtlMs ?? 10 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.maxEntries = options.maxEntries ?? 2000;
    this.fetcher = options.fetch ?? plexTvGeoLookup;
  }

  get(ip: string | null): NowPlayingGeo | null {
    if (!ip || !this.options.enabled() || isPrivateAddress(ip)) return null;
    const cached = this.cache.get(ip);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    this.start(ip);
    return cached?.value ?? null;
  }

  pending(): number {
    return this.inFlight.size;
  }

  private start(ip: string): void {
    if (this.inFlight.has(ip)) return;
    const token = this.options.token();
    const clientIdentifier = this.options.clientIdentifier();
    if (!token || !clientIdentifier) return;
    this.inFlight.add(ip);
    void this.fetcher(ip, token, clientIdentifier, this.timeoutMs)
      .then((value) => this.store(ip, value, value ? this.ttlMs : this.negativeTtlMs))
      .catch(() => this.store(ip, null, this.negativeTtlMs))
      .finally(() => {
        this.inFlight.delete(ip);
        this.options.onResolved();
      });
  }

  private store(ip: string, value: NowPlayingGeo | null, ttl: number): void {
    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.delete(ip);
    this.cache.set(ip, { value, expiresAt: Date.now() + ttl });
  }
}
