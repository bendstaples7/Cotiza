import { describe, it, expect, vi } from 'vitest';
import {
  TimeoutError,
  withAbortTimeout,
  abortableDelay,
  combineAbortSignals,
} from '../../worker/src/utils/abort.js';

describe('withAbortTimeout', () => {
  it('passes an abort signal to the wrapped function', async () => {
    let receivedSignal: AbortSignal | undefined;
    await withAbortTimeout(async (signal) => {
      receivedSignal = signal;
      return 'ok';
    }, 5_000);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal?.aborted).toBe(false);
  });

  it('rejects when the timeout elapses', async () => {
    await expect(
      withAbortTimeout(() => new Promise<string>(() => {}), 50, 'test timeout'),
    ).rejects.toBeInstanceOf(TimeoutError);
  });
});

describe('abortableDelay', () => {
  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    await expect(abortableDelay(100, controller.signal)).rejects.toThrow('cancelled');
  });
});

describe('combineAbortSignals', () => {
  it('returns undefined when no signals are provided', () => {
    expect(combineAbortSignals()).toBeUndefined();
  });

  it('aborts the combined signal when any source aborts', () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = combineAbortSignals(a.signal, b.signal);
    expect(combined?.aborted).toBe(false);
    a.abort();
    expect(combined?.aborted).toBe(true);
  });
});
