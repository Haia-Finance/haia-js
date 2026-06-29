import type { HaiaClient } from '@haia/core'
import type { CreateConnectorFn } from '@wagmi/core'
import { describe, expect, it, vi } from 'vitest'
import { haiaConnector } from './connector'

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
})
