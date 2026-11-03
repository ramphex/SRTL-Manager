// Which network addresses SRTL may connect to when it calls a URL an admin entered: Plex, Jellyfin, Radarr and
// Sonarr. Every such request resolves the host once, checks every answer here, and then connects to the checked
// address, so a second DNS answer cannot redirect it.
import { lookup } from "node:dns/promises";
import { BlockList, isIP, type LookupFunction } from "node:net";

/** Address classes an allow list can name, alongside addresses and CIDR ranges. */
export type OutboundClass = "loopback" | "private" | "public";

export interface OutboundPolicy {
  classes: ReadonlySet<OutboundClass>;
  /** The CIDR ranges and addresses listed, in addition to the classes. */
  ranges: readonly string[];
}

const classNames = new Set<OutboundClass>(["loopback", "private", "public"]);

/** Without SRTL_OUTBOUND_ALLOW_CIDRS: LAN and internet addresses, but not this host's own loopback services. */
export const defaultOutboundPolicy: OutboundPolicy = { classes: new Set(["private", "public"]), ranges: [] };

// Never reachable, whatever the allow list says: unspecified, link-local (including cloud metadata), multicast,
// reserved and broadcast addresses.
const alwaysDenied = new BlockList();
alwaysDenied.addSubnet("0.0.0.0", 8, "ipv4");
alwaysDenied.addSubnet("169.254.0.0", 16, "ipv4");
alwaysDenied.addSubnet("224.0.0.0", 4, "ipv4");
alwaysDenied.addSubnet("240.0.0.0", 4, "ipv4");
alwaysDenied.addAddress("100.100.100.200", "ipv4");
alwaysDenied.addAddress("::", "ipv6");
alwaysDenied.addSubnet("fe80::", 10, "ipv6");
alwaysDenied.addSubnet("ff00::", 8, "ipv6");
alwaysDenied.addAddress("fd00:ec2::254", "ipv6");

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const privateRanges = new BlockList();
privateRanges.addSubnet("10.0.0.0", 8, "ipv4");
privateRanges.addSubnet("172.16.0.0", 12, "ipv4");
privateRanges.addSubnet("192.168.0.0", 16, "ipv4");
privateRanges.addSubnet("100.64.0.0", 10, "ipv4");
privateRanges.addSubnet("fc00::", 7, "ipv6");

function parseEntry(entry: string): { kind: "class"; value: OutboundClass } | { kind: "range"; address: string; prefix: number; family: "ipv4" | "ipv6" } {
  const normalized = entry.trim().toLowerCase();
  if (classNames.has(normalized as OutboundClass)) return { kind: "class", value: normalized as OutboundClass };
  const [address = "", prefixText, ...rest] = normalized.split("/");
  const family = isIP(address);
  const maxBits = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? maxBits : /^\d{1,3}$/.test(prefixText) ? Number(prefixText) : Number.NaN;
  if (family === 0 || rest.length > 0 || !Number.isInteger(prefix) || prefix < 0 || prefix > maxBits) {
    throw new Error(`Invalid SRTL_OUTBOUND_ALLOW_CIDRS entry: ${entry}. Use private, public, loopback, an IP address or a CIDR range.`);
  }
  return { kind: "range", address, prefix, family: family === 4 ? "ipv4" : "ipv6" };
}

/** Parses SRTL_OUTBOUND_ALLOW_CIDRS. Empty means the default policy. */
export function parseOutboundPolicy(value: string | undefined): OutboundPolicy {
  const entries = (value ?? "").split(/[\s,]+/).filter(Boolean);
  if (!entries.length) return defaultOutboundPolicy;
  const classes = new Set<OutboundClass>();
  const ranges: string[] = [];
  for (const entry of entries) {
    const parsed = parseEntry(entry);
    if (parsed.kind === "class") classes.add(parsed.value);
    else ranges.push(`${parsed.address}/${parsed.prefix}`);
  }
  return { classes, ranges: [...new Set(ranges)] };
}

let current: { policy: OutboundPolicy; ranges: BlockList } = compile(defaultOutboundPolicy);

function compile(policy: OutboundPolicy): { policy: OutboundPolicy; ranges: BlockList } {
  const ranges = new BlockList();
  for (const range of policy.ranges) {
    const parsed = parseEntry(range);
    if (parsed.kind === "range") ranges.addSubnet(parsed.address, parsed.prefix, parsed.family);
  }
  return { policy, ranges };
}

/** Sets the process-wide policy. Called at startup from SRTL_OUTBOUND_ALLOW_CIDRS. */
export function configureOutboundPolicy(policy: OutboundPolicy): void {
  current = compile(policy);
}

export function currentOutboundPolicy(): OutboundPolicy {
  return current.policy;
}

// IPv4 addresses written as IPv6 (::ffff:192.168.1.2 or ::ffff:c0a8:102) are judged as IPv4.
function normalizeAddress(address: string): { address: string; family: "ipv4" | "ipv6" } | null {
  const lowered = address.toLowerCase().replace(/^\[|\]$/g, "").split("%", 1)[0]!;
  const family = isIP(lowered);
  if (family === 4) return { address: lowered, family: "ipv4" };
  if (family !== 6) return null;
  if (lowered.startsWith("::ffff:")) {
    const mapped = lowered.slice("::ffff:".length);
    if (isIP(mapped) === 4) return { address: mapped, family: "ipv4" };
    const groups = mapped.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/.test(group))) {
      const [high, low] = groups.map((group) => parseInt(group, 16)) as [number, number];
      return { address: [high >> 8, high & 255, low >> 8, low & 255].join("."), family: "ipv4" };
    }
  }
  return { address: lowered, family: "ipv6" };
}

export type OutboundProblem = "invalid" | "reserved" | "loopback" | "not-allowed";

/**
 * Why SRTL may not connect to an address, or null when it may. Built-in endpoints (`trusted`), such as plex.tv,
 * skip the allow list but never reach reserved or link-local addresses.
 */
export function outboundAddressProblem(address: string, options: { trusted?: boolean } = {}): OutboundProblem | null {
  const normalized = normalizeAddress(address);
  if (!normalized) return "invalid";
  if (alwaysDenied.check(normalized.address, normalized.family)) return "reserved";
  if (options.trusted) return null;
  const addressClass: OutboundClass = loopback.check(normalized.address, normalized.family)
    ? "loopback"
    : privateRanges.check(normalized.address, normalized.family) ? "private" : "public";
  if (current.policy.classes.has(addressClass)) return null;
  if (current.ranges.check(normalized.address, normalized.family)) return null;
  return addressClass === "loopback" ? "loopback" : "not-allowed";
}

export function outboundAddressAllowed(address: string, options: { trusted?: boolean } = {}): boolean {
  return outboundAddressProblem(address, options) === null;
}

/** The sentence a service's error message ends with, naming the setting when the address could be allowed. */
export function outboundProblemMessage(service: string, problem: OutboundProblem): string {
  if (problem === "loopback") return `${service} URL resolves to a loopback address. Add loopback to SRTL_OUTBOUND_ALLOW_CIDRS to allow it.`;
  if (problem === "not-allowed") return `${service} URL resolves to an address outside SRTL_OUTBOUND_ALLOW_CIDRS.`;
  return `${service} URL resolves to an unsupported network address.`;
}

export interface ResolvedAddress { address: string; family: number }

// The resolver every outbound request uses. Tests substitute their own answers.
export const outboundDns = {
  lookup: (hostname: string): Promise<ResolvedAddress[]> => lookup(hostname, { all: true })
};

export type OutboundResolution = { ok: true; address: ResolvedAddress } | { ok: false; problem: "dns" | OutboundProblem };

/** Resolves a host once and checks every answer. Callers connect to the returned address only. */
export async function resolveOutbound(hostname: string, options: { trusted?: boolean; timeoutMs?: number } = {}): Promise<OutboundResolution> {
  const host = hostname.replace(/^\[|\]$/g, "");
  let addresses: ResolvedAddress[];
  let timer: NodeJS.Timeout | undefined;
  try {
    addresses = await Promise.race([
      outboundDns.lookup(host),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("DNS timeout")), options.timeoutMs ?? 5000); })
    ]);
  } catch {
    return { ok: false, problem: "dns" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!addresses.length) return { ok: false, problem: "dns" };
  for (const entry of addresses) {
    const problem = outboundAddressProblem(entry.address, options);
    if (problem) return { ok: false, problem };
  }
  return { ok: true, address: addresses[0]! };
}

/** A `lookup` for http.request, net.connect and tls.connect that always answers with the checked address. */
export function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, [address]);
    else callback(null, address.address, address.family);
  };
}
