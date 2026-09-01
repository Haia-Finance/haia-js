---
'@haia/types': minor
'@haia/core': minor
'@haia/wagmi': minor
---

Move to the policy/evaluate wire contract.

**Breaking (before the first npm release):**

- `TransactionContext` → `Facts {clientEventId, typeKey, meta}`. The envelope is flat, `typeKey` is a string instead of a closed `EventType` enum, and domain fields move into a flat `meta` following the conventions dictionary.
- `Verdict.ttlMs` is gone, along with verdict caching: every gate is a real call, and every intent is journalled server-side.
- Config: `serverApiKey` + `ingestToken` are replaced by a single `publishableKey`; `failMode` is now `{default?, byTypeKey?}`.
- The policy endpoint is per project: `POST /v1/projects/{projectId}/policy/evaluate`. Ingest is `POST /v1/batch`, with identity on every element of the batch.
- `PolicyEngine` → `PolicyClient` (the name `Engine` belongs to the server-side policy engine).

**New:**

- `HaiaPolicyError` plus the `onBlocked` / `onFlagged` hooks. `guard()` throws on `rejected`; `flagged` proceeds.
- `asHaiaPolicyError(err)` recognises a block through wrapper stacks — viem wraps a transport error in `TransactionExecutionError`, so a bare `instanceof` will not match.
- Verdicts are validated: a 200 with an unrecognised body is treated as unavailability and goes to fail-mode, not as permission.
- The default latency budget is 400 ms, realistic for a cross-region browser round trip (it was 80 ms).
- Analytics is deduplicated by `clientEventId`, with retries and backoff.
