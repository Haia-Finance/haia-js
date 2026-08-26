import type { Facts, HaiaClient, Verdict } from '@haia/core'
import type { Transport } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import { haiaTransport } from './transport'

function fakeClient() {
  const guard = vi.fn(
    async (_facts: Facts): Promise<Verdict> => ({
      decision: 'approved',
      decisionId: 'd',
    }),
  )
  const track = vi.fn()
  return { client: { guard, track } as unknown as HaiaClient, guard }
}

function fakeTransport(request: ReturnType<typeof vi.fn>): Transport {
  return (() => ({
    config: { key: 'fake', name: 'fake', type: 'fake', request },
    request,
    value: undefined,
  })) as unknown as Transport
}

describe('haiaTransport', () => {
  it('gates eth_sendTransaction through the client and forwards on approval', async () => {
    const { client, guard } = fakeClient()
    const innerRequest = vi.fn(async () => '0xhash')
    const t = haiaTransport(fakeTransport(innerRequest), client)
    const instance = t({ chain: { id: 1 } } as Parameters<Transport>[0])

    await instance.request({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1' }] })

    expect(guard.mock.calls.length).toBe(1)
    expect(guard.mock.calls[0]?.[0]?.meta.chain).toBe('eip155:1')
    expect(innerRequest.mock.calls.length).toBe(1)
  })

  it('throws when no chain is available', () => {
    const { client } = fakeClient()
    const t = haiaTransport(fakeTransport(vi.fn()), client)
    expect(() => t({} as Parameters<Transport>[0])).toThrow(/requires a chain/)
  })
})
