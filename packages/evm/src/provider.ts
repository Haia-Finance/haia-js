import type { HaiaClient } from '@haia/core'
import { buildFacts, type Eip1193RequestArgs } from './facts'
import { GATED_METHODS } from './methods'

/**
 * The reusable interception core of the EVM family. Many embedded wallets
 * (Privy/Dynamic/CDP/Reown) expose a standard EIP-1193 provider, so one wrapper
 * covers them all at once and the adapters stay thin.
 */

export interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>
}

/** chainId as a fixed value or as a resolver (for live networks: chainChanged). */
type ChainIdSource = string | number | (() => string | number)

/**
 * Wraps an EIP-1193 provider: gates transaction sends and typed-data signatures
 * through policy, and on success sends fire-and-forget analytics. A batch
 * (wallet_sendCalls) is evaluated per call — if any one call is rejected,
 * `guard` throws `HaiaPolicyError` and the whole request never reaches the
 * wallet.
 *
 * The client does NOT decide whether an action is gated: everything intercepted
 * goes to the server, and anything ungated gets a fast `approved (not_gated)`.
 */
export function wrapEip1193Provider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: ChainIdSource,
): Eip1193Provider {
  const resolveChainId = (): string | number =>
    typeof chainId === 'function' ? chainId() : chainId

  // Forward ALL arguments transparently (viem passes options second:
  // dedupe/retryCount/uid) so they are not lost on gated or passthrough calls.
  const forward = provider.request.bind(provider) as (...args: unknown[]) => Promise<unknown>

  const request = (async (...args: unknown[]) => {
    const reqArgs = (args[0] ?? {}) as Eip1193RequestArgs
    if (!GATED_METHODS.has(reqArgs.method)) {
      return forward(...args)
    }
    // A rejection of any of the facts throws HaiaPolicyError outward — the
    // forward is never reached and no signature is requested.
    //
    // No failMode hint: every key of this family is already in the kernel's
    // conventions table (DEFAULT_FAIL_MODE_BY_TYPE_KEY), and duplicating it
    // here would create a second source of truth.
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

  // The Proxy preserves the rest of the provider's interface
  // (on/removeListener/…) and replaces only request. Two things matter:
  //  - Reflect.get without a receiver, so getters run with this=target;
  //    otherwise the private fields (#field) of class providers throw
  //    TypeError;
  //  - a cache of bound methods, for stable identity (provider.on ===
  //    provider.on); otherwise removeListener cannot find the handler and
  //    subscriptions leak.
  const boundMethods = new Map<PropertyKey, unknown>()
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request
      if (
        LEGACY_RPC_METHODS.has(prop as string) &&
        typeof Reflect.get(target, prop) === 'function'
      ) {
        return legacyRefusal(prop as string)
      }
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

/**
 * The legacy transports of the same provider. MetaMask and Coinbase Wallet
 * still expose them, and web3.js 1.x and the ethers v5 fallback path use them.
 * The same `eth_sendTransaction` goes through them — that is, around the gate,
 * if they are simply forwarded.
 */
const LEGACY_RPC_METHODS: ReadonlySet<string> = new Set(['send', 'sendAsync'])

/**
 * Refusal instead of forwarding. Gating them "as well" cannot be done
 * honestly: `send` has two incompatible signatures living side by side
 * (`send(method, params)` in ethers v5 and `send(payload, callback)` in
 * web3.js 1.x), and `sendAsync` works through an error-first callback with a
 * JSON-RPC envelope. Guessing the shape on the money path costs more than
 * refusing: an error at integration time is cheaper than an undeclared way
 * around the gate in production.
 */
function legacyRefusal(name: string): () => never {
  return () => {
    throw new Error(
      `haia: ${name}() is not gated and is refused on a guarded provider — use request({ method, params }) (EIP-1193)`,
    )
  }
}
