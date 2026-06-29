import type { TransactionContext } from '@haia/types'
import { describe, expect, it } from 'vitest'
import type { HaiaConfig } from '../config'
import type { Runtime } from '../runtime'
import { PolicyEngine } from './engine'

function runtimeWithCounter(): { runtime: Runtime; calls: () => number } {
  let count = 0
  const runtime: Runtime = {
    fetch: (async () => {
      count += 1
      return new Response(
        JSON.stringify({ decision: 'approved', decisionId: 'd', ttlMs: 60_000 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }) as typeof fetch,
    storage: { get: () => null, set: () => {} },
    now: () => 1_000,
  }
  return { runtime, calls: () => count }
}

const cfg: HaiaConfig = { projectId: 'p' }

function ctx(over: Partial<TransactionContext>): TransactionContext {
  return {
    clientEventId: Math.random().toString(36),
    eventType: 'transfer_intent',
    chain: 'eip155:1',
    from: '0xfrom',
    ...over,
  }
}

describe('PolicyEngine cache key', () => {
  it('does not share a verdict across different amounts (amountRaw)', async () => {
    const { runtime, calls } = runtimeWithCounter()
    const engine = new PolicyEngine(cfg, runtime, 'https://x')
    const to = '0xrecipient'
    await engine.evaluate(ctx({ to, amountRaw: '1' }))
    await engine.evaluate(ctx({ to, amountRaw: '1' })) // cached → no new fetch
    await engine.evaluate(ctx({ to, amountRaw: '1000000000000000000000' })) // different value → must re-evaluate
    expect(calls()).toBe(2)
  })

  it('does not share a verdict between limited and unlimited approvals', async () => {
    const { runtime, calls } = runtimeWithCounter()
    const engine = new PolicyEngine(cfg, runtime, 'https://x')
    const base = {
      eventType: 'token_approval' as const,
      to: '0xtoken',
      method: 'approve',
      spender: '0xspender',
    }
    await engine.evaluate(ctx({ ...base, isUnlimitedApproval: false }))
    await engine.evaluate(ctx({ ...base, isUnlimitedApproval: true })) // must re-evaluate
    expect(calls()).toBe(2)
  })
})
