import { sql } from "drizzle-orm";
import type { MediaServerPrefixMapping } from "../../../shared/mediaServers";
import type { NowPlayingSource } from "../../../shared/nowPlaying";
import { dbGet, type Db } from "../../db/database";
import { getStorageLocationsSettings } from "../storageLocations";
import { toSrtlPath } from "../watchSyncEngine";

const unknownSource: NowPlayingSource = { status: "unknown", locationName: null, policy: null };

// Answers where a playing file lives from SRTL's own records: the media_links row for the mapped symlink path
// (unique index), else a storage_files row for the path itself (unique index). One lookup per playing file,
// cached; nothing touches the filesystem.
export class SourceResolver {
  private readonly cache = new Map<string, { value: NowPlayingSource; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<NowPlayingSource>>();
  private names: { value: Record<"local" | "remote", string>; expiresAt: number } | null = null;

  constructor(private readonly db: Db, private readonly ttlMs = 5 * 60_000) {}

  private async locationNames(): Promise<Record<"local" | "remote", string>> {
    if (this.names && this.names.expiresAt > Date.now()) return this.names.value;
    const settings = await getStorageLocationsSettings(this.db);
    const value = {
      local: settings.locations.find((location) => location.rootType === "local")?.displayName ?? "Local",
      remote: settings.locations.find((location) => location.rootType === "remote")?.displayName ?? "Remote"
    };
    this.names = { value, expiresAt: Date.now() + 60_000 };
    return value;
  }

  async resolve(serverId: string, mappings: MediaServerPrefixMapping[], filePath: string | null): Promise<NowPlayingSource> {
    if (!filePath || !filePath.startsWith("/")) return unknownSource;
    const linkPath = toSrtlPath(filePath, mappings);
    const key = `${serverId}\n${linkPath}`;
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const lookup = this.lookup(linkPath)
      .then((value) => {
        this.store(key, value, this.ttlMs);
        return value;
      })
      .catch(() => {
        this.store(key, unknownSource, 15_000);
        return unknownSource;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, lookup);
    return lookup;
  }

  private store(key: string, value: NowPlayingSource, ttl: number): void {
    if (this.cache.size > 500) {
      for (const [entryKey, entry] of this.cache) if (entry.expiresAt <= Date.now()) this.cache.delete(entryKey);
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { value, expiresAt: Date.now() + ttl });
  }

  private async lookup(linkPath: string): Promise<NowPlayingSource> {
    const names = await this.locationNames();
    const link = await dbGet<{ kind: string; storagePolicy: string; missingSince: string | null; rootType: string | null }>(this.db, sql`
      select ml.kind as "kind", ml.storage_policy as "storagePolicy", ml.missing_since as "missingSince", sf.root_type as "rootType"
      from media_links ml
      left join storage_files sf on sf.id = ml.resolved_storage_file_id and sf.missing_since is null
      where ml.link_path = ${linkPath}
      limit 1`);
    if (link) {
      const policy = link.storagePolicy && link.storagePolicy !== "unassigned" ? link.storagePolicy : null;
      if (link.missingSince) return { status: "unknown", locationName: null, policy };
      const rootType = link.kind === "local" || link.kind === "remote" ? link.kind : link.rootType === "local" || link.rootType === "remote" ? link.rootType : null;
      if (rootType) return { status: rootType, locationName: names[rootType], policy };
      return { status: link.kind === "broken" ? "broken" : "unknown", locationName: null, policy };
    }
    // The server may read a storage location directly instead of through SRTL's links.
    const file = await dbGet<{ rootType: string; storagePolicy: string }>(this.db, sql`
      select root_type as "rootType", storage_policy as "storagePolicy" from storage_files where file_path = ${linkPath} and missing_since is null limit 1`);
    if (file && (file.rootType === "local" || file.rootType === "remote")) {
      return { status: file.rootType, locationName: names[file.rootType], policy: file.storagePolicy && file.storagePolicy !== "unassigned" ? file.storagePolicy : null };
    }
    return { status: "unlinked", locationName: null, policy: null };
  }
}
