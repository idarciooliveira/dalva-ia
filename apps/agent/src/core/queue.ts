export interface ChatQueueLimits {
  /** Tasks waiting or running for one chat. Past it, new tasks for that chat are dropped. */
  maxPerChat: number;
  /** Tasks waiting or running in total. Past it, every new task is refused. */
  maxTotal: number;
  /** Tasks running at once across chats (each makes several API calls). */
  maxConcurrent: number;
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
  private running = 0;
  private capacityWaiters: Array<() => void> = [];
  private slotWaiters: Array<() => void> = [];

  constructor(
    private readonly limits: ChatQueueLimits,
    private readonly onTaskError: (error: unknown) => void = () => {},
  ) {}

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
      .then(() => this.runWithSlot(task))
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

  private async runWithSlot(task: () => Promise<void>): Promise<void> {
    while (this.running >= this.limits.maxConcurrent) {
      await new Promise<void>((resolve) => this.slotWaiters.push(resolve));
    }
    this.running += 1;
    try {
      await task();
    } finally {
      this.running -= 1;
      this.slotWaiters.shift()?.();
    }
  }

  private notifyCapacity() {
    if (this.available() === 0) return;
    const waiters = this.capacityWaiters;
    this.capacityWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
