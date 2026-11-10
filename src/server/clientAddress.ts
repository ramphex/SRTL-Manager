import net from "node:net";

function ipv6Groups(address: string): number[] | null {
  let text = address.split("%")[0]!.toLowerCase();
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    // An embedded IPv4 address (::ffff:192.0.2.10) becomes the last two groups.
    if (!net.isIPv4(tail)) return null;
    const octets = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((octets[0]! << 8) | octets[1]!).toString(16)}:${((octets[2]! << 8) | octets[3]!).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest].map((group) => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The key one client is counted under by sign-in throttles and rate limits.
 * IPv4 addresses are used as they are. IPv6 addresses are cut to their /64
 * network, because a single home or server connection is usually handed a
 * whole /64 and could otherwise pick a fresh address for every attempt.
 * IPv4-mapped IPv6 addresses count as the IPv4 address they carry.
 */
export function clientBucket(address: string | undefined | null): string {
  const text = (address ?? "").trim();
  if (!text) return "unknown";
  if (net.isIPv4(text)) return text;
  const bare = text.split("%")[0]!;
  if (!net.isIPv6(bare)) return text.toLowerCase().slice(0, 100);
  const groups = ipv6Groups(bare);
  if (!groups) return text.toLowerCase().slice(0, 100);
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
    return [groups[6]! >> 8, groups[6]! & 0xff, groups[7]! >> 8, groups[7]! & 0xff].join(".");
  }
  return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
}
