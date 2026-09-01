import type { HaiaClient } from '@haia/core'
import { type Eip1193Provider, wrapEip1193Provider } from '@haia/evm'
import type { Connector, CreateConnectorFn } from '@wagmi/core'
import { type Hex, hexToNumber } from 'viem'

export interface HaiaConnectorOptions {
  /** Chain id; otherwise resolved from the provider and updated on chainChanged. */
  chainId?: number
}

interface EventfulProvider extends Eip1193Provider {
  on?: (event: string, handler: (payload: unknown) => void) => void
}

/**
 * Wraps a wagmi connector so its `getProvider` returns a guarded provider
 * (policy plus analytics) while keeping event subscriptions intact. The chainId
 * is resolved once and updated on `chainChanged`, with no RPC round trip per
 * getProvider. The types come from `@wagmi/core` (an optional peer, needed only
 * for this helper).
 *
 * ⚠️ ONLY the connector passed in is wrapped — this function cannot wrap what
 * the caller never created. And wagmi creates connectors itself: with
 * `multiInjectedProviderDiscovery` (default `true`) it adds one connector per
 * wallet announced over EIP-6963 and appends them to `config.connectors` around
 * any wrapper — including later, through its subscription to new announcements.
 * A send through such a connector reaches the wallet ungated.
 *
 * One unwrapped entry makes the gate optional: the user need only pick the
 * neighbouring item in the connect menu. So discovery is turned off and the list
 * of wallets is given explicitly, each through its own wrapper:
 *
 *   createConfig({
 *     connectors: [
 *       haiaConnector(injected({ target: 'metaMask' }), client),
 *       haiaConnector(injected({ target: 'coinbaseWallet' }), client),
 *     ],
 *     multiInjectedProviderDiscovery: false,
 *   })
 *
 * Deduplication by `rdns` (wagmi skips a discovered wallet if that rdns is
 * already in the list) does not close this hole: `injected()` has no `rdns`
 * field, so there is nothing to match.
 *
 * ⚠️ A connector implementing the optional `getClient()` cannot be gated at all:
 * in that case wagmi never calls `getProvider`. Such a connector is rejected on
 * the spot — see `assertGateable`.
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
 * A connector with its own `getClient` is not gated by this wrapper — and that
 * cannot be passed over in silence.
 *
 * `getConnectorClient` in `@wagmi/core` is written like this:
 *
 *   if (connector.getClient) return connector.getClient({ chainId })
 *   // otherwise — getProvider() + custom(provider)
 *
 * So for such a connector `getProvider` is never called, and replacing the
 * provider — the only thing we do — never happens. The send would reach the
 * wallet without a single `/evaluate` call.
 *
 * It cannot be fixed silently. Dropping `getClient` from the wrapper so wagmi
 * falls back to the gated `getProvider` would swap the wallet's client for the
 * default one: for smart-account connectors that loses their own actions
 * (ERC-4337 and the rest), which is a silent break of sending. Wrapping an
 * already-built viem Client is no good either: its actions are bound to the
 * original `request` at creation, and replacing `.request` on a copy does not
 * touch them.
 *
 * Hence an explicit refusal while the config is being built, rather than a
 * surprise in production. Such a connector needs an action-level gate:
 * `client.guard(facts)` before the wallet call.
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
