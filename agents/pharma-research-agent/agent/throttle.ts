/**
 * Calls `fn` with the latest value at most every `ms`, so a token stream
 * becomes a few database writes a second. `flush()` sends the last value.
 */
export function throttle<T>(fn: (v: T) => void, ms = 400) {
  let last = 0;
  let pending: { v: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    if (!pending) return;
    last = Date.now();
    const { v } = pending;
    pending = null;
    fn(v);
  };
  return {
    push(v: T) {
      pending = { v };
      const wait = ms - (Date.now() - last);
      if (wait <= 0) fire();
      else timer ??= setTimeout(fire, wait);
    },
    flush() {
      if (timer) clearTimeout(timer);
      fire();
    },
  };
}
