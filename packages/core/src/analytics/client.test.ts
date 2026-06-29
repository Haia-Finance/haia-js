import { describe, expect, it, vi } from 'vitest'
import type { HaiaConfig } from '../config'
import type { Identity } from '../identity/identity'
import type { Runtime } from '../runtime'
import { AnalyticsClient } from './client'

describe('AnalyticsClient identity envelope', () => {
  it('stamps anonymousId and userId on the flush envelope', async () => {
    let body: { anonymousId?: string; userId?: string; batch?: unknown[] } = {}
    const runtime: Runtime = {
      fetch: (async (_url: string, init: { body?: string }) => {
        body = JSON.parse(init.body ?? '{}')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 0,
    }
    const identity = {
      anonymousId: () => 'anon-1',
      userId: () => 'user-42',
    } as unknown as Identity
    const cfg: HaiaConfig = { projectId: 'p' }

    const client = new AnalyticsClient(cfg, runtime, 'https://x', identity)
    client.enqueue({ type: 'track', event: 'wallet_connected' })
    await client.flush()

    expect(body.anonymousId).toBe('anon-1')
    expect(body.userId).toBe('user-42')
    expect(body.batch?.length).toBe(1)
  })
})
