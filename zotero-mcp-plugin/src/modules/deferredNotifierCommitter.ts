export interface DeferredNotifierCommitResult {
  completed: boolean;
  elapsedMs: number;
  pending: number;
  status: "completed" | "pending" | "failed";
  error?: string;
}

type LogLevel = "warn" | "error";
type Logger = (message: string, level?: LogLevel) => void;

const NOTIFIER_FOREGROUND_WAIT_MS = 250;

/**
 * Commit Zotero notifier queues in order without letting a slow observer hold
 * an MCP write response indefinitely. The commit itself is never cancelled.
 */
export class DeferredNotifierCommitter {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;

  constructor(
    private readonly maxForegroundWaitMs: number,
    private readonly log: Logger,
  ) {}

  async enqueue(
    label: string,
    commit: () => Promise<unknown>,
  ): Promise<DeferredNotifierCommitResult> {
    const startedAt = Date.now();
    this.pending++;
    let commitError: unknown;

    const scheduled = this.tail.then(async () => {
      await commit();
    });

    const settled = scheduled.then(
      () => undefined,
      (error) => {
        commitError = error;
        try {
          this.log(
            `[StreamableMCP] Deferred notifier commit failed for ${label}: ${error}`,
            "error",
          );
        } catch {
          // Logging must not leave the serialized notifier chain rejected.
        }
      },
    );

    this.tail = settled.finally(() => {
      this.pending--;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      settled.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.maxForegroundWaitMs);
      }),
    ]);

    if (timer) clearTimeout(timer);

    const error = commitError === undefined ? undefined : String(commitError);

    return {
      completed,
      elapsedMs: Date.now() - startedAt,
      pending: this.pending,
      status: completed ? (error ? "failed" : "completed") : "pending",
      ...(error ? { error } : {}),
    };
  }

  async flush(maxWaitMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const completed = await Promise.race([
      this.tail.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), maxWaitMs);
      }),
    ]);

    if (timer) clearTimeout(timer);
    return completed;
  }

  getPendingCount(): number {
    return this.pending;
  }
}

const notifierCommitter = new DeferredNotifierCommitter(
  NOTIFIER_FOREGROUND_WAIT_MS,
  (message, level) => ztoolkit.log(message, level),
);

let writeTail: Promise<void> = Promise.resolve();
let pendingWrites = 0;

export async function runSerializedWrite<T>(
  operation: () => Promise<T>,
): Promise<T> {
  pendingWrites++;
  let release!: () => void;
  const previous = writeTail;
  writeTail = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  try {
    return await operation();
  } finally {
    pendingWrites--;
    release();
  }
}

export async function flushWriteOperations(maxWaitMs = 5000): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const completed = await Promise.race([
    writeTail.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), maxWaitMs);
    }),
  ]);

  if (timer) clearTimeout(timer);
  if (!completed) {
    ztoolkit.log(
      `[StreamableMCP] Shutdown timed out with ${pendingWrites} write operation(s) still pending`,
      "warn",
    );
  }
  return completed;
}

export function createNotifierQueue(): any {
  return new (Zotero.Notifier as any).Queue();
}

export function notifierSaveOptions(notifierQueue: any): any {
  return { skipSelect: true, notifierQueue };
}

export async function commitNotifierQueue(
  notifierQueue: any,
  label: string,
): Promise<DeferredNotifierCommitResult> {
  const result = await notifierCommitter.enqueue(label, () =>
    (Zotero.Notifier as any).commit(notifierQueue),
  );

  if (!result.completed) {
    ztoolkit.log(
      `[StreamableMCP] Database commit completed for ${label}; ${result.pending} notifier queue(s) still running after ${result.elapsedMs}ms`,
      "warn",
    );
  }

  return result;
}

export async function flushNotifierCommits(maxWaitMs = 2000): Promise<boolean> {
  const completed = await notifierCommitter.flush(maxWaitMs);
  if (!completed) {
    ztoolkit.log(
      `[StreamableMCP] Shutdown timed out with ${notifierCommitter.getPendingCount()} notifier queue(s) still pending`,
      "warn",
    );
  }
  return completed;
}
