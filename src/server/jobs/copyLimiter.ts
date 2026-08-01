function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Copy transfer was cancelled");
}

interface WaitingTransfer {
  signal: AbortSignal;
  resolve(release: () => void): void;
  reject(error: Error): void;
  abort(): void;
}

export class CopyTransferLimiter {
  private active = 0;
  private readonly waiting: WaitingTransfer[] = [];

  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Copy transfer limit must be a positive safe integer");
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiting.length;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    if (this.active < this.maximum) {
      this.active += 1;
      return Promise.resolve(this.releaseOnce());
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiting: WaitingTransfer = {
        signal,
        resolve,
        reject,
        abort: () => {
          const index = this.waiting.indexOf(waiting);
          if (index >= 0) this.waiting.splice(index, 1);
          signal.removeEventListener("abort", waiting.abort);
          reject(abortReason(signal));
        }
      };
      this.waiting.push(waiting);
      signal.addEventListener("abort", waiting.abort, { once: true });
    });
  }

  private releaseOnce(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.startNext();
    };
  }

  private startNext(): void {
    while (this.active < this.maximum) {
      const next = this.waiting.shift();
      if (!next) return;
      next.signal.removeEventListener("abort", next.abort);
      if (next.signal.aborted) {
        next.reject(abortReason(next.signal));
        continue;
      }
      this.active += 1;
      next.resolve(this.releaseOnce());
    }
  }
}
