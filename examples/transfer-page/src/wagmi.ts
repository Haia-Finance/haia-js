import { haiaConnector } from '@haia/wagmi/connector'
import { createConfig, http } from 'wagmi'
import { arbitrumSepolia, baseSepolia, sepolia } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'
import { haia } from './haia'

/**
 * Testnets on purpose: the example is public and gets opened by people with
 * real wallets. Gating does not depend on the network — to look at mainnet,
 * change this list and the transports below.
 */
export const chains = [sepolia, baseSepolia, arbitrumSepolia] as const

/**
 * The whole integration is one wrapper around the connector.
 *
 * `haiaConnector` replaces only `getProvider` on the connector: what comes out
 * is the same EIP-1193 provider, except that `eth_sendTransaction` (and the
 * other methods in `GATED_METHODS`) pass through policy first. So nothing
 * downstream changes — `useSendTransaction` stays an ordinary wagmi hook, and
 * the gate can be removed from the application by deleting this one wrapper.
 *
 * The connector resolves chainId from the provider itself and updates it on
 * `chainChanged`, so switching networks in the wallet reaches the facts with no
 * involvement from us.
 */
export const wagmiConfig = createConfig({
  chains,
  connectors: [haiaConnector(injected(), haia)],
  // IMPORTANT, and this is about any integration rather than this example: by
  // default wagmi adds connectors it discovers over EIP-6963 itself. They are
  // created by the config rather than by our code — that is, around the wrapper
  // — and a send through such a connector would reach the wallet ungated. One
  // unwrapped connector in the list makes the gate optional: the user simply
  // picks the other one. So discovery is off and the connector list is explicit.
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
