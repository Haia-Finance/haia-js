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

/**
 * Само обращение к `globalThis.localStorage` может БРОСИТЬ — это не то же
 * самое, что «его нет». В Chrome и Firefox при заблокированных сторонних куках
 * (и в песочном iframe без `allow-same-origin`) чтение свойства кидает
 * `SecurityError`. Голое обращение здесь роняло бы `createHaiaClient()` —
 * конструктор, который обещан чистым и SSR-безопасным, — и никакой try/catch
 * внутри `Identity` до этого уже не доходил бы.
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
    // Не падаем в конструкторе, если глобального fetch нет (RN / старый Node):
    // ошибка откладывается до вызова, а инъекция cfg.runtime.fetch её перекрывает.
    fetch: gf
      ? gf.bind(globalThis)
      : ((() => {
          throw new Error('haia: no global fetch; pass runtime.fetch in HaiaConfig')
        }) as typeof fetch),
    // Методы не оборачиваем: `Identity` уже переживает их отказ и держит id
    // в памяти сессии. Заворачивать здесь значило бы проглатывать ошибку у
    // партнёра, который взял `runtime.storage` для своих нужд.
    storage: ls ? { get: (k) => ls.getItem(k), set: (k, v) => ls.setItem(k, v) } : memoryStorage(),
    now: () => Date.now(),
  }
}
