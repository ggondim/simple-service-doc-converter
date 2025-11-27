export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms?: number,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  const onParentAbort = () => controller.abort();
  if (parentSignal) {
    try {
      if (parentSignal.aborted) controller.abort();
      else parentSignal.addEventListener('abort', onParentAbort);
    } catch (_) {}
  }

  try {
    if (typeof ms === 'number' && ms > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        try { controller.abort(); } catch (_) {}
      }, ms);
    }

    return await fn(controller.signal);
  } catch (err) {
    if (timedOut) throw new Error('Operation timed out');
    throw err as unknown as never;
  } finally {
    try { if (timer) clearTimeout(timer); } catch (_) {}
    if (parentSignal) {
      try { parentSignal.removeEventListener('abort', onParentAbort); } catch (_) {}
    }
  }
}
