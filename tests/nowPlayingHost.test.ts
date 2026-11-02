import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { countedInterfaces, detectNetworkSource, HostMonitor, isVirtualInterface, parseNetDev, parseNvidiaSmi } from "../src/server/lib/nowPlaying/hostStats";
import type { NowPlayingHostEvent } from "../src/shared/nowPlaying";

const netDev = (rows: Array<[string, number, number]>) => [
  "Inter-|   Receive                                                |  Transmit",
  " face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
  ...rows.map(([name, rx, tx]) => `${name.padStart(6)}: ${rx} 100 0 0 0 0 0 0 ${tx} 90 0 0 0 0 0 0`)
].join("\n");

describe("/proc/net/dev", () => {
  it("parses receive and transmit bytes per interface", () => {
    expect(parseNetDev(netDev([["lo", 500, 500], ["eth0", 1000, 2000]]))).toEqual([
      { name: "lo", rxBytes: 500, txBytes: 500 },
      { name: "eth0", rxBytes: 1000, txBytes: 2000 }
    ]);
    expect(parseNetDev("garbage\nno: numbers here")).toEqual([]);
  });

  it("counts only physical interfaces, skipping loopback, containers, bridges, VMs, tunnels, and VLAN children", () => {
    for (const name of ["lo", "docker0", "docker_gwbridge", "veth1a2b3c", "br-0123abcd", "virbr0", "vmbr0", "vnet3", "tun0", "wg0", "tailscale0", "flannel.1", "cni0", "cali123"]) {
      expect(isVirtualInterface(name), name).toBe(true);
    }
    for (const name of ["eth0", "ens18", "enp3s0", "eno1", "wlan0", "bond0"]) expect(isVirtualInterface(name), name).toBe(false);
    const counted = countedInterfaces(parseNetDev(netDev([["lo", 1, 1], ["ens18", 10, 20], ["ens18.20", 5, 5], ["docker0", 7, 7], ["veth9", 3, 3], ["eth1.30", 4, 4]])));
    // ens18.20 rides on ens18, which already counts it; eth1.30's parent is not listed, so it counts.
    expect(counted.map((entry) => entry.name)).toEqual(["ens18", "eth1.30"]);
  });
});

describe("network source detection", () => {
  let root = "";
  afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }); });

  it("prefers the host's /proc mounted at /host/proc, then the container's own namespace", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-np-"));
    const paths = { hostProcNetDev: path.join(root, "host/proc/1/net/dev"), procNetDev: path.join(root, "proc/net/dev"), dockerEnv: path.join(root, ".dockerenv") };
    await fs.mkdir(path.dirname(paths.procNetDev), { recursive: true });
    await fs.writeFile(paths.procNetDev, netDev([["eth0", 1, 1]]));
    expect(await detectNetworkSource(paths)).toEqual({ path: paths.procNetDev, scope: "host" });
    await fs.writeFile(paths.dockerEnv, "");
    expect(await detectNetworkSource(paths)).toEqual({ path: paths.procNetDev, scope: "container" });
    await fs.mkdir(path.dirname(paths.hostProcNetDev), { recursive: true });
    await fs.writeFile(paths.hostProcNetDev, netDev([["ens18", 1, 1]]));
    expect(await detectNetworkSource(paths)).toEqual({ path: paths.hostProcNetDev, scope: "host" });
  });
});

describe("nvidia-smi", () => {
  it("parses utilization, encoder and decoder load, memory, and encoder sessions", () => {
    expect(parseNvidiaSmi("0, NVIDIA RTX A2000 12GB, 35, 22, 18, 1024, 12282, 3, 51\n1, Other GPU, [N/A], [Not Supported], 0, 10, 4096, 0, 40\n")).toEqual([
      { index: 0, name: "NVIDIA RTX A2000 12GB", utilization: 35, encoder: 22, decoder: 18, memoryUsedMb: 1024, memoryTotalMb: 12282, encoderSessions: 3, temperatureC: 51 },
      { index: 1, name: "Other GPU", utilization: null, encoder: null, decoder: 0, memoryUsedMb: 10, memoryTotalMb: 4096, encoderSessions: 0, temperatureC: 40 }
    ]);
    expect(parseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate with the NVIDIA driver.")).toEqual([]);
  });
});

describe("host monitor", () => {
  it("reports network rates from consecutive readings, labels container scope, and hides the GPU when nvidia-smi is missing", async () => {
    let rx = 1_000_000;
    let tx = 5_000_000;
    let gpuCalls = 0;
    const events: NowPlayingHostEvent[] = [];
    // The files only need to exist; their contents come from readFile.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "srtl-np-"));
    await fs.writeFile(path.join(dir, "dev"), "");
    await fs.writeFile(path.join(dir, ".dockerenv"), "");
    const monitor = new HostMonitor({
      intervalMs: 60_000,
      paths: { hostProcNetDev: path.join(dir, "missing"), procNetDev: path.join(dir, "dev"), dockerEnv: path.join(dir, ".dockerenv") },
      readFile: async () => netDev([["lo", 9, 9], ["eth0", rx, tx], ["veth0", 99, 99]]),
      gpuRunner: async () => { gpuCalls += 1; throw Object.assign(new Error("spawn nvidia-smi ENOENT"), { code: "ENOENT" }); },
      onSample: (event) => events.push(event)
    });
    try {
      monitor.start();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const first = events.at(-1)!;
      expect(first.samples[0]).toMatchObject({ networkInBps: null, networkOutBps: null, gpus: null });
      expect(first.info).toMatchObject({ networkScope: "container", interfaces: ["eth0"], gpuAvailable: false });
      rx += 3_000_000;
      tx += 9_000_000;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const second = (await monitor.tick())!;
      expect(second.networkInBps).toBeGreaterThan(1_500_000);
      expect(second.networkInBps).toBeLessThanOrEqual(3_000_000);
      expect(second.networkOutBps! / second.networkInBps!).toBeCloseTo(3, 1);
      expect(second.memoryTotalBytes).toBeGreaterThan(0);
      // nvidia-smi is not retried on every sample after it fails.
      expect(gpuCalls).toBe(1);
      expect(monitor.snapshot().samples).toHaveLength(2);
      monitor.stop();
      expect(monitor.snapshot().samples).toHaveLength(0);
      expect(await monitor.tick()).toBeNull();
    } finally {
      monitor.stop();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("shows the GPU card data when nvidia-smi answers", async () => {
    const monitor = new HostMonitor({ intervalMs: 60_000, readFile: async () => "", paths: { hostProcNetDev: "/nonexistent/a", procNetDev: "/nonexistent/b", dockerEnv: "/nonexistent/c" }, gpuRunner: async () => "0, NVIDIA RTX A2000, 10, 40, 30, 900, 6000, 2, 45", onSample: () => undefined });
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sample = (await monitor.tick())!;
    monitor.stop();
    expect(sample.gpus).toEqual([expect.objectContaining({ name: "NVIDIA RTX A2000", encoder: 40, encoderSessions: 2 })]);
    expect(monitor.info()).toMatchObject({ gpuAvailable: true, networkScope: "unavailable" });
  });
});
