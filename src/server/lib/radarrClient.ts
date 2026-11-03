import { z } from "zod";
import { AppError } from "../errors";
import { arrAddressAllowed, normalizeArrUrl, requestArrJson, type ArrService } from "./arrHttp";

export class RadarrError extends AppError {}

export const radarrMovieSchema = z.object({
  id: z.number().int().positive(),
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  year: z.number().int(),
  path: z.string().min(1).max(4096),
  tags: z.array(z.number().int().positive()).max(1000),
  monitored: z.boolean().optional(),
  runtime: z.number().nonnegative().optional(),
  movieFile: z.object({ relativePath: z.string().max(4096), size: z.number().nonnegative().optional() }).nullish()
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;
const tagsSchema = z.array(z.object({ id: z.number().int().positive(), label: z.string().min(1).max(200) })).max(10000);

const radarrService: ArrService = { name: "Radarr", error: (message) => new RadarrError(message) };

export function normalizeRadarrUrl(input: string): string {
  return normalizeArrUrl(input, radarrService);
}

export const radarrAddressAllowed = arrAddressAllowed;

function requestJson(baseUrl: string, apiKey: string, endpoint: string, method = "GET", body?: unknown, maxBytes?: number): Promise<unknown> {
  return requestArrJson(radarrService, baseUrl, apiKey, endpoint, method, body, maxBytes);
}

export class RadarrClient {
  constructor(private readonly baseUrl: string, private readonly apiKey: string) {}

  private async read<T>(endpoint: string, schema: z.ZodType<T>, method?: string, body?: unknown, maxBytes?: number): Promise<T> {
    const parsed = schema.safeParse(await requestJson(this.baseUrl, this.apiKey, endpoint, method, body, maxBytes));
    if (!parsed.success) throw new RadarrError("Radarr returned an unsupported response format.");
    return parsed.data;
  }

  async test() {
    const system = await this.read("system/status", z.object({ version: z.string(), appName: z.literal("Radarr").optional() }));
    const roots = await this.read("rootfolder", z.array(z.object({ path: z.string() })).max(1000));
    await this.tags();
    return { version: system.version, rootFolders: roots.map((root) => root.path) };
  }

  // Full movie resources are several kilobytes each, so large libraries need a higher response cap.
  movies() { return this.read("movie", z.array(radarrMovieSchema).max(20000), "GET", undefined, 128 * 1024 * 1024); }
  async movie(id: number) {
    const movie = await this.read(`movie/${id}`, radarrMovieSchema);
    if (movie.id !== id) throw new RadarrError("Radarr returned a different movie identifier than requested.");
    return movie;
  }
  tags() { return this.read("tag", tagsSchema); }

  async ensureTag(label: string): Promise<number> {
    const existing = (await this.tags()).find((tag) => tag.label === label);
    if (existing) return existing.id;
    return (await this.read("tag", z.object({ id: z.number().int().positive() }), "POST", { label })).id;
  }

  async editTags(movieIds: number[], tags: number[], applyTags: "add" | "remove"): Promise<void> {
    if (movieIds.length && tags.length) await requestJson(this.baseUrl, this.apiKey, "movie/editor", "PUT", { movieIds, tags, applyTags });
  }

  async setMonitored(movieIds: number[], monitored: boolean): Promise<void> {
    if (movieIds.length) await requestJson(this.baseUrl, this.apiKey, "movie/editor", "PUT", { movieIds, monitored });
  }
}
