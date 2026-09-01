import { describe, expect, it } from 'vitest'
import type { HaiaConfig } from '../config'
import type { Identity } from '../identity/identity'
import type { Runtime } from '../runtime'
import { AnalyticsClient } from './client'

interface BatchItem {
  type: string
  anonymousId?: string
  userId?: string
  messageId?: string
  event?: string
  timestamp?: string
}

function capturing(): {
  runtime: Runtime
  body: () => { batch?: BatchItem[] }
  headers: () => Record<string, string>
  urls: () => string[]
} {
  let parsed: { batch?: BatchItem[] } = {}
  let headers: Record<string, string> = {}
  const urls: string[] = []
  const runtime: Runtime = {
    fetch: (async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
      urls.push(url)
      parsed = JSON.parse(init.body ?? '{}')
      headers = init.headers ?? {}
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch,
    storage: { get: () => null, set: () => {} },
    now: () => 0,
  }
  return { runtime, body: () => parsed, headers: () => headers, urls: () => urls }
}

const identity = {
  anonymousId: () => 'anon-1',
  userId: () => 'user-42',
} as unknown as Identity

const cfg: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_1' }

describe('AnalyticsClient', () => {
  it('stamps identity on every item of the batch, not on the envelope', async () => {
    const cap = capturing()
    const client = new AnalyticsClient(cfg, cap.runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'a' })
    client.enqueue({ type: 'page', name: 'checkout' })
    await client.flush()

    const batch = cap.body().batch ?? []
    expect(batch.length).toBe(2)
    for (const item of batch) {
      expect(item.anonymousId).toBe('anon-1')
      expect(item.userId).toBe('user-42')
    }
  })

  it('does not retroactively attribute pre-login events to the user', async () => {
    const cap = capturing()
    let user: string | null = null
    const late = {
      anonymousId: () => 'anon-1',
      userId: () => user,
    } as unknown as Identity
    const client = new AnalyticsClient(cfg, cap.runtime, 'https://api/v1/batch', late)

    client.enqueue({ type: 'track', event: 'before-login' })
    user = 'user-42' // identify() happened between the events
    client.enqueue({ type: 'identify', userId: 'user-42' })
    client.enqueue({ type: 'track', event: 'after-login' })
    await client.flush()

    const batch = cap.body().batch ?? []
    expect(batch[0]?.userId).toBeUndefined() // before login there is only an anonymousId
    expect(batch[1]?.userId).toBe('user-42')
    expect(batch[2]?.userId).toBe('user-42')
  })

  it('stamps each item with the event time, not the flush time', async () => {
    // Without a timestamp a Segment-compatible receiver dates the event at
    // receipt, and between the event and receipt lie the flush interval and
    // the retries: cold-path events would be reordered.
    const cap = capturing()
    let clock = 1_000
    const runtime: Runtime = { ...cap.runtime, now: () => clock }
    const client = new AnalyticsClient(cfg, runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'first' })
    clock = 7_000 // time passed before the second event
    client.enqueue({ type: 'track', event: 'second' })
    clock = 60_000 // ... and more before the flush
    await client.flush()

    const batch = cap.body().batch ?? []
    expect(batch[0]?.timestamp).toBe(new Date(1_000).toISOString())
    expect(batch[1]?.timestamp).toBe(new Date(7_000).toISOString())
  })

  it('authenticates with the publishable key over Basic', async () => {
    const cap = capturing()
    const client = new AnalyticsClient(cfg, cap.runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'a' })
    await client.flush()

    expect(cap.headers().authorization).toBe(`Basic ${btoa('pk_1:')}`)
  })

  it('dedupes repeated events by clientEventId', async () => {
    const cap = capturing()
    const client = new AnalyticsClient(cfg, cap.runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'approval', clientEventId: '01J9' })
    client.enqueue({ type: 'track', event: 'approval', clientEventId: '01J9' })
    client.enqueue({ type: 'track', event: 'approval', clientEventId: '01JA' })
    await client.flush()

    const batch = cap.body().batch ?? []
    expect(batch.length).toBe(2)
    expect(batch.map((i) => i.messageId)).toEqual(['01J9', '01JA'])
  })

  it('never throws into the application when the network fails', async () => {
    const runtime: Runtime = {
      fetch: (async () => {
        throw new Error('offline')
      }) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 0,
    }
    const client = new AnalyticsClient(cfg, runtime, 'https://api/v1/batch', identity, 20, 5000)

    client.enqueue({ type: 'track', event: 'a' })
    await expect(client.flush()).resolves.toBeUndefined()
  })

  it('frees the dedup key when a batch is dropped, so a resend still lands', async () => {
    let online = false
    const sent: BatchItem[][] = []
    const runtime: Runtime = {
      fetch: (async (_u: string, init: { body?: string }) => {
        if (!online) throw new Error('offline')
        sent.push(JSON.parse(init.body ?? '{}').batch)
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 0,
    }
    const client = new AnalyticsClient(cfg, runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'approval', clientEventId: '01J9' })
    await client.flush() // offline → the batch is dropped after the retries

    online = true
    client.enqueue({ type: 'track', event: 'approval', clientEventId: '01J9' }) // resend
    await client.flush()

    expect(sent.length).toBe(1)
    expect(sent[0]?.[0]?.messageId).toBe('01J9')
  })

  it('does not retry a 4xx config error', async () => {
    let attempts = 0
    const runtime: Runtime = {
      fetch: (async () => {
        attempts += 1
        return new Response('', { status: 401 })
      }) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 0,
    }
    const client = new AnalyticsClient(cfg, runtime, 'https://api/v1/batch', identity)

    client.enqueue({ type: 'track', event: 'a' })
    await client.flush()

    expect(attempts).toBe(1)
  })
})
