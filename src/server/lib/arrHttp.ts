import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

// How a Radarr or Sonarr client names itself in errors, and the error type its callers expect.
export interface ArrService {
  name: string;
  error: (message: string, httpStatus?: number) => Error;
}

export function normalizeArrUrl(input: string, service: ArrService): string {
  let url: URL;
  try { url = new URL(input); } catch { throw service.error(`Enter a valid ${service.name} HTTP or HTTPS URL.`); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw service.error(`${service.name} URL must use HTTP or HTTPS without credentials, query parameters, or fragments.`);
  }
  if (/%|\\/.test(url.pathname)) throw service.error(`${service.name} URL contains an unsupported base path.`);
  return url.toString().replace(/\/+$/, "");
}

export function arrAddressAllowed(address: string): boolean {
  const ip = address.toLowerCase();
  if (ip.startsWith("::ffff:")) {
    const suffix = ip.slice(7);
    if (isIP(suffix) === 4) return arrAddressAllowed(suffix);
    return false;
  }
  if (isIP(ip) === 4) {
    const octets = ip.split(".").map(Number);
    return octets[0] !== 0 && octets[0]! < 224 && !(octets[0] === 169 && octets[1] === 254);
  }
  return isIP(ip) === 6 && ip !== "::" && !/^f[e-f][89ab0-9a-f]/.test(ip);
}

// Pin the validated DNS answer to the socket; redirects cannot carry the API key elsewhere.
export async function requestArrJson(service: ArrService, baseUrl: string, apiKey: string, endpoint: string, method = "GET", body?: unknown, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  const url = new URL(`${normalizeArrUrl(baseUrl, service)}/api/v3/${endpoint}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: Array<{ address: string; family: number }>;
  let dnsTimer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("DNS timeout")), 5000); })
    ]);
  } catch { throw service.error(`${service.name} hostname could not be resolved.`); }
  finally { if (dnsTimer) clearTimeout(dnsTimer); }
  if (!addresses.length || addresses.some((entry) => !arrAddressAllowed(entry.address))) {
    throw service.error(`${service.name} URL resolves to an unsupported network address.`);
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
        reject(service.error(status === 401 || status === 403 ? `${service.name} rejected the API key.` : `${service.name} returned HTTP ${status}.`, status));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) {
          response.destroy();
          reject(service.error(`${service.name} response exceeded the supported size.`));
        } else chunks.push(chunk);
      });
      response.on("error", () => reject(service.error(`${service.name} response was interrupted.`)));
      response.on("end", () => {
        try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null); }
        catch { reject(service.error(`${service.name} returned an invalid JSON response.`)); }
      });
    });
    request.on("error", () => reject(service.error(`${service.name} connection failed or timed out. Check its address, network access, and TLS certificate.`)));
    request.end(data);
  });
}
