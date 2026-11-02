import { z } from "zod";
import { arrAddressAllowed, normalizeArrUrl, requestArrJson, type ArrService } from "./arrHttp";

export class SonarrError extends Error {
  readonly statusCode: number = 400;
  // Sonarr's own HTTP status when the error came from a Sonarr response.
  constructor(message: string, readonly httpStatus?: number) { super(message); }
}

export const sonarrSeriesSchema = z.object({
  id: z.number().int().positive(),
  // Series added without TheTVDB metadata report 0.
  tvdbId: z.number().int().nonnegative(),
  title: z.string().min(1).max(1000),
  year: z.number().int().optional(),
  path: z.string().min(1).max(4096),
  tags: z.array(z.number().int().positive()).max(1000),
  monitored: z.boolean().optional()
});
export type SonarrSeries = z.infer<typeof sonarrSeriesSchema>;

export const sonarrEpisodeFileSchema = z.object({
  id: z.number().int().positive(),
  seriesId: z.number().int().positive(),
  relativePath: z.string().max(4096),
  size: z.number().nonnegative().optional()
});
export type SonarrEpisodeFile = z.infer<typeof sonarrEpisodeFileSchema>;

export const sonarrEpisodeSchema = z.object({
  id: z.number().int().positive(),
  seriesId: z.number().int().positive(),
  episodeFileId: z.number().int().nonnegative().optional(),
  seasonNumber: z.number().int().nonnegative(),
  episodeNumber: z.number().int().nonnegative(),
  monitored: z.boolean()
});
export type SonarrEpisode = z.infer<typeof sonarrEpisodeSchema>;

const tagsSchema = z.array(z.object({ id: z.number().int().positive(), label: z.string().min(1).max(200) })).max(10000);
const sonarrService: ArrService = { name: "Sonarr", error: (message, httpStatus) => new SonarrError(message, httpStatus) };

export function normalizeSonarrUrl(input: string): string {
  return normalizeArrUrl(input, sonarrService);
}

export const sonarrAddressAllowed = arrAddressAllowed;

export class SonarrClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private request(endpoint: string, method?: string, body?: unknown, maxBytes?: number): Promise<unknown> {
    return requestArrJson(sonarrService, this.baseUrl, this.apiKey, endpoint, method, body, maxBytes);
  }

  private async read<T>(endpoint: string, schema: z.ZodType<T>, method?: string, body?: unknown, maxBytes?: number): Promise<T> {
    const parsed = schema.safeParse(await this.request(endpoint, method, body, maxBytes));
    if (!parsed.success) throw new SonarrError("Sonarr returned an unsupported response format.");
    return parsed.data;
  }

  async test() {
    const system = await this.read("system/status", z.object({ version: z.string(), appName: z.literal("Sonarr").optional() }));
    const roots = await this.read("rootfolder", z.array(z.object({ path: z.string() })).max(1000));
    await this.tags();
    return { version: system.version, rootFolders: roots.map((root) => root.path) };
  }

  // Full series resources include seasons and statistics, so large libraries need a higher response cap.
  series() { return this.read("series", z.array(sonarrSeriesSchema).max(50000), "GET", undefined, 128 * 1024 * 1024); }
  async seriesById(id: number) {
    const series = await this.read(`series/${id}`, sonarrSeriesSchema);
    if (series.id !== id) throw new SonarrError("Sonarr returned a different series identifier than requested.");
    return series;
  }
  tags() { return this.read("tag", tagsSchema); }

  async ensureTag(label: string): Promise<number> {
    const existing = (await this.tags()).find((tag) => tag.label === label);
    if (existing) return existing.id;
    return (await this.read("tag", z.object({ id: z.number().int().positive() }), "POST", { label })).id;
  }

  async editTags(seriesIds: number[], tags: number[], applyTags: "add" | "remove"): Promise<void> {
    if (seriesIds.length && tags.length) await this.request("series/editor", "PUT", { seriesIds, tags, applyTags });
  }

  async episodeFiles(seriesId: number): Promise<SonarrEpisodeFile[]> {
    const files = await this.read(`episodefile?seriesId=${seriesId}`, z.array(sonarrEpisodeFileSchema).max(100000), "GET", undefined, 64 * 1024 * 1024);
    if (files.some((file) => file.seriesId !== seriesId)) throw new SonarrError("Sonarr returned episode files of a different series than requested.");
    return files;
  }

  async episodeFile(id: number): Promise<SonarrEpisodeFile> {
    const file = await this.read(`episodefile/${id}`, sonarrEpisodeFileSchema);
    if (file.id !== id) throw new SonarrError("Sonarr returned a different episode file than requested.");
    return file;
  }

  async episodes(seriesId: number): Promise<SonarrEpisode[]> {
    const episodes = await this.read(`episode?seriesId=${seriesId}`, z.array(sonarrEpisodeSchema).max(100000), "GET", undefined, 64 * 1024 * 1024);
    if (episodes.some((episode) => episode.seriesId !== seriesId)) throw new SonarrError("Sonarr returned episodes of a different series than requested.");
    return episodes;
  }

  // Changes only these episodes; the series and its other episodes keep their monitoring.
  async setEpisodesMonitored(episodeIds: number[], monitored: boolean): Promise<void> {
    if (episodeIds.length) await this.request("episode/monitor", "PUT", { episodeIds, monitored });
  }
}
