import type { ChildProcess } from "node:child_process";

const defaultCommandTimeoutMs = 6 * 60 * 60_000;
const defaultOutputLimitBytes = 256 * 1024;
const defaultKillGraceMs = 5_000;

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) return fallback;
  return Math.min(parsed, maximum);
}

export function commandTimeoutMs(): number {
  return boundedInteger(process.env.SRTL_COMMAND_TIMEOUT_MS, defaultCommandTimeoutMs, 60_000, 24 * 60 * 60_000);
}

export function processOutputLimitBytes(): number {
  return boundedInteger(process.env.SRTL_COMMAND_OUTPUT_LIMIT_BYTES, defaultOutputLimitBytes, 16 * 1024, 4 * 1024 * 1024);
}

export function appendBoundedOutput(current: string, chunk: Buffer | string, limit = processOutputLimitBytes()): string {
  const combined = current + chunk.toString();
  if (Buffer.byteLength(combined) <= limit) return combined;
  const tail = Buffer.from(combined).subarray(-limit).toString("utf8");
  return `[earlier command output truncated]\n${tail}`;
}

export function terminateChildProcess(child: ChildProcess): ReturnType<typeof setTimeout> | null {
  if (child.exitCode != null || child.signalCode != null) return null;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGKILL");
  }, boundedInteger(process.env.SRTL_PROCESS_KILL_GRACE_MS, defaultKillGraceMs, 500, 30_000));
  timer.unref();
  return timer;
}
