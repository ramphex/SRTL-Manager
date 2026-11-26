import { z } from "zod";
import packageJson from "../../../package.json";
import { WatchSyncError, normalizeServerUrl, watchSyncJson } from "./watchSyncHttp";

// Dupelix speaks its own API under /api/v1. SRTL authenticates with an API key (msk_...) in the Authorization
// header only; Dupelix refuses credentials in the query string. The key needs activity.read for Now Playing and
// library.read for artwork.
export const dupelixApiPrefix = "/api/v1";
export const dupelixRequiredScopes = ["activity.read", "library.read"] as const;

export function dupelixHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, Accept: "application/json", "X-Client-Info": `SRTL-Manager/${packageJson.version} (server)` };
}

const serverInfoSchema = z.object({
  version: z.string().optional(),
  apiVersions: z.array(z.string()).optional(),
  contractRevision: z.number().int().optional()
}).loose();

export interface DupelixServerInfo {
  version: string | null;
  contractRevision: number | null;
}

// "0.1.0 b1 (API revision 145)": Dupelix reports its product version only to an authenticated caller, so the API
// revision alone is shown when the version is missing.
export function dupelixVersionLabel(info: DupelixServerInfo): string | null {
  const revision = info.contractRevision !== null ? `API revision ${info.contractRevision}` : null;
  if (info.version && revision) return `${info.version} (${revision})`;
  return info.version ?? revision;
}

function scopeMessage(error: unknown, scope: string): never {
  if (error instanceof WatchSyncError && (error.httpStatus === 401 || error.httpStatus === 403)) {
    throw new WatchSyncError(error.httpStatus === 401
      ? "Dupelix rejected the API key. Create a new key in Dupelix and enter it again."
      : `Dupelix refused the API key for ${scope}. Give the key the activity.read and library.read scopes.`, error.httpStatus);
  }
  throw error;
}

export class DupelixClient {
  readonly baseUrl: string;
  constructor(baseUrl: string, private readonly apiKey: string, private readonly signal?: AbortSignal) {
    this.baseUrl = normalizeServerUrl(baseUrl, "Dupelix");
  }

  private get(path: string) {
    return watchSyncJson({ url: `${this.baseUrl}${dupelixApiPrefix}${path}`, service: "Dupelix", headers: dupelixHeaders(this.apiKey), timeoutMs: 8000, retries: 1, signal: this.signal, maxBytes: 4 * 1024 * 1024 });
  }

  async serverInfo(): Promise<DupelixServerInfo> {
    const { data } = await this.get("/server");
    const parsed = serverInfoSchema.safeParse(data);
    if (!parsed.success || parsed.data.contractRevision === undefined) throw new WatchSyncError("This address did not answer like a Dupelix server. Check the URL.");
    return { version: parsed.data.version?.trim() || null, contractRevision: parsed.data.contractRevision };
  }

  // /server answers without a key, so the test also reads one page of sessions (activity.read) and one title list
  // entry (library.read): a wrong key or a missing scope fails the test instead of the first Now Playing poll.
  async checkAccess(): Promise<void> {
    await this.get("/activity/sessions?limit=1").catch((error: unknown) => scopeMessage(error, "activity.read (Now Playing)"));
    await this.get("/titles?limit=1").catch((error: unknown) => scopeMessage(error, "library.read (artwork)"));
  }
}
