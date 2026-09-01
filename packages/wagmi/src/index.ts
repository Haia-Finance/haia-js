import type { HaiaClient } from '@haia/core'
import { type Eip1193Provider, wrapEip1193Provider } from '@haia/evm'

/**
 * A low-level EIP-1193 provider wrapper — suitable for any wallet that exposes
 * a provider (injected included). For idiomatic viem see `haiaTransport`; for
 * wagmi, `haiaConnector` from `@haia/wagmi/connector`.
 *
 * `chainId` can be passed as a resolver (`() => number`) so the context follows
 * the wallet's current network.
 *
 *   const provider = haiaWrapProvider(walletProvider, client, chainId)
 *   createWalletClient({ transport: custom(provider) })
 */
export function haiaWrapProvider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: number | (() => number),
): Eip1193Provider {
  return wrapEip1193Provider(provider, client, chainId)
}

export { createHaiaClient, HaiaClient } from '@haia/core'
export type { Eip1193Provider } from '@haia/evm'
export { type HaiaTransportOptions, haiaTransport } from './transport'
