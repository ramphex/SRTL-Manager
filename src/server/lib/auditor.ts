import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import type { AuditMode, MediaLinkRow } from "../../shared/types";
import { appendBoundedOutput, commandTimeoutMs, terminateChildProcess } from "./processSafety";
import { withFilesystemTimeout } from "./filesystemSafety";

export interface CommandResult {
  status: "pass" | "fail";
  output: string;
}

export interface AuditCommandRunner {
  runFfmpeg(mode: AuditMode, targetPath: string, signal?: AbortSignal): Promise<CommandResult>;
  runCmp(sourcePath: string, targetPath: string, signal?: AbortSignal): Promise<CommandResult>;
}

export interface AuditLinkResult {
  linkPath: string;
  targetPath: string;
  sourcePath: string | null;
  status: "pass" | "fail" | "source_issue";
  ffmpegStatus: "pass" | "fail";
  cmpStatus: "pass" | "fail" | "source_unknown" | "source_missing" | "source_error" | "skipped";
  message: string;
}

export interface AuditMediaOptions {
  byteCompare?: boolean;
  signal?: AbortSignal;
}

function abortError(): Error {
  return new Error("Job terminated");
}

function runCommand(command: string, args: string[], signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let output = "";
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      killTimer = terminateChildProcess(child);
      reject(abortError());
    };
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTimer = terminateChildProcess(child);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: `${command} timed out after ${commandTimeoutMs() / 1_000} seconds` });
    }, commandTimeoutMs());
    deadline.unref();
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr.on("data", (chunk: Buffer) => {
      output = appendBoundedOutput(output, chunk);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status: "fail", output: error.message });
    });
    child.on("close", (code) => {
      if (killTimer) clearTimeout(killTimer);
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      resolve({ status: code === 0 ? "pass" : "fail", output: output.trim() });
    });
  });
}

export const defaultAuditRunner: AuditCommandRunner = {
  runFfmpeg(mode, targetPath, signal) {
    const args =
      mode === "fast"
        ? ["-v", "error", "-i", targetPath, "-map", "0", "-c", "copy", "-f", "null", "-"]
        : ["-v", "error", "-i", targetPath, "-f", "null", "-"];
    return runCommand("ffmpeg", args, signal);
  },
  runCmp(sourcePath, targetPath, signal) {
    return runCommand("cmp", ["-b", sourcePath, targetPath], signal);
  }
};

export async function auditMediaLink(
  link: MediaLinkRow,
  sourcePath: string | null,
  mode: AuditMode,
  runner: AuditCommandRunner = defaultAuditRunner,
  options: AuditMediaOptions = {}
): Promise<AuditLinkResult> {
  try {
    await withFilesystemTimeout(fs.stat(link.targetPath), `Audit target check for ${link.targetPath}`);
  } catch {
    return {
      linkPath: link.linkPath,
      targetPath: link.targetPath,
      sourcePath,
      status: "fail",
      ffmpegStatus: "fail",
      cmpStatus: sourcePath ? "skipped" : "source_unknown",
      message: "Media target is missing or unreadable"
    };
  }

  let cmpStatus: AuditLinkResult["cmpStatus"] = "source_unknown";
  let cmpMessage = "Source unknown; byte compare skipped";
  const shouldByteCompare = options.byteCompare !== false;
  if (sourcePath && !shouldByteCompare) {
    cmpStatus = "skipped";
    cmpMessage = "Byte compare skipped by audit settings";
  } else if (sourcePath) {
    try {
      await withFilesystemTimeout(fs.stat(sourcePath), `Audit source check for ${sourcePath}`);
      const cmp = await runner.runCmp(sourcePath, link.targetPath, options.signal);
      cmpStatus = cmp.status;
      cmpMessage = cmp.status === "pass" ? "Byte compare passed" : `Byte compare failed: ${cmp.output || "cmp exited non-zero"}`;
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        cmpStatus = "source_missing";
        cmpMessage = "Recorded source is missing or unreadable";
      } else {
        cmpStatus = "source_error";
        cmpMessage = error instanceof Error ? error.message : "Recorded source could not be compared";
      }
    }
  }

  const ffmpeg = await runner.runFfmpeg(mode, link.targetPath, options.signal);
  if (ffmpeg.status === "fail") {
    return {
      linkPath: link.linkPath,
      targetPath: link.targetPath,
      sourcePath,
      status: "fail",
      ffmpegStatus: "fail",
      cmpStatus,
      message: `ffmpeg ${mode} audit failed: ${ffmpeg.output || "ffmpeg exited non-zero"}`
    };
  }

  if (cmpStatus === "fail") {
    return {
      linkPath: link.linkPath,
      targetPath: link.targetPath,
      sourcePath,
      status: "fail",
      ffmpegStatus: "pass",
      cmpStatus,
      message: cmpMessage
    };
  }

  if (cmpStatus === "source_missing" || cmpStatus === "source_error") {
    return {
      linkPath: link.linkPath,
      targetPath: link.targetPath,
      sourcePath,
      status: "source_issue",
      ffmpegStatus: "pass",
      cmpStatus,
      message: cmpMessage
    };
  }

  return {
    linkPath: link.linkPath,
    targetPath: link.targetPath,
    sourcePath,
    status: "pass",
    ffmpegStatus: "pass",
    cmpStatus,
    message: cmpStatus === "pass" ? "Passed ffmpeg and byte compare" : cmpStatus === "skipped" ? "Passed ffmpeg; byte compare skipped" : "Passed ffmpeg; source unknown"
  };
}
