import { haiaConnector } from '@haia/wagmi/connector'
import { createConfig, http } from 'wagmi'
import { arbitrumSepolia, baseSepolia, sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { haia } from './haia'

/**
 * Тестовые сети намеренно: пример публичный и запускается незнакомым человеком
 * с реальным кошельком. Механика гейта от сети не зависит — чтобы посмотреть
 * на mainnet, достаточно поменять этот список и transports ниже.
 */
export const chains = [sepolia, baseSepolia, arbitrumSepolia] as const

/**
 * Вся интеграция — одна обёртка вокруг коннектора.
 *
 * `haiaConnector` подменяет у коннектора только `getProvider`: наружу уходит
 * тот же EIP-1193 провайдер, но `eth_sendTransaction` (и остальные методы из
 * `GATED_METHODS`) сперва проходят через policy. Поэтому ниже по коду ничего
 * не меняется — `useSendTransaction` остаётся обычным wagmi-хуком, и удалить
 * гейт из приложения можно, сняв ровно эту обёртку.
 *
 * chainId коннектор резолвит из провайдера сам и обновляет по `chainChanged`,
 * так что смена сети в кошельке доезжает до фактов без нашего участия.
 */
export const wagmiConfig = createConfig({
  chains,
  connectors: [haiaConnector(injected(), haia)],
  // ВАЖНО, и это не про пример, а про любую интеграцию: wagmi по умолчанию
  // сам добавляет коннекторы, найденные через EIP-6963. Они создаются
  // конфигом, а не нашим кодом, — значит, мимо обёртки, и отправка через такой
  // коннектор ушла бы в кошелёк без гейта. Один необёрнутый коннектор в списке
  // сводит гейт к необязательному: пользователь просто выбирает второй.
  // Поэтому автопоиск выключен, а список коннекторов задан явно.
  multiInjectedProviderDiscovery: false,
  transports: {
    [sepolia.id]: http(),
    [baseSepolia.id]: http(),
    [arbitrumSepolia.id]: http(),
  },
})

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig
  }
}
