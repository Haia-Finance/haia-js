import type { Facts, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import { createHaiaClient } from './client'
import type { HaiaConfig } from './config'
import { HaiaPolicyError } from './errors'
import type { Runtime } from './runtime'

function facts(over: Partial<Facts> = {}): Facts {
  return { clientEventId: '01J9', typeKey: 'token_approval', meta: { chain: 'eip155:1' }, ...over }
}

function runtimeReturning(verdict: Partial<Verdict>): Runtime {
  return {
    fetch: (async () =>
      new Response(JSON.stringify({ decisionId: 'dec_1', ...verdict }), {
        status: 200,
      })) as unknown as typeof fetch,
    storage: { get: () => null, set: () => {} },
    now: () => 0,
  }
}

const base: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_1' }

describe('pure constructor (§6.7)', () => {
  it('performs no I/O and touches no storage at construction time', () => {
    const fetchSpy = vi.fn()
    const get = vi.fn(() => null)
    const set = vi.fn()

    createHaiaClient({
      ...base,
      runtime: { fetch: fetchSpy as unknown as typeof fetch, storage: { get, set }, now: () => 0 },
    })

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
    expect(set).not.toHaveBeenCalled()
  })

  it('constructs without throwing when no global fetch exists (SSR-safe)', () => {
    const original = globalThis.fetch
    // @ts-expect-error — намеренно снимаем глобальный fetch
    globalThis.fetch = undefined
    try {
      expect(() => createHaiaClient(base)).not.toThrow()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('guard outcome contract (§6.5)', () => {
  it('throws HaiaPolicyError and calls onBlocked when rejected', async () => {
    const onBlocked = vi.fn()
    const client = createHaiaClient({
      ...base,
      onBlocked,
      runtime: runtimeReturning({ decision: 'rejected', reasons: ['unlimited_approval_blocked'] }),
    })

    const err = await client.guard(facts()).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(HaiaPolicyError)
    expect((err as HaiaPolicyError).reasons).toEqual(['unlimited_approval_blocked'])
    expect((err as HaiaPolicyError).decisionId).toBe('dec_1')
    expect(onBlocked).toHaveBeenCalledOnce()
  })

  it('proceeds on flagged and calls onFlagged', async () => {
    const onFlagged = vi.fn()
    const client = createHaiaClient({
      ...base,
      onFlagged,
      runtime: runtimeReturning({ decision: 'flagged', reasons: ['review'] }),
    })

    const verdict = await client.guard(facts())

    expect(verdict.decision).toBe('flagged')
    expect(onFlagged).toHaveBeenCalledOnce()
  })

  it('still blocks when the partner hook itself throws', async () => {
    const client = createHaiaClient({
      ...base,
      onBlocked: () => {
        throw new Error('partner UI crashed')
      },
      runtime: runtimeReturning({ decision: 'rejected' }),
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(client.guard(facts())).rejects.toBeInstanceOf(HaiaPolicyError)
    warn.mockRestore()
  })

  it('returns the verdict on approved without invoking hooks', async () => {
    const onBlocked = vi.fn()
    const onFlagged = vi.fn()
    const client = createHaiaClient({
      ...base,
      onBlocked,
      onFlagged,
      runtime: runtimeReturning({ decision: 'approved', reasons: ['not_gated'] }),
    })

    expect((await client.guard(facts())).decision).toBe('approved')
    expect(onBlocked).not.toHaveBeenCalled()
    expect(onFlagged).not.toHaveBeenCalled()
  })
})

describe('endpoints', () => {
  it('targets the per-project policy path', async () => {
    let url = ''
    const client = createHaiaClient({
      ...base,
      projectId: 'proj/with space',
      runtime: {
        fetch: (async (u: string) => {
          url = u
          return new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }))
        }) as unknown as typeof fetch,
        storage: { get: () => null, set: () => {} },
        now: () => 0,
      },
    })

    await client.guard(facts())

    expect(url).toBe('https://api.haia.finance/v1/projects/proj%2Fwith%20space/policy/evaluate')
  })
})
