import type { HaiaClient } from '@haia/core'
import { type Eip1193Provider, wrapEip1193Provider } from '@haia/evm'
import type { EIP1193RequestFn, Transport } from 'viem'

export interface HaiaTransportOptions {
  /** Chain id, если у клиента не задан `chain`. */
  chainId?: number
}

/**
 * Декоратор viem `Transport`: гейтит транзакции/подписи через policy, не меняя
 * остальную композицию транспортов. Использует только типы viem (required peer).
 *
 *   createWalletClient({ chain, transport: haiaTransport(custom(provider), client) })
 */
export function haiaTransport(
  inner: Transport,
  client: HaiaClient,
  options: HaiaTransportOptions = {},
): Transport {
  return (params) => {
    const transport = inner(params)
    const chainId = options.chainId ?? params.chain?.id
    if (chainId === undefined) {
      throw new Error(
        'haia: haiaTransport requires a chain — set `chain` on the viem client or pass options.chainId',
      )
    }
    const guarded = wrapEip1193Provider(
      { request: transport.request as unknown as Eip1193Provider['request'] },
      client,
      chainId,
    )
    return {
      ...transport,
      request: guarded.request as unknown as EIP1193RequestFn,
    }
  }
}
