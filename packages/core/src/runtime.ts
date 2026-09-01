/**
 * The runtime abstraction: the kernel does not hardcode browser APIs, so a
 * mobile SDK (React Native) can reuse it without a fork.
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

/**
 * Touching `globalThis.localStorage` at all can THROW — which is not the same
 * as it being absent. In Chrome and Firefox with third-party cookies blocked
 * (and inside a sandboxed iframe without `allow-same-origin`) reading the
 * property raises `SecurityError`. A bare access here would bring down
 * `createHaiaClient()` — a constructor documented as pure and SSR-safe — and no
 * try/catch inside `Identity` would ever be reached.
 */
function safeLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage as Storage | undefined
  } catch {
    return undefined
  }
}

export function defaultRuntime(): Runtime {
  const ls = safeLocalStorage()
  const gf = globalThis.fetch as typeof fetch | undefined
  return {
    // Do not fail in the constructor when there is no global fetch (React
    // Native / older Node): the error is deferred to the call, and injecting
    // cfg.runtime.fetch pre-empts it.
    fetch: gf
      ? gf.bind(globalThis)
      : ((() => {
          throw new Error('haia: no global fetch; pass runtime.fetch in HaiaConfig')
        }) as typeof fetch),
    // The methods are not wrapped: `Identity` already survives their failure
    // and keeps the id in session memory. Wrapping here would swallow the error
    // for an integrator who took `runtime.storage` for their own use.
    storage: ls ? { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) } : memoryStorage(),
    now: () => Date.now(),
  }
}
