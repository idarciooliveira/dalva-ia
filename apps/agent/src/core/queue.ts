export interface ChatQueueLimits {
  /** Tasks waiting or running for one chat. Past it, new tasks for that chat are dropped. */
  maxPerChat: number;
  /** Tasks waiting or running in total. Past it, every new task is refused. */
  maxTotal: number;
  /** Tasks running at once across chats (each makes several API calls). */
  maxConcurrent: number;
}

/** Counting semaphore; waiters are served in arrival order. */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      // The releasing task hands its slot straight to us, so `active` stays counted.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

export type EnqueueResult = "accepted" | "chat_full" | "full";

interface Lane {
  tail: Promise<void>;
  size: number;
}

/**
 * In-memory serial queue per chat: tasks of one chat run one at a time in
 * arrival order, different chats run concurrently up to `maxConcurrent`.
 * Bounded per chat and in total, so a flood can't grow memory without limit.
 */
export class ChatQueues {
  private readonly lanes = new Map<string, Lane>();
  private total = 0;
  private capacityWaiters: Array<() => void> = [];
  private readonly slots: Semaphore;

  constructor(
    private readonly limits: ChatQueueLimits,
    private readonly onTaskError: (error: unknown) => void = () => {},
  ) {
    this.slots = new Semaphore(limits.maxConcurrent);
  }

  get size(): number {
    return this.total;
  }

  available(): number {
    return Math.max(0, this.limits.maxTotal - this.total);
  }

  enqueue(key: string, task: () => Promise<void>): EnqueueResult {
    if (this.available() === 0) return "full";
    const lane = this.lanes.get(key) ?? { tail: Promise.resolve(), size: 0 };
    if (lane.size >= this.limits.maxPerChat) return "chat_full";
    lane.size += 1;
    this.total += 1;
    this.lanes.set(key, lane);
    lane.tail = lane.tail
      .then(() => this.slots.run(task))
      .catch((error) => this.onTaskError(error))
      .finally(() => {
        lane.size -= 1;
        this.total -= 1;
        if (lane.size === 0 && this.lanes.get(key) === lane) this.lanes.delete(key);
        this.notifyCapacity();
      });
    return "accepted";
  }

  /** Resolves when there is room for at least one more task (polling waits on this). */
  waitForCapacity(): Promise<void> {
    if (this.available() > 0) return Promise.resolve();
    return new Promise((resolve) => this.capacityWaiters.push(resolve));
  }

  /** Resolves when every queued task has finished, or after `timeoutMs`. Returns whether it drained. */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.total > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      const tails = [...this.lanes.values()].map((lane) => lane.tail);
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all(tails),
        new Promise((resolve) => {
          timer = setTimeout(resolve, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
    return true;
  }

  private notifyCapacity() {
    if (this.available() === 0) return;
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
