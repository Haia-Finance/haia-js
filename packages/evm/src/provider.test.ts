import type { HaiaClient } from '@haia/core'
import { HaiaPolicyError } from '@haia/core'
import type { Facts, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import { type Eip1193Provider, wrapEip1193Provider } from './provider'

/** Мимикрирует фасад: на rejected `guard` бросает, а не возвращает вердикт. */
function fakeClient(decision: Verdict['decision'] = 'approved') {
  const guard = vi.fn(async (facts: Facts): Promise<Verdict> => {
    const verdict: Verdict = { decision, decisionId: 'd', reasons: ['test'] }
    if (decision === 'rejected') throw new HaiaPolicyError(verdict, facts)
    return verdict
  })
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
    const approve = guard.mock.calls[0]?.[0]
    expect(approve?.typeKey).toBe('token_approval')
    expect(approve?.meta.isUnlimitedApproval).toBe(true)
    expect(approve?.meta.selector).toBe('0x095ea7b3')
    const transfer = guard.mock.calls[1]?.[0]
    expect(transfer?.typeKey).toBe('transfer_intent')
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

    const permit = guard.mock.calls[0]?.[0]
    expect(permit?.typeKey).toBe('token_approval')
    expect(permit?.meta.spender).toBe('0xspender')
    expect(permit?.meta.isUnlimitedApproval).toBe(true)
  })

  it('labels a plain contract call as contract_call, not transfer_intent', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({
      method: 'eth_sendTransaction',
      params: [{ to: '0xcontract', data: '0xdeadbeef' }],
    })

    expect(guard.mock.calls[0]?.[0]?.typeKey).toBe('contract_call')
  })

  it('blocks and does not forward when policy rejects', async () => {
    const { client } = fakeClient('rejected')
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await expect(
      wrapped.request({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1' }] }),
    ).rejects.toBeInstanceOf(HaiaPolicyError)
    expect(request.mock.calls.length).toBe(0)
  })

  it('gates eth_signTransaction — signing is where the money is committed', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xsigned')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({
      method: 'eth_signTransaction',
      params: [{ to: '0xtoken', data: APPROVE_UNLIMITED }],
    })

    expect(guard.mock.calls.length).toBe(1)
    expect(guard.mock.calls[0]?.[0]?.typeKey).toBe('token_approval')
  })

  it('does NOT gate eth_sendRawTransaction (HAD-333 decision)', async () => {
    // Транзакция уже подписана: гейт здесь предотвращает только бродкаст, а
    // подписанную транзакцию можно отправить в любой публичный RPC мимо нас.
    // См. обоснование в methods.ts — если решение меняется, падает этот тест.
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({ method: 'eth_sendRawTransaction', params: ['0xf86c...'] })

    expect(guard.mock.calls.length).toBe(0)
    expect(request.mock.calls.length).toBe(1)
  })

  it('does not gate personal_sign (not the protocol money surface)', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xsig')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({ method: 'personal_sign', params: ['0xdeadbeef', '0xacc'] })

    expect(guard.mock.calls.length).toBe(0)
  })

  it('passes through non-gated methods untouched', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => ['0xacc'])
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await wrapped.request({ method: 'eth_accounts' })

    expect(guard.mock.calls.length).toBe(0)
    expect(request.mock.calls.length).toBe(1)
  })

  it('does not throw on a malformed value and omits amountRaw', async () => {
    const { client, guard } = fakeClient()
    const request = vi.fn(async () => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)

    await expect(
      wrapped.request({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0xZZ' }] }),
    ).resolves.toBe('0xhash')
    expect(guard.mock.calls[0]?.[0]?.meta.amountRaw).toBeUndefined()
  })

  it('forwards extra request arguments (viem options) to the provider', async () => {
    const { client } = fakeClient()
    const request = vi.fn(async (..._args: unknown[]) => '0xhash')
    const wrapped = wrapEip1193Provider({ request }, client, 1)
    const options = { dedupe: true }

    await (wrapped.request as (a: unknown, o?: unknown) => Promise<unknown>)(
      { method: 'eth_sendTransaction', params: [{ to: '0xr' }] },
      options,
    )

    expect(request.mock.calls[0]?.[1]).toBe(options)
  })

  it('preserves private-field getters and stable method identity on class providers', async () => {
    class ClassProvider {
      #chainHex = '0x1'
      listeners: Array<(p: unknown) => void> = []
      get chainId(): string {
        return this.#chainHex // throws TypeError if `this` is not a real instance
      }
      on(_event: string, handler: (p: unknown) => void): void {
        this.listeners.push(handler)
      }
      removeListener(_event: string, handler: (p: unknown) => void): void {
        this.listeners = this.listeners.filter((h) => h !== handler)
      }
      async request(): Promise<unknown> {
        return '0xok'
      }
    }
    const provider = new ClassProvider()
    const { client } = fakeClient()
    const wrapped = wrapEip1193Provider(
      provider as unknown as Eip1193Provider,
      client,
      1,
    ) as unknown as ClassProvider

    expect(() => wrapped.chainId).not.toThrow()
    expect(wrapped.chainId).toBe('0x1')
    expect(wrapped.on).toBe(wrapped.on) // stable identity across reads

    const handler = (): void => {}
    wrapped.on('chainChanged', handler)
    wrapped.removeListener('chainChanged', handler)
    expect(provider.listeners.length).toBe(0) // removeListener matched the same ref
  })
})
