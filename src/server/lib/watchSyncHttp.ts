import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import { outboundProblemMessage, pinnedLookup, resolveOutbound, type ResolvedAddress } from "./outboundPolicy";

export class WatchSyncError extends Error {
  readonly statusCode: number = 400;
  constructor(message: string, readonly httpStatus: number | null = null, readonly retryable = false) {
    super(message);
  }
}

export interface WatchSyncResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
  // The raw bytes, for binary responses such as artwork.
  buffer: Buffer;
  // The server's own clock, from its Date header, so cursors never depend on SRTL's clock.
  serverTime: Date | null;
}

export interface WatchSyncRequest {
  url: string;
  // Names the service in error messages, such as "Plex" or "Jellyfin".
  service: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxBytes?: number;
  retries?: number;
  signal?: AbortSignal;
  // A built-in endpoint such as plex.tv rather than an address an admin entered: it skips the outbound allow list.
  trusted?: boolean;
}

// Tests shorten the backoff; production waits 0.5 s, 1.5 s, 4.5 s.
export const watchSyncHttpTiming = { backoffMs: 500 };

export function normalizeServerUrl(input: string, service: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new WatchSyncError(`Enter a valid ${service} HTTP or HTTPS URL.`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new WatchSyncError(`${service} URL must use HTTP or HTTPS without credentials, query parameters, or fragments.`);
  }
  if (/%|\\/.test(url.pathname)) throw new WatchSyncError(`${service} URL contains an unsupported base path.`);
  return url.toString().replace(/\/+$/, "");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new WatchSyncError("Watch sync was cancelled.")); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(new WatchSyncError("Watch sync was cancelled.")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Resolves the host once and checks every answer against the outbound policy; requests connect to the result only.
export async function resolveAllowed(hostname: string, service: string, options: { trusted?: boolean } = {}): Promise<ResolvedAddress> {
  const resolved = await resolveOutbound(hostname, options);
  if (resolved.ok) return resolved.address;
  if (resolved.problem === "dns") throw new WatchSyncError(`${service} hostname could not be resolved.`, null, true);
  throw new WatchSyncError(outboundProblemMessage(service, resolved.problem));
}

// One attempt. Every request opens its own connection and closes it afterwards: Jellyfin stalls kept-alive
// connections after a few hundred requests, so connection reuse is never worth it here.
async function attempt(request: WatchSyncRequest): Promise<WatchSyncResponse> {
  const url = new URL(request.url);
  const address = await resolveAllowed(url.hostname, request.service, { trusted: request.trusted });
  const maxBytes = request.maxBytes ?? 32 * 1024 * 1024;
  const timeout = AbortSignal.timeout(request.timeoutMs ?? 20_000);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  return new Promise((resolve, reject) => {
    const outgoing = (url.protocol === "https:" ? https : http).request(url, {
      method: request.method ?? "GET",
      agent: false,
      signal,
      lookup: pinnedLookup(address),
      headers: {
        Accept: "application/json",
        Connection: "close",
        ...request.headers,
        ...(request.body !== undefined ? { "Content-Type": request.headers?.["Content-Type"] ?? "application/json", "Content-Length": Buffer.byteLength(request.body) } : {})
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy();
          reject(new WatchSyncError(`${request.service} response exceeded the supported size.`));
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(new WatchSyncError(`${request.service} response was interrupted.`, null, true)));
      response.on("end", () => {
        const date = response.headers.date ? new Date(response.headers.date) : null;
        const buffer = Buffer.concat(chunks);
        resolve({ status: response.statusCode ?? 500, headers: response.headers, body: buffer.toString("utf8"), buffer, serverTime: date && Number.isFinite(date.getTime()) ? date : null });
      });
    });
    outgoing.on("error", () => {
      if (request.signal?.aborted) reject(new WatchSyncError("Watch sync was cancelled."));
      else reject(new WatchSyncError(`${request.service} connection failed or timed out. Check its address, network access, and TLS certificate.`, null, true));
    });
    outgoing.end(request.body);
  });
}

function statusError(service: string, status: number): WatchSyncError {
  if (status === 401 || status === 403) return new WatchSyncError(`${service} rejected the token or API key.`, status);
  if (status === 404) return new WatchSyncError(`${service} returned HTTP 404 (not found).`, status);
  return new WatchSyncError(`${service} returned HTTP ${status}.`, status, status === 429 || status >= 500);
}

// Retries network failures, timeouts, 429, and 5xx with exponential backoff. All watch sync requests are
// reads or idempotent writes (mark watched, set a position), so repeating one is safe.
export async function watchSyncRequest(request: WatchSyncRequest): Promise<WatchSyncResponse> {
  const retries = request.retries ?? 2;
  for (let attemptIndex = 0; ; attemptIndex += 1) {
    let failure: WatchSyncError;
    try {
      const response = await attempt(request);
      if (response.status >= 200 && response.status < 300) return response;
      failure = statusError(request.service, response.status);
      const retryAfter = Number(response.headers["retry-after"]);
      if (failure.retryable && attemptIndex < retries && Number.isFinite(retryAfter) && retryAfter > 0) {
        await delay(Math.min(10_000, retryAfter * 1000), request.signal);
        continue;
      }
    } catch (error) {
      failure = error instanceof WatchSyncError ? error : new WatchSyncError(`${request.service} request failed.`, null, true);
    }
    if (!failure.retryable || attemptIndex >= retries || request.signal?.aborted) throw failure;
    await delay(watchSyncHttpTiming.backoffMs * 3 ** attemptIndex, request.signal);
  }
}

export async function watchSyncJson(request: WatchSyncRequest): Promise<{ data: unknown; serverTime: Date | null }> {
  const response = await watchSyncRequest(request);
  if (!response.body.trim()) return { data: null, serverTime: response.serverTime };
  try {
    return { data: JSON.parse(response.body) as unknown, serverTime: response.serverTime };
  } catch {
    throw new WatchSyncError(`${request.service} returned an invalid JSON response.`);
  }
}
