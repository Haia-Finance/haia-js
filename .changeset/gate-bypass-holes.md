---
'@haia/core': minor
'@haia/evm': minor
'@haia/wagmi': minor
---

Close two undeclared ways around the gate, plus contract fixes.

**A connector with `getClient()` is rejected rather than half-gated.** `getConnectorClient` in `@wagmi/core` is written as `if (connector.getClient) return connector.getClient({chainId})` — for such a connector `getProvider` is never called, and replacing the provider is all `haiaConnector` does. Sends would reach the wallet without a single `/evaluate`, silently, and precisely for the embedded wallets (Privy/Dynamic/CDP) the layer was written for. It cannot be fixed invisibly: dropping `getClient` from the wrapper would swap a smart-account client for the default one and lose ERC-4337 actions, and wrapping an already-built viem Client is too late — its actions are bound to the original `request` at creation. So the config build now fails explicitly and points at `client.guard(facts)`.

**`send` / `sendAsync` on a guarded provider are rejected.** The proxy replaced `request` only and handed back the other functions bound to the original provider. MetaMask and Coinbase Wallet still expose these legacy transports, web3.js 1.x and the ethers v5 fallback path use them, and the same `eth_sendTransaction` goes through them. Gating them "as well" would not be honest: `send` has two incompatible signatures and `sendAsync` an error-first callback with a JSON-RPC envelope. Guessing the shape on the money path costs more than refusing.

**`meta.selector` is lowercased.** `decodeApproval` matched selectors already lowercased and `selectorOf` did not, so the same transaction with calldata `0x095EA7B3…` produced `isUnlimitedApproval: true` next to `selector: '0x095EA7B3'`, and a policy rule written against the canonical selector never matched it.

**Fail-mode tables are read by own keys only.** `typeKey` is an arbitrary string by contract, so `typeKey: 'toString'` resolved up the prototype chain: the integrator's config was ignored and an `Object.prototype` function ended up in `reasons`.

**Cold-path events carry the `timestamp` of the event.** Without it a Segment-compatible receiver dates them at receipt, and between the event and receipt lie the flush interval (5 s) and retries with backoff — which reorders events relative to other batches.

**`onFlagged` is documented as a notification, not a step-up.** The hook is synchronous, an exception from it is swallowed, and the action reaches the wallet immediately after it returns: a confirmation cannot be built on it, because the wallet window opens before the user can answer.
