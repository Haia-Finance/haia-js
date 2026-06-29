import type { AnalyticsEvent } from '@haia/types'
import type { HaiaConfig } from '../config'
import type { Identity } from '../identity/identity'
import type { Runtime } from '../runtime'
import { toBase64, unref } from '../util'

/**
 * Холодный путь: батчинг + fire-and-forget. Ошибки сети НИКОГДА не всплывают в
 * приложение и не блокируют UI.
 */
export class AnalyticsClient {
  private queue: AnalyticsEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
    private readonly identity: Identity,
    private readonly batchSize = 20,
    private readonly flushIntervalMs = 5000,
  ) {}

  enqueue(event: AnalyticsEvent): void {
    this.queue.push(event)
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
    const batch = this.queue.splice(0, this.queue.length)
    try {
      await this.runtime.fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.cfg.ingestToken
            ? { authorization: `Basic ${toBase64(`${this.cfg.ingestToken}:`)}` }
            : {}),
        },
        body: JSON.stringify({
          projectId: this.cfg.projectId,
          // Идентичность на конверте: anonymousId стабилен по сессии, userId
          // появляется после identify() → бэкенд может склеить anonymous↔user.
          anonymousId: this.identity.anonymousId(),
          userId: this.identity.userId() ?? undefined,
          batch,
        }),
      })
    } catch {
      // fire-and-forget — намеренно глотаем ошибку, не блокируем приложение.
    }
  }
}
