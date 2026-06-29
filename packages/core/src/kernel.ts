import type { TransactionContext } from '@haia/types'
import type { HaiaClient } from './client'
import { toCaip2 } from './normalize/chain'
import { decodeApproval } from './normalize/intent'
import { randomId } from './util'

/**
 * Переиспользуемое ядро перехвата. Многие embedded-кошельки (Privy/Dynamic/CDP/
 * Reown) экспонируют стандартный EIP-1193 provider → один wrapper покрывает их
 * разом, адаптеры остаются тонкими.
 */

export interface Eip1193RequestArgs {
  method: string
  params?: unknown[]
}

export interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>
}

interface RawTx {
  from?: string
  to?: string
  value?: string
  data?: string
}

const GATED_METHODS = new Set(['eth_sendTransaction', 'wallet_sendCalls'])

/**
 * Оборачивает EIP-1193 provider: гейтит отправку транзакций через policy, после
 * успешной отправки шлёт fire-and-forget аналитику.
 */
export function wrapEip1193Provider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: string | number,
): Eip1193Provider {
  return {
    async request(args: Eip1193RequestArgs): Promise<unknown> {
      if (!GATED_METHODS.has(args.method)) {
        return provider.request(args)
      }
      const ctx = buildContext(args, chainId)
      const verdict = await client.guard(ctx)
      if (verdict.decision === 'rejected') {
        throw new Error(`haia: transaction blocked (${verdict.reasons?.join(', ') ?? 'policy'})`)
      }
      const result = await provider.request(args)
      client.track(ctx.eventType, { decision: verdict.decision, chain: ctx.chain })
      return result
    },
  }
}

function buildContext(args: Eip1193RequestArgs, chainId: string | number): TransactionContext {
  const tx = (args.params?.[0] ?? {}) as RawTx
  const approval = decodeApproval(tx.data)
  return {
    clientEventId: randomId(),
    eventType: approval ? 'token_approval' : 'transfer_intent',
    chain: toCaip2(chainId),
    from: tx.from ?? '',
    to: tx.to,
    amountRaw: tx.value ? BigInt(tx.value).toString() : undefined,
    spender: approval?.spender,
    isUnlimitedApproval: approval?.isUnlimitedApproval,
    method: approval?.method,
  }
}
