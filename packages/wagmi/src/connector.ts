import { type Eip1193Provider, type HaiaClient, wrapEip1193Provider } from '@haia/core'
import type { Connector, CreateConnectorFn } from '@wagmi/core'
import { type Hex, hexToNumber } from 'viem'

export interface HaiaConnectorOptions {
  /** Chain id; иначе резолвится из провайдера и обновляется по chainChanged. */
  chainId?: number
}

interface EventfulProvider extends Eip1193Provider {
  on?: (event: string, handler: (payload: unknown) => void) => void
}

/**
 * Оборачивает wagmi-коннектор: его `getProvider` отдаёт guarded-провайдер
 * (policy + аналитика), сохраняя подписки на события. chainId резолвится один
 * раз и обновляется по `chainChanged` — без RPC-round-trip на каждый getProvider.
 * Типы из `@wagmi/core` (optional peer — нужен только для этого хелпера).
 */
export function haiaConnector(
  connectorFn: CreateConnectorFn,
  client: HaiaClient,
  options: HaiaConnectorOptions = {},
): CreateConnectorFn {
  return ((config: Parameters<CreateConnectorFn>[0]) => {
    const connector = connectorFn(config) as Connector
    let chainId = options.chainId
    let subscribed = false
    return {
      ...connector,
      async getProvider(getProviderParams?: { chainId?: number }) {
        const provider = (await connector.getProvider(getProviderParams)) as EventfulProvider
        if (chainId === undefined) {
          chainId = toChainId(await provider.request({ method: 'eth_chainId' }))
        }
        if (!subscribed && typeof provider.on === 'function') {
          subscribed = true
          provider.on('chainChanged', (payload) => {
            const next = toChainId(payload)
            if (next !== undefined) chainId = next
          })
        }
        return wrapEip1193Provider(provider, client, () => {
          if (chainId === undefined) {
            throw new Error('haia: could not resolve chainId from the wallet provider')
          }
          return chainId
        })
      },
    }
  }) as CreateConnectorFn
}

function toChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const n = value.startsWith('0x') ? hexToNumber(value as Hex) : Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
