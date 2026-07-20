import type { HaiaClient } from '@haia/core'
import { buildFacts, type Eip1193RequestArgs } from './facts'
import { GATED_METHODS } from './methods'

/**
 * Переиспользуемое ядро перехвата EVM-семейства. Многие embedded-кошельки
 * (Privy/Dynamic/CDP/Reown) экспонируют стандартный EIP-1193 provider → один
 * wrapper покрывает их разом, адаптеры остаются тонкими.
 */

export type { Eip1193RequestArgs } from './facts'

export interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>
}

/** chainId фиксированным значением или резолвером (для live-сетей: chainChanged). */
type ChainIdSource = string | number | (() => string | number)

/**
 * Оборачивает EIP-1193 provider: гейтит отправку транзакций и подпись typed-data
 * через policy, после успеха шлёт fire-and-forget аналитику. Батч (wallet_sendCalls)
 * оценивается покалльно — если хоть один call отклонён, `guard` бросает
 * `HaiaPolicyError` и весь запрос не уходит в кошелёк.
 *
 * Клиент НЕ решает, гейтится ли действие: всё перехваченное уходит на сервер,
 * негейченное получает быстрый `approved (not_gated)`.
 */
export function wrapEip1193Provider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: ChainIdSource,
): Eip1193Provider {
  const resolveChainId = (): string | number =>
    typeof chainId === 'function' ? chainId() : chainId

  // Прозрачно прокидываем ВСЕ аргументы (viem передаёт вторым options:
  // dedupe/retryCount/uid), чтобы не терять их на gated/passthrough вызовах.
  const forward = provider.request.bind(provider) as (...args: unknown[]) => Promise<unknown>

  const request = (async (...args: unknown[]) => {
    const reqArgs = (args[0] ?? {}) as Eip1193RequestArgs
    if (!GATED_METHODS.has(reqArgs.method)) {
      return forward(...args)
    }
    // Отклонение любого из фактов бросит HaiaPolicyError наружу — до forward
    // дело не дойдёт, подпись не запрашивается.
    //
    // Без подсказки failMode: все ключи семейства уже в таблице конвенций ядра
    // (DEFAULT_FAIL_MODE_BY_TYPE_KEY) — дублировать её здесь значило бы завести
    // второй источник правды.
    const evaluated = await Promise.all(
      buildFacts(reqArgs, resolveChainId()).map(async (facts) => ({
        facts,
        verdict: await client.guard(facts),
      })),
    )
    const result = await forward(...args)
    for (const { facts, verdict } of evaluated) {
      client.track(
        facts.typeKey,
        { decision: verdict.decision, chain: facts.meta.chain },
        facts.clientEventId,
      )
    }
    return result
  }) as Eip1193Provider['request']

  // Proxy сохраняет остальной интерфейс провайдера (on/removeListener/…),
  // подменяя только request. Важно:
  //  - Reflect.get без receiver → геттеры исполняются с this=target, иначе
  //    приватные поля (#field) класс-провайдеров бросают TypeError;
  //  - кэш связанных методов → стабильная идентичность (provider.on === provider.on),
  //    иначе removeListener не находит обработчик и подписки текут.
  const boundMethods = new Map<PropertyKey, unknown>()
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      let bound = boundMethods.get(prop)
      if (bound === undefined) {
        bound = value.bind(target)
        boundMethods.set(prop, bound)
      }
      return bound
    },
  })
}
