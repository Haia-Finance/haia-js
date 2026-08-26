import type { HaiaClient } from '@haia/core'
import { type Eip1193Provider, wrapEip1193Provider } from '@haia/evm'
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
 *
 * ⚠️ Оборачивается ТОЛЬКО переданный коннектор — обернуть то, чего вызывающий
 * не создавал, эта функция не может. А wagmi создаёт коннекторы сам: при
 * `multiInjectedProviderDiscovery` (дефолт — `true`) он заводит по коннектору на
 * каждый кошелёк, объявившийся через EIP-6963, и дописывает их в
 * `config.connectors` мимо любых обёрток — в том числе позже, по подписке на
 * новые объявления. Отправка через такой коннектор уходит в кошелёк без гейта.
 *
 * Один необёрнутый вход сводит гейт к необязательному: пользователю достаточно
 * выбрать соседний пункт в меню подключения. Поэтому автопоиск выключают, а
 * список кошельков задают явно — каждый через свою обёртку:
 *
 *   createConfig({
 *     connectors: [
 *       haiaConnector(injected({ target: 'metaMask' }), client),
 *       haiaConnector(injected({ target: 'coinbaseWallet' }), client),
 *     ],
 *     multiInjectedProviderDiscovery: false,
 *   })
 *
 * Дедуп по `rdns` (wagmi пропускает найденный кошелёк, если такой rdns уже есть
 * в списке) закрыть эту дыру не помогает: у `injected()` поля `rdns` нет, так
 * что совпасть нечему.
 *
 * ⚠️ Коннектор, реализующий необязательный `getClient()`, не гейтится в
 * принципе: wagmi в этом случае не вызывает `getProvider`. Такой коннектор
 * отвергается на месте — см. `assertGateable`.
 */
export function haiaConnector(
  connectorFn: CreateConnectorFn,
  client: HaiaClient,
  options: HaiaConnectorOptions = {},
): CreateConnectorFn {
  return ((config: Parameters<CreateConnectorFn>[0]) => {
    const connector = connectorFn(config) as Connector
    assertGateable(connector)
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

/**
 * Коннектор с собственным `getClient` этой обёрткой не гейтится — и молчать об
 * этом нельзя.
 *
 * `getConnectorClient` в `@wagmi/core` устроен так:
 *
 *   if (connector.getClient) return connector.getClient({ chainId })
 *   // иначе — getProvider() + custom(provider)
 *
 * То есть у такого коннектора `getProvider` не вызывается вовсе, и подмена
 * провайдера — единственное, что мы делаем, — не наступает ни разу. Отправка
 * ушла бы в кошелёк без единого вызова `/evaluate`.
 *
 * Молча починить нельзя. Убрать `getClient` из обёртки, чтобы wagmi свалился на
 * гейченный `getProvider`, — значит подменить клиент кошелька на дефолтный: для
 * smart-account коннекторов это потеря их собственных действий (ERC-4337 и
 * прочее), то есть тихая поломка отправки. Обернуть уже собранный viem Client
 * тоже нельзя: его действия связаны с исходным `request` в момент создания, и
 * подмена `.request` на копии их не затрагивает.
 *
 * Поэтому — явный отказ на этапе сборки конфига, а не сюрприз в проде. Такому
 * коннектору нужен гейт уровня действия: `client.guard(facts)` перед вызовом
 * кошелька.
 */
function assertGateable(connector: Connector): void {
  if (typeof (connector as { getClient?: unknown }).getClient !== 'function') return
  throw new Error(
    `haia: connector "${connector.id}" implements getClient(), so wagmi never calls getProvider() ` +
      'and this wrapper cannot gate it. Gate the action before it reaches the wallet with ' +
      'client.guard(facts) instead of wrapping the connector.',
  )
}

function toChainId(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    const n = value.startsWith('0x') ? hexToNumber(value as Hex) : Number(value)
    return Number.isFinite(n) ? n : undefined
  }
  return undefined
}
