export async function runKeyedPool<T>(
  items: readonly T[],
  maximum: number,
  keyFor: (item: T) => string,
  run: (item: T) => Promise<void>,
  shouldContinue: () => boolean = () => true
): Promise<void> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Copy file concurrency must be a positive safe integer");

  const lanes = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const lane = lanes.get(key);
    if (lane) lane.push(item);
    else lanes.set(key, [item]);
  }

  const pendingLanes = [...lanes.values()];
  let nextLane = 0;
  let stopStarting = false;
  const worker = async () => {
    while (!stopStarting && shouldContinue()) {
      const laneIndex = nextLane;
      nextLane += 1;
      const lane = pendingLanes[laneIndex];
      if (!lane) return;
      for (const item of lane) {
        if (stopStarting || !shouldContinue()) return;
        try {
          await run(item);
        } catch (error) {
          stopStarting = true;
          throw error;
        }
      }
    }
  };

  const workers = Array.from({ length: Math.min(maximum, pendingLanes.length) }, () => worker());
  const results = await Promise.allSettled(workers);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
