/**
 * The wire-call log is a tool of THIS example, not a part of the SDK.
 *
 * Its purpose is to show on the page exactly what went to the control plane and
 * what came back. The `onBlocked` / `onFlagged` hooks are not enough for that —
 * they fire only on `rejected` / `flagged`, and the most common and most
 * interesting case for checking the contract (`approved` together with
 * `reasons`) is not visible at all.
 *
 * It is wired in through `runtime.fetch` in `HaiaConfig`: the kernel avoids
 * hardcoding browser APIs precisely so they can be replaced. The wrapper is
 * transparent — the response is returned to the caller untouched.
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
  /** A network failure or timeout: `status` is empty and the SDK applies its fail-mode. */
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
 * Wraps fetch with observation. The response body is read from `res.clone()`:
 * the original has to reach the SDK untouched, or `res.json()` in the policy
 * client would hit an already-consumed stream, the verdict would become
 * "service unavailable", and the observing tool would start changing what it
 * observes.
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
