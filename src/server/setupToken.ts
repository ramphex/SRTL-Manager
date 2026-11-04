import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import { setupPagePath } from "../shared/auth";

export const setupTokenFileName = "setup-token";
const setupTokenPattern = /^[A-Za-z0-9_-]{24,256}$/;

export function isValidSetupToken(value: string): boolean {
  return setupTokenPattern.test(value);
}

interface SetupTokenLogger {
  warn(message: string): void;
  info(message: string): void;
}

function digest(value: string): Buffer {
  return crypto.createHash("sha256").update(value).digest();
}

/**
 * The one-time token that first-run setup requires, so a new instance cannot
 * be claimed by whoever reaches it first. The token comes from
 * `SRTL_SETUP_TOKEN` or is generated, printed to the server log and written to
 * `<data dir>/setup-token`. Only its hash is kept in memory, and it is
 * discarded once an admin exists.
 */
export class SetupTokenGate {
  private tokenDigest: Buffer | null = null;

  constructor(
    private readonly options: { dataDir: string; configuredToken: string | null; log: SetupTokenLogger }
  ) {}

  get filePath(): string {
    return path.join(this.options.dataDir, setupTokenFileName);
  }

  get pending(): boolean {
    return this.tokenDigest !== null;
  }

  private readStoredToken(): string | null {
    try {
      const stored = fs.readFileSync(this.filePath, "utf8").trim();
      return isValidSetupToken(stored) ? stored : null;
    } catch {
      return null;
    }
  }

  private writeToken(token: string): boolean {
    try {
      fs.mkdirSync(this.options.dataDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(this.filePath, `${token}\n`, { mode: 0o600 });
      fs.chmodSync(this.filePath, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  /** Makes a token available while no admin exists. Safe to call repeatedly. */
  prepare(): void {
    if (this.tokenDigest) return;
    const { configuredToken, log } = this.options;
    if (configuredToken) {
      this.tokenDigest = digest(configuredToken);
      log.warn(`SRTL Manager setup required. Open ${setupPagePath} on this server's web address and enter the setup token from SRTL_SETUP_TOKEN to create the first admin user.`);
      return;
    }
    // Reuse a token from an earlier start so the log, the file and any copy the operator made still agree.
    let token = this.readStoredToken();
    let saved = token !== null;
    if (!token) {
      token = crypto.randomBytes(32).toString("base64url");
      saved = this.writeToken(token);
    }
    this.tokenDigest = digest(token);
    const location = saved ? ` It is also saved in ${this.filePath}.` : ` It could not be saved to ${this.filePath}.`;
    log.warn(`SRTL Manager setup required. Setup token: ${token}${location} Open ${setupPagePath} on this server's web address and enter this token to create the first admin user.`);
  }

  /** Constant-time check of a submitted token. False when no setup is pending. */
  verify(candidate: string): boolean {
    if (!this.tokenDigest) return false;
    return crypto.timingSafeEqual(digest(candidate.trim()), this.tokenDigest);
  }

  /** Forgets the token and removes its file once an admin exists. */
  complete(): void {
    this.tokenDigest = null;
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {
      // A read-only data directory leaves a token that no longer works.
    }
  }
}

const localNetworks = new net.BlockList();
localNetworks.addSubnet("127.0.0.0", 8, "ipv4");
localNetworks.addSubnet("10.0.0.0", 8, "ipv4");
localNetworks.addSubnet("172.16.0.0", 12, "ipv4");
localNetworks.addSubnet("192.168.0.0", 16, "ipv4");
localNetworks.addSubnet("169.254.0.0", 16, "ipv4");
localNetworks.addSubnet("100.64.0.0", 10, "ipv4");
localNetworks.addAddress("::1", "ipv6");
localNetworks.addSubnet("fc00::", 7, "ipv6");
localNetworks.addSubnet("fe80::", 10, "ipv6");

/** True for loopback, private, link-local and carrier-grade NAT addresses. */
export function isLocalNetworkAddress(address: string | undefined | null): boolean {
  if (!address) return false;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const candidate = mapped?.[1] ?? address;
  const family = net.isIP(candidate);
  if (family === 0) return false;
  return localNetworks.check(candidate, family === 4 ? "ipv4" : "ipv6");
}

/**
 * Whether a client may learn that the instance still needs setup. The client
 * address is resolved through the trusted proxies, so internet clients behind
 * a correctly configured proxy never see it. They open the setup form at its
 * direct address from the server log. That page looks the same whether or not
 * an admin exists, and setup needs the token either way.
 */
export function setupStatusVisibleTo(request: FastifyRequest): boolean {
  return isLocalNetworkAddress(request.ip);
}
