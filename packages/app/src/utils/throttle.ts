interface ThrottleOptions<
  T extends (...args: Parameters<T>) => void | Promise<void> = (...args: any[]) => void | Promise<void>,
> {
  emitLast?: boolean;
  /** 冷却期内的 pending args 合并策略；不提供时保持仅最后一组参数的旧行为。 */
  mergeArgs?: (previous: Parameters<T>, next: Parameters<T>) => Parameters<T>;
}

export const throttle = <T extends (...args: Parameters<T>) => void | Promise<void>>(
  func: T,
  delay: number,
  options: ThrottleOptions<T> = { emitLast: true },
): ((...args: Parameters<T>) => void) => {
  let lastCall = 0;
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: Parameters<T> | null = null;

  const invoke = (args: Parameters<T>) => {
    lastCall = Date.now();
    lastArgs = null;
    timeout = null;
    func(...args);
  };

  return (...args: Parameters<T>): void => {
    const now = Date.now();
    const remaining = delay - (now - lastCall);

    if (remaining <= 0) {
      if (timeout) clearTimeout(timeout);
      invoke(args);
    } else {
      lastArgs = lastArgs && options.mergeArgs ? options.mergeArgs(lastArgs, args) : args;
      if (!timeout) {
        timeout = setTimeout(() => {
          timeout = null;
          if (lastArgs && options.emitLast !== false) invoke(lastArgs);
          else lastArgs = null;
        }, remaining);
      }
    }
  };
};
