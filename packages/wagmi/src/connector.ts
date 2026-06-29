import { type Eip1193Provider, type HaiaClient, wrapEip1193Provider } from '@haia/core'
import type { Connector, CreateConnectorFn } from '@wagmi/core'

export interface HaiaConnectorOptions {
  /** Chain id; иначе берётся из провайдера через eth_chainId. */
  chainId?: number
}

/**
 * Оборачивает wagmi-коннектор: его `getProvider` начинает возвращать
 * guarded-провайдер (policy + аналитика), сохраняя подписки на события.
 * Типы из `@wagmi/core` (optional peer — нужен только для этого хелпера).
 */
export function haiaConnector(
  connectorFn: CreateConnectorFn,
  client: HaiaClient,
  options: HaiaConnectorOptions = {},
): CreateConnectorFn {
  return ((config: Parameters<CreateConnectorFn>[0]) => {
    const connector = connectorFn(config) as Connector
    return {
      ...connector,
      async getProvider(getProviderParams?: { chainId?: number }) {
        const provider = (await connector.getProvider(getProviderParams)) as Eip1193Provider
        const chainId =
          options.chainId ?? hexToNumber(await provider.request({ method: 'eth_chainId' }))
        return wrapEip1193Provider(provider, client, chainId)
      },
    }
  }) as CreateConnectorFn
}

function hexToNumber(value: unknown): number {
  return typeof value === 'string' ? Number.parseInt(value, 16) : Number(value)
}
