import { clientBucket } from "./clientAddress";

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

/** Undoes one recorded failure, see {@link FailureThrottle.refund}. */
export interface FailureReceipt {
  key: string;
  lockedUntilBefore: number;
  lockedUntilAfter: number;
}

/**
 * Counts consecutive failures per key and locks the key out for an
 * exponentially growing, capped time once the free attempts are used. Kept in
 * memory with a bounded number of keys, so an attacker spraying usernames
 * cannot grow it without limit.
 *
 * When the map is full, keys that are not locked are dropped first, oldest
 * first, so filling the map with new keys cannot wipe a lock that is in force.
 * Only past a hard cap of four times the normal size are locked keys dropped.
 */
export class FailureThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly policy: ThrottlePolicy,
    private readonly maxEntries = 10_000,
    private readonly clock: () => number = Date.now
  ) {}

  get size(): number {
    return this.entries.size;
  }

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

  /** True when the key has failures on record. */
  has(key: string): boolean {
    return this.current(key) !== undefined;
  }

  failure(key: string): ThrottleFailure {
    return this.record(key).failure;
  }

  /** Records a failure and returns what is needed to undo it. */
  record(key: string): { failure: ThrottleFailure; receipt: FailureReceipt } {
    const now = this.clock();
    const entry = this.current(key) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
    const lockedUntilBefore = entry.lockedUntil;
    entry.failures += 1;
    entry.lastFailureAt = now;
    let lockedNow = false;
    if (entry.failures >= this.policy.freeAttempts) {
      const exponent = Math.min(entry.failures - this.policy.freeAttempts, 20);
      const lockMs = Math.min(this.policy.baseLockMs * 2 ** exponent, this.policy.maxLockMs);
      lockedNow = entry.lockedUntil <= now;
      entry.lockedUntil = Math.max(entry.lockedUntil, now + lockMs);
    }
    // Re-insert so the map stays ordered by last failure, oldest first.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evict(now, key);
    return {
      failure: { lockedNow, retryAfterMs: Math.max(0, entry.lockedUntil - now) },
      receipt: { key, lockedUntilBefore, lockedUntilAfter: entry.lockedUntil }
    };
  }

  /** Keeps the key locked until at least `until`. Only touches a key that already has failures. */
  holdUntil(key: string, until: number): number {
    const entry = this.current(key);
    if (!entry) return 0;
    if (until > entry.lockedUntil) entry.lockedUntil = until;
    return entry.lockedUntil;
  }

  /**
   * Takes back one failure recorded with {@link record}, for an attempt that
   * turned out to be right. It never clears more than that one failure, so a
   * successful sign-in cannot wipe failures or a lock that others caused.
   */
  refund(receipt: FailureReceipt): void {
    const entry = this.entries.get(receipt.key);
    if (!entry) return;
    entry.failures = Math.max(0, entry.failures - 1);
    // Restore the lock only when nothing else has moved it since.
    if (entry.lockedUntil === receipt.lockedUntilAfter) entry.lockedUntil = receipt.lockedUntilBefore;
    if (entry.failures === 0 && entry.lockedUntil <= this.clock()) this.entries.delete(receipt.key);
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  /** Drops every key the predicate matches. */
  resetWhere(predicate: (key: string) => boolean): void {
    for (const key of [...this.entries.keys()]) if (predicate(key)) this.entries.delete(key);
  }

  private evict(now: number, keep: string): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) return;
      if (key !== keep && entry.lockedUntil <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries * 4) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === keep) break;
      this.entries.delete(oldest);
    }
  }
}

/** Per username and client: 5 free attempts, then 30 seconds doubling up to 15 minutes. */
export const usernameThrottlePolicy: ThrottlePolicy = { freeAttempts: 5, baseLockMs: 30_000, maxLockMs: 15 * 60_000, resetAfterMs: 24 * 60 * 60_000 };
/** Per client address: 20 free attempts, then 1 minute doubling up to 1 hour. */
export const addressThrottlePolicy: ThrottlePolicy = { freeAttempts: 20, baseLockMs: 60_000, maxLockMs: 60 * 60_000, resetAfterMs: 24 * 60 * 60_000 };
/**
 * Per username across all clients: after 10 failures, every further failure
 * makes the client that failed wait 5 seconds, doubling up to 1 minute. It
 * never refuses a client that has not failed on this name.
 */
export const usernameGuardPolicy: ThrottlePolicy = { freeAttempts: 10, baseLockMs: 5_000, maxLockMs: 60_000, resetAfterMs: 60 * 60_000 };

export interface LoginAttemptCheck {
  allowed: boolean;
  retryAfterMs: number;
}

/** A sign-in attempt that has been counted as a failure until it is settled. */
export interface LoginReservation {
  pairKey: string;
  pair: FailureReceipt;
  address: FailureReceipt;
  guard: FailureReceipt;
  /** What the failure did, in case the password turns out to be wrong. */
  failure: ThrottleFailure;
}

/**
 * Sign-in backoff. The design, and why:
 *
 * - **Username and client.** Failures are counted per username and client
 *   (see {@link clientBucket}: an IPv4 address, or an IPv6 /64). After 5 the
 *   pair is locked, 30 seconds doubling up to 15 minutes. Because the lock is
 *   tied to the client, someone guessing a name from one address cannot lock
 *   the real user out from another.
 * - **Client.** Failures per client across all names: 20, then 1 minute
 *   doubling up to 1 hour. This stops one client spraying many names.
 * - **Username guard.** Failures per username across all clients. Once a name
 *   has had 10 failures within an hour, each further failure makes the client
 *   that sent it wait 5 seconds, doubling up to 1 minute, before it may try
 *   that name again. A client with no failures on the name is never refused by
 *   it, so the real user can still sign in from their own address while
 *   someone else is guessing. Guessing from many addresses is held to about
 *   one attempt per address per interval, on top of the per-pair lock, the
 *   per-client lock, the request rate limit and the cap on concurrent password
 *   checks.
 *
 * Usernames are throttled whether or not they exist, so a lockout reveals
 * nothing about which names are real.
 *
 * Every attempt is counted as a failure before the password is checked
 * ({@link reserve}) and refunded if it was right ({@link succeeded}), so
 * concurrent attempts cannot all pass the check before any failure is
 * recorded. A success clears that username and client pair, and only takes
 * back its own reservation from the client and username counters, so a valid
 * sign-in cannot wipe a lock that other attempts earned.
 *
 * What it cannot do: an attacker behind the same address or IPv6 /64 as the
 * real user shares that user's per-pair and per-client counters.
 */
export class LoginThrottle {
  readonly pairs: FailureThrottle;
  readonly addresses: FailureThrottle;
  readonly usernames: FailureThrottle;

  constructor(private readonly clock: () => number = Date.now, maxEntries = 10_000) {
    this.pairs = new FailureThrottle(usernameThrottlePolicy, maxEntries, clock);
    this.addresses = new FailureThrottle(addressThrottlePolicy, maxEntries, clock);
    this.usernames = new FailureThrottle(usernameGuardPolicy, maxEntries, clock);
  }

  static usernameKey(username: string): string {
    return username.trim().toLowerCase().slice(0, 100);
  }

  private static pairKey(username: string, address: string): string {
    return `${LoginThrottle.usernameKey(username)}\0${clientBucket(address)}`;
  }

  check(username: string, address: string): LoginAttemptCheck {
    const retryAfterMs = Math.max(this.pairs.retryAfterMs(LoginThrottle.pairKey(username, address)), this.addresses.retryAfterMs(clientBucket(address)));
    return { allowed: retryAfterMs === 0, retryAfterMs };
  }

  /**
   * Checks and, when allowed, counts the attempt as a failure in the same
   * step. Settle it with {@link succeeded} or {@link failed}.
   */
  reserve(username: string, address: string): { allowed: true; reservation: LoginReservation } | { allowed: false; retryAfterMs: number } {
    const checked = this.check(username, address);
    if (!checked.allowed) return { allowed: false, retryAfterMs: checked.retryAfterMs };
    const pairKey = LoginThrottle.pairKey(username, address);
    const nameKey = LoginThrottle.usernameKey(username);
    const guard = this.usernames.record(nameKey);
    const pair = this.pairs.record(pairKey);
    const byAddress = this.addresses.record(clientBucket(address));
    // A name under attack makes every client that fails on it wait out the guard.
    const guardWait = this.usernames.retryAfterMs(nameKey);
    let pairFailure = pair.failure;
    if (guardWait > 0) {
      const now = this.clock();
      const wasLocked = pair.receipt.lockedUntilAfter > now;
      pair.receipt.lockedUntilAfter = this.pairs.holdUntil(pairKey, now + guardWait);
      pairFailure = { lockedNow: pairFailure.lockedNow || !wasLocked, retryAfterMs: Math.max(0, pair.receipt.lockedUntilAfter - now) };
    }
    return {
      allowed: true,
      reservation: {
        pairKey,
        pair: pair.receipt,
        address: byAddress.receipt,
        guard: guard.receipt,
        failure: {
          lockedNow: pairFailure.lockedNow || byAddress.failure.lockedNow,
          retryAfterMs: Math.max(pairFailure.retryAfterMs, byAddress.failure.retryAfterMs)
        }
      }
    };
  }

  /** The password was right: clear this username and client, and take back the reservation elsewhere. */
  succeeded(reservation: LoginReservation): void {
    this.pairs.reset(reservation.pairKey);
    this.addresses.refund(reservation.address);
    this.usernames.refund(reservation.guard);
  }

  /** The attempt never reached a password check, so it should not count. */
  cancelled(reservation: LoginReservation): void {
    this.pairs.refund(reservation.pair);
    this.addresses.refund(reservation.address);
    this.usernames.refund(reservation.guard);
  }

  /** The password was wrong. The failure is already counted. */
  failed(reservation: LoginReservation): ThrottleFailure {
    return reservation.failure;
  }

  /** Records a failed attempt outside {@link reserve}. Returns whether it started a lockout. */
  failure(username: string, address: string): ThrottleFailure {
    const reserved = this.reserve(username, address);
    if (reserved.allowed) return reserved.reservation.failure;
    return { lockedNow: false, retryAfterMs: reserved.retryAfterMs };
  }

  /** Lifts every lock on a username, for example after a manager resets its password. */
  clearUsername(username: string): void {
    const nameKey = LoginThrottle.usernameKey(username);
    this.usernames.reset(nameKey);
    this.pairs.resetWhere((key) => key.startsWith(`${nameKey}\0`));
  }
}

/**
 * Caps how many password checks run at once. Each scrypt check at the current
 * cost takes about 128 MB and a few hundred milliseconds on Node's small
 * thread pool, so unbounded parallel sign-ins could exhaust memory or starve
 * other work. A request that finds no free slot is answered 429 straight away.
 */
export class ConcurrencyGate {
  private active = 0;

  constructor(readonly slots: number) {}

  get inUse(): number {
    return this.active;
  }

  /** Returns a release function, or null when every slot is busy. */
  tryAcquire(): (() => void) | null {
    if (this.active >= this.slots) return null;
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }
}

/** Two checks at once keeps the peak near 256 MB and leaves thread pool room for file work. */
export const passwordVerificationSlots = 2;
