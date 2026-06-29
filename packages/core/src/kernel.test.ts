import type { TransactionContext, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import type { HaiaClient } from './client'
import { wrapEip1193Provider } from './kernel'

function fakeClient(decision: Verdict['decision'] = 'approved') {
  const guard = vi.fn(
    async (_ctx: TransactionContext): Promise<Verdict> => ({
      decision,
      decisionId: 'd',
    }),
  )
  const track = vi.fn()
  const client = { guard, track } as unknown as HaiaClient
  return { client, guard, track }
}

const APPROVE_UNLIMITED = `0x095ea7b3${'0'.repeat(24)}${'a'.repeat(40)}${'f'.repeat(64)}`

describe('wrapEip1193Provider', () => {
  it('evaluates each call in a wallet_sendCalls batch', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({
      method: 'wallet_sendCalls',
      params: [
        {
          from: '0xfrom',
          calls: [
            { to: '0xtoken', data: APPROVE_UNLIMITED },
            { to: '0xrecipient', value: '0x1' },
          ],
        },
      ],
    })

    expect(guard.mock.calls.length).toBe(2)
    const approveCtx = guard.mock.calls[0]?.[0]
    expect(approveCtx?.eventType).toBe('token_approval')
    expect(approveCtx?.isUnlimitedApproval).toBe(true)
    const transferCtx = guard.mock.calls[1]?.[0]
    expect(transferCtx?.eventType).toBe('transfer_intent')
    expect(request.mock.calls.length).toBe(1)
  })

  it('gates an eth_signTypedData_v4 permit as token_approval', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xsig')
    const wrapped = wrapEip1193Provider({ request }, client, 1)
    const typed = JSON.stringify({
      primaryType: 'Permit',
      domain: { chainId: 1, verifyingContract: '0xtoken' },
      message: { spender: '0xspender', value: (2n ** 200n).toString() },
    })

    const owner = `0x${'1'.repeat(40)}`
    await wrapped.request({ method: 'eth_signTypedData_v4', params: [owner, typed] })

    const ctx = guard.mock.calls[0]?.[0]
    expect(ctx?.eventType).toBe('token_approval')
    expect(ctx?.spender).toBe('0xspender')
    expect(ctx?.isUnlimitedApproval).toBe(true)
  })

  it('labels a plain contract call as contract_call, not transfer_intent', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({
      method: 'eth_sendTransaction',
      params: [{ to: '0xcontract', data: '0xdeadbeef' }],
    })

    expect(guard.mock.calls[0]?.[0]?.eventType).toBe('contract_call')
  })

  it('blocks and does not forward when policy rejects', async () => {
    const { client } = fakeClient('rejected')
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await expect(
      wrapped.request({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1' }] }),
    ).rejects.toThrow(/blocked/)
    expect(request.mock.calls.length).toBe(0)
  })

  it('passes through non-gated methods untouched', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => ['0xacc'])
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({ method: 'eth_accounts' })

    expect(guard.mock.calls.length).toBe(0)
    expect(request.mock.calls.length).toBe(1)
  })
})
