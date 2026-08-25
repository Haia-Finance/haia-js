import type { Facts, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import { createHaiaClient } from './client'
import type { HaiaConfig } from './config'
import { HaiaPolicyError } from './errors'
import { asClientEventId } from './id'
import type { Runtime } from './runtime'

function facts(over: Partial<Facts> = {}): Facts {
  return {
    clientEventId: asClientEventId('01J9'),
    typeKey: 'token_approval',
    meta: { chain: 'eip155:1' },
    ...over,
  }
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
  it('ignores an explicitly-undefined override instead of erasing the URL', async () => {
    let url = ''
    const client = createHaiaClient({
      ...base,
      // Типичный источник: `endpoints: { policy: process.env.HAIA_POLICY_URL }`
      // с незаданной переменной.
      endpoints: { policy: undefined },
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

    expect(url).toBe('https://api.haia.finance/v1/projects/proj_1/policy/evaluate')
  })

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

describe('identity в конверте (HAD-340)', () => {
  /** Клиент на памяти, ловит тела и policy-, и ingest-запросов. */
  function harness() {
    const store = new Map<string, string>()
    const sent: { url: string; body: Record<string, unknown> }[] = []
    const client = createHaiaClient({
      ...base,
      baseUrl: 'https://api',
      runtime: {
        fetch: (async (url: string, init: { body?: string }) => {
          sent.push({ url, body: JSON.parse(init.body ?? '{}') })
          return new Response(JSON.stringify({ decision: 'approved', decisionId: 'dec_1' }), {
            status: 200,
          })
        }) as unknown as typeof fetch,
        storage: {
          get: (k) => store.get(k) ?? null,
          set: (k, v) => {
            store.set(k, v)
          },
        },
        now: () => 0,
      },
    })
    const policyMeta = () =>
      sent.find((s) => s.url.includes('/policy/evaluate'))?.body.meta as Record<string, unknown>
    const batchItems = () =>
      (sent.find((s) => s.url.endsWith('/v1/batch'))?.body.batch ?? []) as Record<string, unknown>[]
    return { client, policyMeta, batchItems }
  }

  it('подмешивает userId и anonymousId в ручной guard()', async () => {
    const { client, policyMeta } = harness()
    client.identify('u_42')

    await client.guard(facts())

    expect(policyMeta().userId).toBe('u_42')
    expect(policyMeta().anonymousId).toEqual(expect.any(String))
  })

  it('anonymousId конверта побайтово равен anonymous_id событий аналитики', async () => {
    // Главная ловушка задачи: сервер стыкует «намерение → вердикт →
    // исполнение» именно по этому идентификатору. Разойдись они — ни один
    // запрос не упадёт, просто воронка перестанет склеиваться.
    const { client, policyMeta, batchItems } = harness()

    await client.guard(facts())
    client.track('transfer_intent', { decision: 'approved' })
    await client.analytics.flush()

    const hot = policyMeta().anonymousId
    const cold = batchItems()[0]?.anonymousId
    expect(hot).toBeTypeOf('string')
    expect(cold).toBe(hot)
  })

  it('не перетирает явное значение партнёра', async () => {
    const { client, policyMeta } = harness()
    client.identify('u_from_sdk')

    await client.guard(facts({ meta: { chain: 'eip155:1', userId: 'u_from_partner' } }))

    expect(policyMeta().userId).toBe('u_from_partner')
  })

  it('не мутирует переданные facts', async () => {
    const { client } = harness()
    client.identify('u_42')
    const intent = facts()

    await client.guard(intent)

    // Партнёр получает свои facts обратно такими, какими передал, — в том
    // числе внутри HaiaPolicyError.
    expect(intent.meta).toEqual({ chain: 'eip155:1' })
  })

  it('до логина уходит один ключ, без ошибки', async () => {
    const { client, policyMeta } = harness()

    await client.guard(facts())

    expect(policyMeta().anonymousId).toEqual(expect.any(String))
    expect(policyMeta()).not.toHaveProperty('userId')
  })
})

describe('заблокированный localStorage (§6.7)', () => {
  it('createHaiaClient не падает, когда обращение к localStorage бросает', () => {
    // Chrome/Firefox с заблокированными сторонними куками и песочный iframe
    // кидают SecurityError на самом ЧТЕНИИ свойства — это не «его нет».
    // Голое обращение уронило бы конструктор, обещанный чистым.
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('SecurityError')
      },
    })
    try {
      expect(() => createHaiaClient(base)).not.toThrow()
    } finally {
      if (original) Object.defineProperty(globalThis, 'localStorage', original)
      else Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })
})
