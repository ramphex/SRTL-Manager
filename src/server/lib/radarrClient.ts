import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { z } from "zod";

export class RadarrError extends Error {
  readonly statusCode = 400;
}

export const radarrMovieSchema = z.object({
  id: z.number().int().positive(),
  tmdbId: z.number().int().positive(),
  title: z.string().min(1).max(1000),
  year: z.number().int(),
  path: z.string().min(1).max(4096),
  tags: z.array(z.number().int().positive()).max(1000),
  monitored: z.boolean().optional(),
  movieFile: z.object({ relativePath: z.string().max(4096) }).nullish()
});
export type RadarrMovie = z.infer<typeof radarrMovieSchema>;
const tagsSchema = z.array(z.object({ id: z.number().int().positive(), label: z.string().min(1).max(200) })).max(10000);

export function normalizeRadarrUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new RadarrError("Enter a valid Radarr HTTP or HTTPS URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new RadarrError("Radarr URL must use HTTP or HTTPS without credentials, query parameters, or fragments.");
  }
  if (/%|\\/.test(url.pathname)) throw new RadarrError("Radarr URL contains an unsupported base path.");
  return url.toString().replace(/\/+$/, "");
}

export function radarrAddressAllowed(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) {
    const suffix = ip.slice(7);
    if (isIP(suffix) === 4) return radarrAddressAllowed(suffix);
    return false;
  }
  if (isIP(ip) === 4) {
    const octets = ip.split(".").map(Number);
    return octets[0] !== 0 && octets[0]! < 224 && !(octets[0] === 169 && octets[1] === 254);
  }
  return isIP(ip) === 6 && ip !== "::" && !/^f[e-f][89ab0-9a-f]/.test(ip);
}

// Pin the validated DNS answer to the socket; redirects cannot carry the API key elsewhere.
async function requestJson(baseUrl: string, apiKey: string, endpoint: string, method = "GET", body?: unknown, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  const url = new URL(`${normalizeRadarrUrl(baseUrl)}/api/v3/${endpoint}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  let dnsTimer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS timeout")), 5000); })
    ]);
  } catch { throw new RadarrError("Radarr hostname could not be resolved."); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some((entry) => !radarrAddressAllowed(entry.address))) {
    throw new RadarrError("Radarr URL resolves to an unsupported network address.");
  }
  const address = addresses[0]!;
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(url, {
      method,
      signal: AbortSignal.timeout(10000),
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { "X-Api-Key": apiKey, Accept: "application/json", ...(data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {}) }
    }, (response) => {
      const status = response.statusCode ?? 500;
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new RadarrError(status === 401 || status === 403 ? "Radarr rejected the API key." : `Radarr returned HTTP ${status}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy();
          reject(new RadarrError("Radarr response exceeded the supported size."));
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(new RadarrError("Radarr response was interrupted.")));
      response.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); }
        catch { reject(new RadarrError("Radarr returned an invalid JSON response.")); }
      });
    });
    request.on("error", () => reject(new RadarrError("Radarr connection failed or timed out. Check its address, network access, and TLS certificate.")));
    request.end(data);
  });
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
