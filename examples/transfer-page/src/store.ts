/**
 * A minimal log store for `useSyncExternalStore`. It is needed twice (wire
 * calls and policy notices), so it is factored out rather than copied.
 *
 * The snapshot is a new array per write and the same one between writes:
 * `useSyncExternalStore` compares by reference and would re-render forever if
 * `get()` returned a fresh object every time.
 */
export interface LogStore<T> {
  subscribe(listener: () => void): () => void
  get(): readonly T[]
  push(item: T): void
  clear(): void
}

export function createLogStore<T>(max: number): LogStore<T> {
  let items: readonly T[] = []
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    get: () => items,
    push(item) {
      items = [item, ...items].slice(0, max)
      notify()
    },
    clear() {
      items = []
      notify()
    },
  }
}
