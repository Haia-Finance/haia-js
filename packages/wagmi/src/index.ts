import { type Eip1193Provider, type HaiaClient, wrapEip1193Provider } from '@haia/core'

/**
 * Референс-адаптер. viem/wagmi-кошельки экспонируют EIP-1193 provider, поэтому
 * адаптер тонкий: вся policy/analytics-логика — в `@haia/core`.
 *
 * Использование:
 *   const client = createHaiaClient({ projectId, serverApiKey, ingestToken })
 *   const provider = haiaWrapProvider(walletProvider, client, chainId)
 *   // дальше отдать provider в createWalletClient({ transport: custom(provider) })
 */
export function haiaWrapProvider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: number,
): Eip1193Provider {
  return wrapEip1193Provider(provider, client, chainId)
}

export type { Eip1193Provider } from '@haia/core'
export { createHaiaClient, HaiaClient } from '@haia/core'
