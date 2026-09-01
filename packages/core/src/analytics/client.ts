import type { AnalyticsEvent } from '@haia/types'
import type { HaiaConfig } from '../config'
import type { Identity } from '../identity/identity'
import type { Runtime } from '../runtime'
import { toBase64, unref } from '../util'

/** A queued event together with the identity as of the moment it happened. */
interface QueuedEvent {
  event: AnalyticsEvent
  anonymousId: string
  userId?: string
  /** The moment of the EVENT, not of the flush. */
  timestamp: string
}

const MAX_SEEN_IDS = 500
const MAX_RETRIES = 2
const RETRY_BASE_MS = 500

/**
 * The cold path: batching plus fire-and-forget. Network errors NEVER surface in
 * the application and never block the UI.
 */
export class AnalyticsClient {
  private queue: QueuedEvent[] = []
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  /** Deduplication by clientEventId: enqueuing the same intent again is a no-op. */
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
    // Identity is captured at the moment of the EVENT, not of the flush:
    // otherwise an identify() inside the same batch would retroactively stamp
    // its userId onto events that happened before the login.
    //
    // The timestamp is here for the same reason. Without it a Segment-compatible
    // receiver dates the event at the moment of RECEIPT, and between the event
    // and receipt lie the flush interval (5 s) and retries with backoff — which
    // would reorder cold-path events relative to other batches.
    this.queue.push({
      event,
      anonymousId: this.identity.anonymousId(),
      userId: event.type === 'identify' ? event.userId : (this.identity.userId() ?? undefined),
      timestamp: new Date(this.runtime.now()).toISOString(),
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
    // Identity goes on EVERY element of the batch (Segment-compatible): the
    // elements are independent and the envelope carries only the projectId.
    const batch = events.map(
      ({ event: { clientEventId, ...event }, anonymousId, userId, timestamp }) => ({
        ...event,
        anonymousId,
        timestamp,
        ...(userId ? { userId } : {}),
        ...(clientEventId ? { messageId: clientEventId } : {}),
      }),
    )
    const body = JSON.stringify({ projectId: this.cfg.projectId, batch })
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await this.runtime.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            // Basic with an empty password — the Segment-compatible scheme for a write key.
            authorization: `Basic ${toBase64(`${this.cfg.publishableKey}:`)}`,
          },
          body,
        })
        if (res.ok) return // delivered — the dedup keys stay, no resend needed
        // A 4xx (other than 429) is configuration or authorization: a retry
        // will not help, so drop the batch.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break
      } catch {
        // network failure — retried below
      }
      if (attempt < MAX_RETRIES) await this.sleep(RETRY_BASE_MS * 2 ** attempt)
    }
    // The batch was not delivered, so drop it: the cold path never blocks the
    // application and never grows the queue without bound. The dedup keys are
    // released, though — otherwise the same event, sent again, would be
    // silently discarded as a duplicate and the loss would become permanent.
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
