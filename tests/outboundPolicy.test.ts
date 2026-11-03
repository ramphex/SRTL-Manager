import { createHash } from "node:crypto";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestArrJson } from "../src/server/lib/arrHttp";
import { PlexLiveAdapter } from "../src/server/lib/nowPlaying/upstream";
import { configureOutboundPolicy, defaultOutboundPolicy, outboundAddressAllowed, outboundAddressProblem, outboundDns, parseOutboundPolicy } from "../src/server/lib/outboundPolicy";
import { testOutboundAllow } from "./setup";

// Host names in these tests resolve only through this table, so a connection that looked a name up a second time,
// instead of using the checked answer, would fail.
const dnsAnswers = new Map<string, Array<{ address: string; family: number }>>();
const dnsQueries: string[] = [];
const systemLookup = outboundDns.lookup;
outboundDns.lookup = async (hostname) => {
  const answer = dnsAnswers.get(hostname);
  if (!answer) return systemLookup(hostname);
  dnsQueries.push(hostname);
  return answer;
};

afterAll(() => {
  outboundDns.lookup = systemLookup;
});

afterEach(() => {
  configureOutboundPolicy(parseOutboundPolicy(testOutboundAllow));
  dnsAnswers.clear();
  dnsQueries.length = 0;
});

describe("outbound address policy", () => {
  it("allows LAN and internet addresses by default but not loopback, link-local, metadata or multicast", () => {
    configureOutboundPolicy(defaultOutboundPolicy);
    for (const address of ["192.168.1.20", "10.20.30.5", "172.20.1.1", "100.64.1.1", "fd12::1", "203.0.113.10", "2001:db8::1", "::ffff:192.168.1.20"]) {
      expect(outboundAddressAllowed(address), address).toBe(true);
    }
    for (const address of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) expect(outboundAddressProblem(address), address).toBe("loopback");
    for (const address of ["0.0.0.0", "169.254.169.254", "::ffff:169.254.169.254", "fe80::1", "ff02::1", "::", "224.0.0.1", "255.255.255.255", "100.100.100.200", "fd00:ec2::254"]) {
      expect(outboundAddressProblem(address), address).toBe("reserved");
    }
  });

  it("limits requests to the listed classes and ranges when SRTL_OUTBOUND_ALLOW_CIDRS is set", () => {
    configureOutboundPolicy(parseOutboundPolicy("192.168.1.0/24, 10.1.2.3 loopback"));
    expect(outboundAddressAllowed("192.168.1.200")).toBe(true);
    expect(outboundAddressAllowed("10.1.2.3")).toBe(true);
    expect(outboundAddressAllowed("127.0.0.1")).toBe(true);
    expect(outboundAddressProblem("192.168.2.1")).toBe("not-allowed");
    expect(outboundAddressProblem("203.0.113.10")).toBe("not-allowed");
    // Built-in endpoints such as plex.tv skip the list, but never reach reserved addresses.
    expect(outboundAddressAllowed("203.0.113.10", { trusted: true })).toBe(true);
    expect(outboundAddressAllowed("169.254.169.254", { trusted: true })).toBe(false);
    configureOutboundPolicy(parseOutboundPolicy("169.254.0.0/16"));
    expect(outboundAddressAllowed("169.254.169.254")).toBe(false);
  });

  it("rejects malformed entries", () => {
    for (const value of ["lan", "192.168.1.0/33", "10.20.30.1/8/2", "example.com"]) expect(() => parseOutboundPolicy(value)).toThrow("Invalid SRTL_OUTBOUND_ALLOW_CIDRS entry");
    expect(parseOutboundPolicy("")).toBe(defaultOutboundPolicy);
  });

  it("refuses a loopback service by default and names the setting that allows it", async () => {
    configureOutboundPolicy(defaultOutboundPolicy);
    const service = { name: "Radarr", error: (message: string) => new Error(message) };
    await expect(requestArrJson(service, "http://127.0.0.1:9", "example-key", "system/status")).rejects.toThrow("Radarr URL resolves to a loopback address. Add loopback to SRTL_OUTBOUND_ALLOW_CIDRS to allow it.");
    dnsAnswers.set("radarr.example.test", [{ address: "192.168.1.5", family: 4 }, { address: "169.254.169.254", family: 4 }]);
    await expect(requestArrJson(service, "http://radarr.example.test:7878", "example-key", "system/status")).rejects.toThrow("Radarr URL resolves to an unsupported network address.");
  });
});

describe("Now Playing sockets", () => {
  let server: http.Server;
  let port = 0;
  let upgrades: Array<{ host: string | undefined; token: string | undefined; remote: string | undefined }>;
  const sockets = new Set<Duplex>();

  beforeEach(async () => {
    upgrades = [];
    server = http.createServer((_request, response) => response.writeHead(404).end());
    server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
      upgrades.push({ host: request.headers.host, token: request.headers["x-plex-token"] as string | undefined, remote: request.socket.remoteAddress });
      const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      socket.on("error", () => undefined);
      sockets.add(socket);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const adapter = (host: string) => new PlexLiveAdapter({ id: "plex1", kind: "plex", name: "Plex", url: `http://${host}:${port}`, token: "example-owner-token", clientIdentifier: "example-client" });

  it("connects to the address that was checked, without resolving the host again", async () => {
    dnsAnswers.set("plex.example.test", [{ address: "127.0.0.1", family: 4 }]);
    const close = await adapter("plex.example.test").openSocket({ onEvent: () => undefined, onClose: () => undefined });
    close();
    // The handshake still names the configured host; only the address lookup was fixed to the checked answer.
    expect(upgrades).toEqual([{ host: `plex.example.test:${port}`, token: "example-owner-token", remote: "127.0.0.1" }]);
    expect(dnsQueries).toEqual(["plex.example.test"]);
  });

  it("never opens a socket to a host whose answer the policy refuses", async () => {
    dnsAnswers.set("metadata.example.test", [{ address: "169.254.169.254", family: 4 }]);
    await expect(adapter("metadata.example.test").openSocket({ onEvent: () => undefined, onClose: () => undefined })).rejects.toThrow("Plex URL resolves to an unsupported network address.");
    configureOutboundPolicy(defaultOutboundPolicy);
    dnsAnswers.set("plex.example.test", [{ address: "127.0.0.1", family: 4 }]);
    await expect(adapter("plex.example.test").openSocket({ onEvent: () => undefined, onClose: () => undefined })).rejects.toThrow("loopback");
    expect(upgrades).toEqual([]);
  });
});
