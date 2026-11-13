import { z } from "zod";
import { AppError } from "../errors";
import { arrAddressAllowed, normalizeArrUrl, requestArrJson, type ArrService } from "./arrHttp";

export class RadarrError extends AppError {
  // Radarr's own HTTP status when the error came from a Radarr response.
  constructor(message: string, readonly httpStatus?: number) { super(message, 400); }
}

export const radarrMovieSchema = z.object({
  id: z.number().int().positive(),
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  year: z.number().int(),
  path: z.string().min(1).max(4096),
  tags: z.array(z.number().int().positive()).max(1000),
  monitored: z.boolean().optional(),
  runtime: z.number().nonnegative().optional(),
  movieFile: z.object({ id: z.number().int().positive().optional(), relativePath: z.string().max(4096), size: z.number().nonnegative().optional() }).nullish()
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;
const tagsSchema = z.array(z.object({ id: z.number().int().positive(), label: z.string().min(1).max(200) })).max(10000);

const commandSchema = z.object({ id: z.number().int().positive() });

const radarrService: ArrService = { name: "Radarr", error: (message, httpStatus) => new RadarrError(message, httpStatus) };

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

  // Forgets the file record, and removes the file if it is still there. A record already gone is not an error.
  async deleteMovieFile(id: number): Promise<void> {
    try { await requestJson(this.baseUrl, this.apiKey, `moviefile/${id}`, "DELETE"); }
    catch (error) { if (!(error instanceof RadarrError && error.httpStatus === 404)) throw error; }
  }

  // Runs as a search someone asked for, so it is not limited to what RSS would pick up. Returns Radarr's command id.
  async searchMovies(movieIds: number[]): Promise<number> {
    return (await this.read("command", commandSchema, "POST", { name: "MoviesSearch", movieIds })).id;
  }

  // Rescans this one movie's folder on disk, so a deleted file shows as missing. Without an id Radarr rescans every movie, so one is required.
  async rescanMovie(movieId: number): Promise<number> {
    if (!Number.isInteger(movieId) || movieId < 1) throw new Error("A rescan needs the movie's Radarr id.");
    return (await this.read("command", commandSchema, "POST", { name: "RescanMovie", movieId })).id;
  }
}
