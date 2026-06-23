export class TimeoutError extends Error {
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'TimeoutError';
  }
}

/** Merge multiple abort signals; aborts when any source aborts. */
export function combineAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => !!signal);
  if (active.length === 0) return undefined;
  if (active.length === 1) return active[0];

  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(active);
  }

  const controller = new AbortController();
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

export function createTimeoutSignal(
  timeoutMs: number,
  message?: string,
): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new TimeoutError(message ?? `Timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timeout),
  };
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }

  if (signal.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal.reason ?? new Error('Aborted'));
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };

    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Run fn with a timeout that aborts via signal (and propagates to cooperative callers). */
export async function withAbortTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message?: string,
): Promise<T> {
  const { signal, clear } = createTimeoutSignal(timeoutMs, message);
  try {
    return await Promise.race([
      fn(signal),
      new Promise<T>((_, reject) => {
        if (signal.aborted) {
          reject(signal.reason ?? new TimeoutError(message ?? `Timed out after ${timeoutMs}ms`));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(signal.reason ?? new TimeoutError(message ?? `Timed out after ${timeoutMs}ms`));
        }, { once: true });
      }),
    ]);
  } finally {
    clear();
  }
}
