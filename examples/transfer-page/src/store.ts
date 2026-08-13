/**
 * Минимальный лог-стор под `useSyncExternalStore`. Нужен дважды (wire-вызовы и
 * уведомления политики), поэтому вынесен, а не скопирован.
 *
 * Снапшот — новый массив на каждую запись и один и тот же между записями:
 * `useSyncExternalStore` сравнивает по ссылке и уйдёт в бесконечный ререндер,
 * если `get()` каждый раз возвращает свежий объект.
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
