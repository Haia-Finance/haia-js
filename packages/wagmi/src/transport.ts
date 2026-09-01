import type { HaiaClient } from '@haia/core'
import { type Eip1193Provider, wrapEip1193Provider } from '@haia/evm'
import type { EIP1193RequestFn, Transport } from 'viem'

export interface HaiaTransportOptions {
  /** Chain id, for when the client has no `chain` set. */
  chainId?: number
}

/**
 * A viem `Transport` decorator: gates transactions and signatures through
 * policy without changing the rest of the transport composition. It uses only
 * viem types (a required peer).
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
