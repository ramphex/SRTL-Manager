export interface ThrottlePolicy {
  /** Failures allowed before the first lockout. */
  freeAttempts: number;
  /** Length of the first lockout. Each further failure doubles it. */
  baseLockMs: number;
  /** Longest lockout. */
  maxLockMs: number;
  /** Failures are forgotten after this long without another one. */
  resetAfterMs: number;
}

interface ThrottleEntry {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

export interface ThrottleFailure {
  /** True when this failure started a new lockout. */
  lockedNow: boolean;
  /** Milliseconds until the key may try again, or 0. */
  retryAfterMs: number;
}

/**
 * Counts consecutive failures per key and locks the key out for an
 * exponentially growing, capped time once the free attempts are used. Kept in
 * memory with a bounded number of keys, so an attacker spraying usernames
 * cannot grow it without limit.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly policy: ThrottlePolicy,
    private readonly maxEntries = 10_000,
    private readonly clock: () => number = Date.now
  ) {}

  private current(key: string): ThrottleEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.clock();
    if (entry.lockedUntil <= now && now - entry.lastFailureAt >= this.policy.resetAfterMs) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Milliseconds until the key may try again, or 0 when it is not locked. */
  retryAfterMs(key: string): number {
    const entry = this.current(key);
    if (!entry) return 0;
    return Math.max(0, entry.lockedUntil - this.clock());
  }

  failure(key: string): ThrottleFailure {
    const now = this.clock();
    const entry = this.current(key) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
    entry.failures += 1;
    entry.lastFailureAt = now;
    let lockedNow = false;
    if (entry.failures >= this.policy.freeAttempts) {
      const exponent = Math.min(entry.failures - this.policy.freeAttempts, 20);
      const lockMs = Math.min(this.policy.baseLockMs * 2 ** exponent, this.policy.maxLockMs);
      lockedNow = entry.lockedUntil <= now;
      entry.lockedUntil = now + lockMs;
    }
    // Re-insert so the map stays ordered by last failure, oldest first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return { lockedNow, retryAfterMs: Math.max(0, entry.lockedUntil - now) };
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}

/** Per-username: 5 free attempts, then 30 seconds doubling up to 15 minutes. */
export const usernameThrottlePolicy: ThrottlePolicy = { freeAttempts: 5, baseLockMs: 30_000, maxLockMs: 15 * 60_000, resetAfterMs: 24 * 60 * 60_000 };
/** Per client address: 20 free attempts, then 1 minute doubling up to 1 hour. */
export const addressThrottlePolicy: ThrottlePolicy = { freeAttempts: 20, baseLockMs: 60_000, maxLockMs: 60 * 60_000, resetAfterMs: 24 * 60 * 60_000 };

export interface LoginAttemptCheck {
  allowed: boolean;
  retryAfterMs: number;
}

/**
 * Sign-in backoff by username and by client address. Usernames are throttled
 * whether or not they exist, so a lockout reveals nothing about which names
 * are real.
 */
export class LoginThrottle {
  readonly usernames: FailureThrottle;
  readonly addresses: FailureThrottle;

  constructor(clock: () => number = Date.now) {
    this.usernames = new FailureThrottle(usernameThrottlePolicy, 10_000, clock);
    this.addresses = new FailureThrottle(addressThrottlePolicy, 10_000, clock);
  }

  static usernameKey(username: string): string {
    return username.trim().toLowerCase().slice(0, 100);
  }

  check(username: string, address: string): LoginAttemptCheck {
    const retryAfterMs = Math.max(this.usernames.retryAfterMs(LoginThrottle.usernameKey(username)), this.addresses.retryAfterMs(address));
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  /** Records a failed attempt. Returns whether this failure started a lockout. */
  failure(username: string, address: string): ThrottleFailure {
    const byName = this.usernames.failure(LoginThrottle.usernameKey(username));
    const byAddress = this.addresses.failure(address);
    return { lockedNow: byName.lockedNow || byAddress.lockedNow, retryAfterMs: Math.max(byName.retryAfterMs, byAddress.retryAfterMs) };
  }

  success(username: string, address: string): void {
    this.usernames.reset(LoginThrottle.usernameKey(username));
    this.addresses.reset(address);
  }
}
