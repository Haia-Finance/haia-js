import type { Facts, HaiaClient, Verdict } from '@haia/core'
import type { CreateConnectorFn } from '@wagmi/core'
import { describe, expect, it, vi } from 'vitest'
import { haiaConnector } from './connector'

type GatedProvider = {
  request: (a: { method: string; params?: unknown[] }) => Promise<unknown>
}

describe('haiaConnector', () => {
  it('wraps getProvider so transactions are gated and other methods survive', async () => {
    const guard = vi.fn(async () => ({ decision: 'approved' as const, decisionId: 'd' }))
    const client = { guard, track: vi.fn() } as unknown as HaiaClient
    const innerRequest = vi.fn(async (args: { method: string }) =>
      args.method === 'eth_chainId' ? '0x1' : '0xhash',
    )
    const on = vi.fn()
    const baseProvider = { request: innerRequest, on }
    const connectorFn = (() => ({
      id: 'x',
      name: 'X',
      type: 'x',
      getProvider: async () => baseProvider,
    })) as unknown as CreateConnectorFn

    const connector = haiaConnector(connectorFn, client)({} as Parameters<CreateConnectorFn>[0])
    const provider = (await connector.getProvider()) as {
      request: (a: { method: string; params?: unknown[] }) => Promise<unknown>
      on: unknown
    }

    await provider.request({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1' }] })

    expect(guard.mock.calls.length).toBe(1)
    // Proxy сохраняет событийные методы провайдера.
    expect(typeof provider.on).toBe('function')
  })

  it('resolves chainId once and follows chainChanged', async () => {
    const guard = vi.fn(
      async (_facts: Facts): Promise<Verdict> => ({
        decision: 'approved',
        decisionId: 'd',
      }),
    )
    const client = { guard, track: vi.fn() } as unknown as HaiaClient
    let chainHandler: ((p: unknown) => void) | undefined
    let chainIdCalls = 0
    const request = vi.fn(async (a: { method: string }) => {
      if (a.method === 'eth_chainId') {
        chainIdCalls += 1
        return '0x1'
      }
      return '0xok'
    })
    const baseProvider = {
      request,
      on: (_event: string, handler: (p: unknown) => void) => {
        chainHandler = handler
      },
    }
    const connectorFn = (() => ({
      id: 'x',
      name: 'X',
      type: 'x',
      getProvider: async () => baseProvider,
    })) as unknown as CreateConnectorFn

    const connector = haiaConnector(connectorFn, client)({} as Parameters<CreateConnectorFn>[0])
    const p1 = (await connector.getProvider()) as GatedProvider
    const p2 = (await connector.getProvider()) as GatedProvider
    expect(chainIdCalls).toBe(1) // resolved once, cached across getProvider calls

    await p1.request({ method: 'eth_sendTransaction', params: [{ to: '0xr' }] })
    expect(guard.mock.calls[0]?.[0]?.meta.chain).toBe('eip155:1')

    chainHandler?.('0x89') // wallet switches to Polygon
    await p2.request({ method: 'eth_sendTransaction', params: [{ to: '0xr' }] })
    expect(guard.mock.calls[1]?.[0]?.meta.chain).toBe('eip155:137')
  })

  it('refuses a connector that implements getClient', () => {
    // getConnectorClient в @wagmi/core отдаёт connector.getClient() и не
    // вызывает getProvider вовсе — подменять было бы нечего, и отправка ушла бы
    // в кошелёк без единого /evaluate. Отказ на этапе сборки конфига.
    const client = { guard: vi.fn(), track: vi.fn() } as unknown as HaiaClient
    const connectorFn = (() => ({
      id: 'smart-account',
      name: 'Smart Account',
      type: 'x',
      getProvider: async () => ({ request: async () => null }),
      getClient: async () => ({}),
    })) as unknown as CreateConnectorFn

    expect(() =>
      haiaConnector(connectorFn, client)({} as Parameters<CreateConnectorFn>[0]),
    ).toThrow(/getClient/)
  })
})
