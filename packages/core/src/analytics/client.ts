import type { AnalyticsEvent } from '@haia/types'
import type { HaiaConfig } from '../config'
import type { Identity } from '../identity/identity'
import type { Runtime } from '../runtime'
import { toBase64, unref } from '../util'

/** Событие в очереди вместе с идентичностью на момент его возникновения. */
interface QueuedEvent {
  event: AnalyticsEvent
  anonymousId: string
  userId?: string
}

const MAX_SEEN_IDS = 500
const MAX_RETRIES = 2
const RETRY_BASE_MS = 500

/**
 * Холодный путь: батчинг + fire-and-forget. Ошибки сети НИКОГДА не всплывают в
 * приложение и не блокируют UI.
 */
export class AnalyticsClient {
  private queue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Дедуп по clientEventId: повторный enqueue того же намерения — no-op. */
  private readonly seen = new Set<string>()

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
    private readonly identity: Identity,
    private readonly batchSize = 20,
    private readonly flushIntervalMs = 5000,
  ) {}

  enqueue(event: AnalyticsEvent): void {
    if (event.clientEventId !== undefined) {
      if (this.seen.has(event.clientEventId)) return
      if (this.seen.size >= MAX_SEEN_IDS) {
        const oldest = this.seen.values().next().value
        if (oldest !== undefined) this.seen.delete(oldest)
      }
      this.seen.add(event.clientEventId)
    }
    // Идентичность фиксируется в момент СОБЫТИЯ, а не флаша: иначе identify()
    // внутри того же батча задним числом переприписал бы userId на события,
    // случившиеся до логина.
    this.queue.push({
      event,
      anonymousId: this.identity.anonymousId(),
      userId: event.type === 'identify' ? event.userId : (this.identity.userId() ?? undefined),
    })
    if (this.queue.length >= this.batchSize) {
      void this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      void this.flush()
    }, this.flushIntervalMs)
    unref(this.flushTimer)
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.queue.length === 0) return
    const events = this.queue.splice(0, this.queue.length)
    // Идентичность — на КАЖДОМ элементе батча (Segment-совместимо): элементы
    // независимы, конверт несёт только projectId.
    const batch = events.map(({ event: { clientEventId, ...event }, anonymousId, userId }) => ({
      ...event,
      anonymousId,
      ...(userId ? { userId } : {}),
      ...(clientEventId ? { messageId: clientEventId } : {}),
    }))
    const body = JSON.stringify({ projectId: this.cfg.projectId, batch })
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.runtime.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Basic с пустым паролем — Segment-совместимая схема для write-key.
            authorization: `Basic ${toBase64(`${this.cfg.publishableKey}:`)}`,
          },
          body,
        })
        if (res.ok) return // доставлено — дедуп-ключи остаются, повтор не нужен
        // 4xx (кроме 429) — конфиг/авторизация: ретрай не поможет, роняем батч.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break
      } catch {
        // сетевой сбой — ретраим ниже
      }
      if (attempt < MAX_RETRIES) await this.sleep(RETRY_BASE_MS * 2 ** attempt)
    }
    // Батч не доставлен — роняем его: холодный путь никогда не блокирует
    // приложение и не растит очередь без границ. Но дедуп-ключи снимаем: иначе
    // то же событие, отправленное заново, молча отбросилось бы как дубль, и
    // потеря стала бы окончательной.
    this.forget(events)
  }

  private forget(events: QueuedEvent[]): void {
    for (const { event } of events) {
      if (event.clientEventId !== undefined) this.seen.delete(event.clientEventId)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      unref(t)
    })
  }
}
