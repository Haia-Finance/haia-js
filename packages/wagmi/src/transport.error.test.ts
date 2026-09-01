import { asHaiaPolicyError, type HaiaClient, HaiaPolicyError } from '@haia/core'
import { createWalletClient, custom } from 'viem'
import { mainnet } from 'viem/chains'
import { describe, expect, it, vi } from 'vitest'
import { haiaTransport } from './transport'

/**
 * The acceptance criterion for the outcome contract: an integrator has to be
 * able to tell a haia block from wallet errors in code. viem wraps transport
 * errors in classes of its own, so recognisability is checked through a REAL
 * viem client rather than on a bare kernel.
 */
describe('HaiaPolicyError through a real viem client', () => {
  function blockingClient(): HaiaClient {
    return {
      guard: vi.fn(async (facts) => {
        throw new HaiaPolicyError(
          { decision: 'rejected', decisionId: 'dec_1', reasons: ['unlimited_approval_blocked'] },
          facts,
        )
      }),
      track: vi.fn(),
    } as unknown as HaiaClient
  }

  it('stays recognisable to the partner after viem wrapping', async () => {
    const provider = {
      request: vi.fn(async (a: { method: string }) => {
        if (a.method === 'eth_chainId') return '0x1'
        if (a.method === 'eth_accounts') return [`0x${'1'.repeat(40)}`]
        return '0xhash'
      }),
    }
    const wallet = createWalletClient({
      chain: mainnet,
      transport: haiaTransport(custom(provider), blockingClient()),
    })

    const err = await wallet
      .sendTransaction({
        account: `0x${'1'.repeat(40)}`,
        to: `0x${'2'.repeat(40)}`,
        value: 1n,
        gas: 21_000n,
        nonce: 0,
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      })
      .catch((e: unknown) => e)

    // A bare instanceof does NOT work here: viem wraps it in
    // TransactionExecutionError, leaving the block in the cause chain.
    expect(err).not.toBeInstanceOf(HaiaPolicyError)
    const haia = asHaiaPolicyError(err)
    expect(haia).toBeInstanceOf(HaiaPolicyError)
    expect(haia?.reasons).toContain('unlimited_approval_blocked')
    expect(haia?.decisionId).toBe('dec_1')
    // The transaction never reached the wallet.
    expect(provider.request.mock.calls.every((c) => c[0]?.method !== 'eth_sendTransaction')).toBe(
      true,
    )
  })
})
