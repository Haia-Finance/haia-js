/**
 * Журнал wire-вызовов — инструмент ЭТОГО примера, а не часть SDK.
 *
 * Смысл: показать на странице ровно то, что ушло в control plane и что он
 * ответил. Хуков `onBlocked`/`onFlagged` для этого не хватает — они срабатывают
 * только на `rejected`/`flagged`, а самый частый и самый интересный для сверки
 * контракта случай (`approved` вместе с `reasons`) не виден вообще.
 *
 * Подключается через `runtime.fetch` в `HaiaConfig`: ядро не зашивает
 * браузерные API именно затем, чтобы их можно было подменить. Обёртка
 * прозрачна — ответ возвращается вызывающему как есть.
 */
import { createLogStore } from './store'

export type WirePath = 'policy' | 'ingest' | 'other'

export interface WireCall {
  seq: number
  at: number
  path: WirePath
  url: string
  request: unknown
  status: number | null
  response: unknown
  durationMs: number
  /** Сетевой сбой или таймаут: `status` пуст, и SDK применяет fail-mode. */
  error?: string
}

export const wireLog = createLogStore<WireCall>(30)

let seq = 0

function classify(url: string): WirePath {
  if (url.includes('/policy/evaluate')) return 'policy'
  if (url.endsWith('/batch')) return 'ingest'
  return 'other'
}

function parse(text: string): unknown {
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/**
 * Оборачивает fetch наблюдением. Тело ответа читаем с `res.clone()`: оригинал
 * обязан достаться SDK нетронутым — иначе `res.json()` в policy-клиенте упрётся
 * в уже вычитанный поток, вердикт станет «сервис недоступен», и инструмент
 * наблюдения начнёт менять наблюдаемое.
 */
export function observingFetch(inner: typeof fetch): typeof fetch {
  return async (input, init) => {
    const startedAt = Date.now()
    const url = urlOf(input)
    const started = {
      seq: ++seq,
      at: startedAt,
      path: classify(url),
      url,
      request: parse(typeof init?.body === 'string' ? init.body : ''),
    }
    try {
      const res = await inner(input, init)
      wireLog.push({
        ...started,
        status: res.status,
        response: parse(await res.clone().text()),
        durationMs: Date.now() - startedAt,
      })
      return res
    } catch (err) {
      wireLog.push({
        ...started,
        status: null,
        response: null,
        durationMs: Date.now() - startedAt,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}
