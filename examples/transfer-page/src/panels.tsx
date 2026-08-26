import { useSyncExternalStore } from 'react'
import { policyNotices } from './haia'
import { type WireCall, wireLog } from './wire-log'

/**
 * Две панели наблюдения. К интеграции они не относятся — партнёру ничего этого
 * писать не нужно; здесь они затем, чтобы контракт §3 был виден глазами, а не
 * только через devtools.
 */

export function PolicyNotices() {
  const notices = useSyncExternalStore(policyNotices.subscribe, policyNotices.get)
  if (notices.length === 0) return null
  return (
    <section className="panel">
      <h3>Хуки политики</h3>
      <ul className="notices">
        {notices.map((n) => (
          <li key={`${n.decisionId}-${n.at}`} className={`notice ${n.decision}`}>
            <span className="tag">{n.decision}</span>
            <code className="mono">{n.typeKey}</code>
            <span className="reasons">{n.reasons.join(', ') || '—'}</span>
            <code className="mono dim">{n.decisionId}</code>
          </li>
        ))}
      </ul>
    </section>
  )
}

export function WireLog() {
  const calls = useSyncExternalStore(wireLog.subscribe, wireLog.get)
  return (
    <section className="panel">
      <div className="panel-head">
        <h3>Wire</h3>
        <button type="button" className="ghost" onClick={() => wireLog.clear()}>
          Очистить
        </button>
      </div>
      {calls.length === 0 ? (
        <p className="hint">
          Пока пусто. Горячий путь (<code>/policy/evaluate</code>) появится здесь при отправке,
          холодный (<code>/v1/batch</code>) — пачкой, с задержкой до 5 секунд.
        </p>
      ) : (
        <ul className="calls">
          {calls.map((call) => (
            <Call key={call.seq} call={call} />
          ))}
        </ul>
      )}
    </section>
  )
}

function Call({ call }: { call: WireCall }) {
  const verdict = verdictOf(call)
  return (
    <li className="call">
      <div className="call-head">
        <span className={`tag ${call.path}`}>{call.path}</span>
        <span className={statusClass(call)}>{call.status ?? call.error ?? 'network error'}</span>
        {verdict && <span className={`tag ${verdict}`}>{verdict}</span>}
        <span className="dim">{call.durationMs} ms</span>
        <code className="mono dim path">{pathOf(call.url)}</code>
      </div>
      <div className="call-bodies">
        <pre>{format(call.request)}</pre>
        <pre>{format(call.response)}</pre>
      </div>
    </li>
  )
}

function statusClass(call: WireCall): string {
  if (call.status === null) return 'status bad'
  return call.status < 400 ? 'status ok' : 'status bad'
}

/** Вердикт вытаскиваем из тела, а не из статуса: 200 ещё не значит approved. */
function verdictOf(call: WireCall): string | null {
  if (call.path !== 'policy') return null
  const body = call.response
  if (!body || typeof body !== 'object') return null
  const decision = (body as { decision?: unknown }).decision
  return typeof decision === 'string' ? decision : null
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname
  } catch {
    return url
  }
}

function format(value: unknown): string {
  if (value === null) return '—'
  if (typeof value === 'string') return value
  return JSON.stringify(value, null, 2)
}
