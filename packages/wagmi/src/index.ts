import { type Eip1193Provider, type HaiaClient, wrapEip1193Provider } from '@haia/core'

/**
 * Низкоуровневый враппер EIP-1193 provider — подходит любому кошельку, который
 * экспонирует provider (включая injected). Для идиоматичного viem см.
 * `haiaTransport`; для wagmi — `haiaConnector` из `@haia/wagmi/connector`.
 *
 * `chainId` можно передать резолвером (`() => number`), чтобы контекст следовал
 * за текущей сетью кошелька.
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

export type { Eip1193Provider } from '@haia/core'
export { createHaiaClient, HaiaClient } from '@haia/core'
export { type HaiaTransportOptions, haiaTransport } from './transport'
