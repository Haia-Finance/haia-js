---
'@haia/types': minor
'@haia/core': minor
'@haia/evm': minor
'@haia/wagmi': minor
---

`clientEventId` is now a real ULID, `meta.amount` is populated, and cross-package invariants are pinned by tests.

**`clientEventId` is a ULID, not a UUID.** The SDK was sending `crypto.randomUUID()` while the contract specifies a ULID and requires the gateway to validate its shape — which would have meant a 4xx on every request and, since a 4xx is read as a configuration error, fail-closed across the whole money path. The implementation is dependency-free (~30 lines): 48 bits of time plus 80 bits of randomness, Crockford base32. The time prefix makes the journal sortable by key.

- `ClientEventId` is a branded type in `@haia/types`: a bare string will not reach the envelope.
- `newClientEventId()` generates one; `asClientEventId(value)` admits ids from elsewhere (manual guard, server-side sources) under the same bounds the gateway enforces — 1–64 chars, `[A-Za-z0-9_-]`. Ids are bounds-checked on the way in, never schema-checked.
- `randomId` (UUID) is gone; the analytics `anonymousId` is a ULID too, so the SDK has one id format rather than two.

**`meta.amount`.** Facts carried only `amountRaw`, though the conventions dictionary defines both forms — a policy rule written against `meta.amount` would silently never have matched. For a native transfer the decimals are known, so both forms are sent; for ERC-20 only `amountRaw` is available until there is a `transfer()` decoder.

**One copy of `@haia/core`.** It is now a peer dependency of `@haia/evm` and `@haia/wagmi`. Two copies of the kernel would mean two distinct `HaiaPolicyError` classes and an `asHaiaPolicyError` that returns `undefined` — exactly the failure the helper exists to prevent.

**Cross-package invariants are tests now.** `TYPE_KEYS ⊆ DEFAULT_FAIL_MODE_BY_TYPE_KEY` (a miss is a silent fail-open on money) and `GATED_METHODS ⊆ the branches of buildFacts` — the silent catch-all that passed another method's params off as `transfer_intent` is now an explicit error.
