/**
 * Runtime-абстракция: ядро не зашивает браузерные API, чтобы Mobile SDK (P2, RN)
 * мог переиспользовать его без форка.
 */

export interface KeyValueStorage {
  get(key: string): string | null
  set(key: string, value: string): void
}

export interface Runtime {
  fetch: typeof fetch
  storage: KeyValueStorage
  now(): number
}

function memoryStorage(): KeyValueStorage {
  const m = new Map<string, string>()
  return {
    get: (k) => m.get(k) ?? null,
    set: (k, v) => {
      m.set(k, v)
    },
  }
}

export function defaultRuntime(): Runtime {
  const ls = globalThis.localStorage as Storage | undefined
  return {
    fetch: globalThis.fetch.bind(globalThis),
    storage: ls ? { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) } : memoryStorage(),
    now: () => Date.now(),
  }
}
