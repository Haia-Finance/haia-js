import { asClientEventId, createHaiaClient } from '@haia/core'
import type { CreateConnectorFn } from '@wagmi/core'
import type { Transport } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { haiaConnector } from './connector'
import { haiaTransport } from './transport'

/**
 * Идентичность подмешивается в ядре, поэтому все уровни врезки обязаны
 * получать её даром. Проверяем это на настоящем `HaiaClient`, а не на моке
 * `guard`: мок пропустил бы ровно ту регрессию, ради которой тест написан —
 * забытую врезку на одном из трёх путей.
 */

const TX = [{ from: '0xf', to: '0xr', value: '0x2386f26fc10000' }]

function harness() {
  const store = new Map<string, string>()
  const envelopes: Record<string, unknown>[] = []
  const client = createHaiaClient({
    projectId: 'proj_1',
    publishableKey: 'pk_1',
    baseUrl: 'https://api',
    runtime: {
      fetch: (async (url: string, init: { body?: string }) => {
        if (url.includes('/policy/evaluate')) envelopes.push(JSON.parse(init.body ?? '{}'))
        return new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), {
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
  client.identify('u_42')
  const metaOf = (n = 0) => envelopes[n]?.meta as Record<string, unknown>
  return { client, metaOf, envelopes }
}

function fakeTransport(request: ReturnType<typeof vi.fn>): Transport {
  return (() => ({
    config: { key: 'fake', name: 'fake', type: 'fake', request },
    request,
    value: undefined,
  })) as unknown as Transport
}

function expectIdentity(meta: Record<string, unknown>): void {
  expect(meta.userId).toBe('u_42')
  expect(meta.anonymousId).toEqual(expect.any(String))
}

describe('identity доезжает до конверта на всех трёх уровнях врезки', () => {
  it('transport-level (haiaTransport)', async () => {
    const { client, metaOf } = harness()
    const instance = haiaTransport(
      fakeTransport(vi.fn(async () => '0xhash')),
      client,
    )({ chain: { id: 1 } } as Parameters<Transport>[0])

    await instance.request({ method: 'eth_sendTransaction', params: TX })

    expectIdentity(metaOf())
  })

  it('action-level (haiaConnector)', async () => {
    const { client, metaOf } = harness()
    const connectorFn = (() => ({
      id: 'x',
      name: 'X',
      type: 'x',
      getProvider: async () => ({
        request: async (a: { method: string }) => (a.method === 'eth_chainId' ? '0x1' : '0xhash'),
      }),
    })) as unknown as CreateConnectorFn
    const connector = haiaConnector(connectorFn, client)({} as Parameters<CreateConnectorFn>[0])
    const provider = (await connector.getProvider()) as {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>
    }

    await provider.request({ method: 'eth_sendTransaction', params: TX })

    expectIdentity(metaOf())
  })

  it('ручной guard(facts)', async () => {
    const { client, metaOf } = harness()

    await client.guard({
      clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7W2'),
      typeKey: 'transfer_intent',
      meta: { chain: 'eip155:1' },
    })

    expectIdentity(metaOf())
  })

  it('anonymousId один и тот же на всех путях одного клиента', async () => {
    // Разойдись он между уровнями — сервер не склеил бы воронку «намерение →
    // вердикт → исполнение», не выдав при этом ни одной ошибки.
    const { client, metaOf } = harness()
    const instance = haiaTransport(
      fakeTransport(vi.fn(async () => '0xhash')),
      client,
    )({ chain: { id: 1 } } as Parameters<Transport>[0])

    await instance.request({ method: 'eth_sendTransaction', params: TX })
    await client.guard({
      clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7W3'),
      typeKey: 'transfer_intent',
      meta: {},
    })

    expect(metaOf(1).anonymousId).toBe(metaOf(0).anonymousId)
  })
})
