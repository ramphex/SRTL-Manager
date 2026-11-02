import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import type { NowPlayingGpuSample, NowPlayingHostEvent, NowPlayingHostInfo, NowPlayingHostSample } from "../../../shared/nowPlaying";

// ---------------------------------------------------------------- network

export interface InterfaceCounters { name: string; rxBytes: number; txBytes: number }

// /proc/net/dev: two header lines, then "name: rx_bytes rx_packets ... (8 receive fields) tx_bytes ...".
export function parseNetDev(text: string): InterfaceCounters[] {
  const counters: InterfaceCounters[] = [];
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const name = line.slice(0, colon).trim();
    const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
    if (!name || fields.length < 16 || fields.some((field) => !Number.isFinite(field))) continue;
    counters.push({ name, rxBytes: fields[0]!, txBytes: fields[8]! });
  }
  return counters;
}

// Loopback, container, bridge, VM, tunnel, and VPN interfaces repeat traffic that also crosses a physical
// interface (or never leaves the host), so only the remaining interfaces count.
const virtualInterfacePattern = /^(lo|docker\d*|docker_gwbridge|veth|br-|br\d|virbr|vmbr|vnet|vxlan|flannel|cni|cali|cilium|kube|weave|lxcbr|lxdbr|podman|tun|tap|wg|tailscale|zt|nb-|wt\d|ifb|dummy|sit\d|ip6tnl|gre|erspan|nlmon)/i;

export function isVirtualInterface(name: string): boolean {
  return virtualInterfacePattern.test(name);
}

// VLAN interfaces such as eth0.20 or eth0@if5 carry traffic their parent also counts.
export function countedInterfaces(counters: InterfaceCounters[]): InterfaceCounters[] {
  const physical = counters.filter((entry) => !isVirtualInterface(entry.name));
  const names = new Set(physical.map((entry) => entry.name));
  return physical.filter((entry) => {
    const parent = entry.name.split(/[.@]/)[0]!;
    return parent === entry.name || !names.has(parent);
  });
}

export interface NetworkSource { path: string; scope: "host" | "container" }

export interface HostPaths {
  hostProcNetDev: string;
  procNetDev: string;
  dockerEnv: string;
}

const defaultPaths: HostPaths = { hostProcNetDev: "/host/proc/1/net/dev", procNetDev: "/proc/net/dev", dockerEnv: "/.dockerenv" };

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

// With the host's /proc mounted at /host/proc, PID 1's view is the host network namespace. Otherwise a
// container only sees its own interfaces.
export async function detectNetworkSource(paths: HostPaths = defaultPaths): Promise<NetworkSource | null> {
  if (await exists(paths.hostProcNetDev)) return { path: paths.hostProcNetDev, scope: "host" };
  if (await exists(paths.procNetDev)) return { path: paths.procNetDev, scope: (await exists(paths.dockerEnv)) ? "container" : "host" };
  return null;
}

// ---------------------------------------------------------------- CPU and memory

function cpuTotals(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

// ---------------------------------------------------------------- GPU

export const nvidiaQueryFields = "index,name,utilization.gpu,utilization.encoder,utilization.decoder,memory.used,memory.total,encoder.stats.sessionCount,temperature.gpu";

function gpuNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("[") || /n\/a/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNvidiaSmi(text: string): NowPlayingGpuSample[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    const fields = line.split(",").map((field) => field.trim());
    if (fields.length < 9) return [];
    const index = gpuNumber(fields[0]);
    if (index === null) return [];
    return [{
      index,
      name: fields[1] || `GPU ${index}`,
      utilization: gpuNumber(fields[2]),
      encoder: gpuNumber(fields[3]),
      decoder: gpuNumber(fields[4]),
      memoryUsedMb: gpuNumber(fields[5]),
      memoryTotalMb: gpuNumber(fields[6]),
      encoderSessions: gpuNumber(fields[7]),
      temperatureC: gpuNumber(fields[8])
    }];
  });
}

export type GpuRunner = (timeoutMs: number) => Promise<string>;

export const runNvidiaSmi: GpuRunner = (timeoutMs) => new Promise((resolve, reject) => {
  execFile("nvidia-smi", [`--query-gpu=${nvidiaQueryFields}`, "--format=csv,noheader,nounits"], { timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true }, (error, stdout) => {
    if (error) reject(error);
    else resolve(stdout);
  });
});

// ---------------------------------------------------------------- monitor

export interface HostMonitorOptions {
  intervalMs?: number;
  historySize?: number;
  gpuTimeoutMs?: number;
  // After nvidia-smi fails, SRTL checks again this much later.
  gpuRetryMs?: number;
  paths?: HostPaths;
  gpuRunner?: GpuRunner;
  readFile?: (file: string) => Promise<string>;
  onSample: (event: NowPlayingHostEvent) => void;
}

// Samples CPU, memory, network, and GPU only while someone is viewing Now Playing. Each sample reads one small
// /proc file and, when present, runs nvidia-smi once; history lives in memory and is lost on restart.
export class HostMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private history: NowPlayingHostSample[] = [];
  private previousCpu: { idle: number; total: number } | null = null;
  private previousNet: { at: number; rx: number; tx: number; names: string } | null = null;
  private networkSource: NetworkSource | null | undefined;
  private interfaces: string[] = [];
  private gpuAvailable = false;
  private gpuRetryAt = 0;
  private gpuBusy = false;
  private lastGpu: NowPlayingGpuSample[] | null = null;
  readonly intervalMs: number;
  private readonly historySize: number;

  constructor(private readonly options: HostMonitorOptions) {
    this.intervalMs = options.intervalMs ?? 3000;
    this.historySize = options.historySize ?? 100;
  }

  get active(): boolean {
    return this.running;
  }

  info(): NowPlayingHostInfo {
    return {
      networkScope: this.networkSource === null || this.networkSource === undefined ? "unavailable" : this.networkSource.scope,
      interfaces: this.interfaces,
      gpuAvailable: this.gpuAvailable,
      sampleIntervalMs: this.intervalMs
    };
  }

  snapshot(): NowPlayingHostEvent {
    return { info: this.info(), samples: [...this.history] };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.previousCpu = cpuTotals();
    this.previousNet = null;
    this.history = [];
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.history = [];
    this.previousNet = null;
    this.lastGpu = null;
  }

  private read(file: string): Promise<string> {
    return this.options.readFile ? this.options.readFile(file) : fs.readFile(file, "utf8");
  }

  private async sampleNetwork(now: number): Promise<{ inBps: number | null; outBps: number | null }> {
    if (this.networkSource === undefined) this.networkSource = await detectNetworkSource(this.options.paths ?? defaultPaths);
    if (!this.networkSource) return { inBps: null, outBps: null };
    let counted: InterfaceCounters[];
    try {
      counted = countedInterfaces(parseNetDev(await this.read(this.networkSource.path)));
    } catch {
      return { inBps: null, outBps: null };
    }
    this.interfaces = counted.map((entry) => entry.name);
    const rx = counted.reduce((sum, entry) => sum + entry.rxBytes, 0);
    const tx = counted.reduce((sum, entry) => sum + entry.txBytes, 0);
    const names = this.interfaces.join(",");
    const previous = this.previousNet;
    this.previousNet = { at: now, rx, tx, names };
    // A counter reset or an interface coming or going would show as a spike, so that reading is skipped.
    if (!previous || previous.names !== names || rx < previous.rx || tx < previous.tx || now <= previous.at) return { inBps: null, outBps: null };
    const seconds = (now - previous.at) / 1000;
    return { inBps: Math.round((rx - previous.rx) / seconds), outBps: Math.round((tx - previous.tx) / seconds) };
  }

  private async sampleGpu(now: number): Promise<NowPlayingGpuSample[] | null> {
    if (this.gpuBusy) return this.lastGpu;
    if (!this.gpuAvailable && now < this.gpuRetryAt) return null;
    this.gpuBusy = true;
    try {
      const gpus = parseNvidiaSmi(await (this.options.gpuRunner ?? runNvidiaSmi)(this.options.gpuTimeoutMs ?? 2500));
      if (!gpus.length) throw new Error("no GPUs reported");
      this.gpuAvailable = true;
      this.lastGpu = gpus;
      return gpus;
    } catch {
      this.gpuAvailable = false;
      this.lastGpu = null;
      this.gpuRetryAt = now + (this.options.gpuRetryMs ?? 10 * 60_000);
      return null;
    } finally {
      this.gpuBusy = false;
    }
  }

  async tick(): Promise<NowPlayingHostSample | null> {
    if (!this.running) return null;
    const now = Date.now();
    const cpu = cpuTotals();
    const previousCpu = this.previousCpu;
    this.previousCpu = cpu;
    const totalDelta = previousCpu ? cpu.total - previousCpu.total : 0;
    const cpuPercent = previousCpu && totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - (cpu.idle - previousCpu.idle) / totalDelta) * 1000) / 10)) : null;
    const [network, gpus] = await Promise.all([this.sampleNetwork(now), this.sampleGpu(now)]);
    if (!this.running) return null;
    const total = os.totalmem();
    const sample: NowPlayingHostSample = {
      at: new Date(now).toISOString(),
      cpuPercent,
      memoryUsedBytes: total - os.freemem(),
      memoryTotalBytes: total,
      networkInBps: network.inBps,
      networkOutBps: network.outBps,
      gpus
    };
    this.history.push(sample);
    if (this.history.length > this.historySize) this.history.splice(0, this.history.length - this.historySize);
    this.options.onSample({ info: this.info(), samples: [sample] });
    return sample;
  }
}
