---
'@haia/types': minor
'@haia/core': minor
---

The SDK attaches identity to the policy envelope automatically.

The control plane writes a `$policy_decision` event for every `evaluate` and lifts `meta.userId` / `meta.anonymousId` into columns of their own. An envelope without them is accepted exactly the same way — but no funnel sees the row (they all filter on `COALESCE(user_id, anonymous_id) IS NOT NULL`) and no erasure request ever reaches it. The cost is not a failure but silently incomplete numbers and a record that cannot be deleted, so the SDK attaches the keys rather than every integrator having to remember to.

- **There is one place it happens — `PolicyClient.evaluate`.** That covers every integration level at once: transport, connector and manual `guard(facts)`. It cannot be bypassed, which is the point: the reason to do this in the SDK is forgetting on one of the paths.
- **It fills in what is empty; it does not override.** An explicit `meta.userId` from the caller reaches the server unchanged, and the original `facts` are not mutated — you get them back (including inside `HaiaPolicyError`) exactly as you passed them.
- **`anonymousId` is the same one analytics uses.** `Identity` is one instance per client and both sides read from it, because that identifier is what the server uses to stitch intent → verdict → execution together.
- **Missing identity is not an error.** The envelope goes out as it is, with no exception, no block and no retry; one `console.debug` per session. The gate sits on the money path and must not fail over envelope shape.
- **`Identity` no longer throws and survives broken storage.** Unavailable storage used to throw out of `guard()` and `track()`; worse, touching `globalThis.localStorage` at all raises `SecurityError` when third-party cookies are blocked and inside a sandboxed iframe — so `createHaiaClient()` itself failed, a constructor documented as pure. The id now lives in session memory and stays stable. Writes are confirmed by reading back, because storage can also silently drop a write.
- **The shadow value takes priority over storage, and only when a write failed.** Otherwise `setUserId` after a quota overflow would never take effect: the user switches wallets and envelopes keep going out under the old `userId` — money actions attributed to the wrong person and rows the wrong erasure request would reach. In the normal case storage is read, so an edit from another tab is still visible.
- **Identity the caller set explicitly is not recomputed.** Reading `anonymousId` creates and persists one, and an integrator who gates with their own identity and no analytics would otherwise be given a permanent identifier they never asked for.
- **The dependency is narrowed to `IdentitySource`** (`meta(): IdentityMeta`): the policy client needs a snapshot, not a store.

The keys do **not** become required on the wire: the contract fixes exactly two required fields, and failing closed over envelope shape on the money path is not acceptable.

`@haia/types` gains `IdentityMeta` and `@haia/core` exports `IDENTITY_META_KEYS` — the one place the names are written as literals, checked against the contract fixtures by test.

Note on retries: a retry runs the pipeline again. The verdict and `reasons` match, `decisionId` does not — the stable correlation key is `clientEventId`.
