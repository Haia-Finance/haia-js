---
'@haia/core': minor
'@haia/evm': minor
'@haia/wagmi': minor
---

Split the EVM family layer out of the kernel into `@haia/evm`.

The split is made before the first npm release, because afterwards it would be a breaking change. Universal machinery changes at the pace of our own contract; a family layer changes at the pace of someone else's ecosystem (new selectors, new EIPs). Glued into one package they cascade: an EVM decoder fix would bump the kernel and every consumer of it, including non-EVM ones.

- New package `@haia/evm`: `wrapEip1193Provider`, calldata decoders (approve / increaseAllowance / setApprovalForAll / permit), `toCaip2`, and normalization into flat facts. It depends on `@haia/core` through the public API; there is no dependency back the other way.
- `@haia/core` no longer contains EVM code. New: `newClientEventId()` — generating an action id lives in the kernel because it is a property of the wire contract, not of a particular family.
- `@haia/wagmi` is glue over `@haia/evm` only; provider SDKs stay in peer dependencies.
- The interception list was revised: `eth_signTransaction` is now gated (signing without broadcast is the same money surface, with the same parameter envelope). `eth_sendRawTransaction` is deliberately **not** gated — the reasoning is in `packages/evm/src/methods.ts` and the decision is pinned by a test.
