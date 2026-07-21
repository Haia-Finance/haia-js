# Policy evaluate — wire contract fixtures (v1)

Executable form of the envelope and verdict contract in
[`docs/plans/haia-js-haia-cp-integration.md`](../../../docs/plans/haia-js-haia-cp-integration.md) §3.
The key names partners are expected to use inside `meta` are catalogued
separately in [`docs/guides/policy-meta-keys.md`](../../../docs/guides/policy-meta-keys.md).

## Why these live at the repo root

Two independent implementations have to agree on this contract: the control
plane that validates envelopes, and the browser SDK in `haia-js` that builds
them. When each side writes its own idea of a valid envelope into its own test
suite, the two drift and nothing notices until an end-to-end run — which is
both the slowest place to find it and the place where the symptom is furthest
from the cause.

So the fixtures are not backend test data that the SDK happens to borrow. They
are the artifact, and both sides are consumers:

- **haia-cp** (`backend/tests/unit/test_policy_wire_contract.py`) asserts the
  gateway accepts every `accepted: true` case and rejects every
  `accepted: false` one.
- **haia-js** (HAD-331) builds envelopes and checks them against the same
  files.
- **e2e smoke** (HAD-335) posts them at a live gateway.

A drift between the two implementations therefore fails a unit test in
whichever repo drifted, not an integration run.

## Layout

`index.json` is the manifest — it names every case file and, for envelopes,
whether the gateway must accept it. Iterate that rather than globbing the
directories, so a new fixture without a declared expectation is a loud error
instead of a silently unchecked file.

```
index.json                  manifest: case files + expected accept/reject
envelopes/valid-*.json      must be accepted
envelopes/invalid-*.json    must be rejected (422)
verdicts/valid-*.json       response shapes, for decoder tests
```

## Limits

`index.json` carries a `limits` block; it is part of the contract, not
implementation detail, and an SDK should check against it before sending
rather than discover it from a rejection.

| What | Limit | Exceeded → |
| --- | --- | --- |
| `clientEventId` | 1–64 chars, `[A-Za-z0-9_-]` | 422 |
| `typeKey` | 1–128 chars | 422 |
| `meta` | 65536 bytes serialized | 422 |
| whole body | 262144 bytes | 413 `payload_too_large` |

The `meta` ceiling is a bound on *size only*. It does not walk back §3.1
rule 2: no key is required, none is rejected, and nesting is still accepted.
It exists because `meta` is journalled verbatim into JSONB and the key that
authorises the write is public by design — without it, anyone holding a
publishable key lifted from a page bundle can append megabytes per call.

Two layers because they answer different questions. The body cap is the
transport backstop and cannot say which field was at fault; the `meta` cap
answers 422 naming the field, which is what makes it legible as a contract
rule.

## Idempotency, precisely

`clientEventId` is the idempotency key. `Idempotency-Key`, when sent, must
carry the same value — the header exists so proxies and HTTP retry machinery
can see the key without parsing the body, and a request whose header and body
disagree is rejected rather than silently resolved in favour of one.

Two guarantees, with different strengths, and it is worth knowing which is
which:

- **No duplicate journal rows — exact.** Enforced by a unique index on
  `(project_id, client_event_id)`, so it holds under any interleaving.
- **A retry replays the same `decisionId` — best effort.** The lookup reads
  the journal, and journal writes are asynchronous, so a retry arriving inside
  that window (about one storage round trip; longer under backpressure)
  evaluates again and mints a second `decisionId`.

While the resolver is a pure function of the envelope the two answers agree,
so the window costs nothing but an id. A client should still treat
`decisionId` as the id *of an answer* rather than a stable key derived from
the request.

## Changing the contract

Additive changes (a new optional envelope field, a new `meta` key, a new
reason code) belong in `v1`: §3.1 rule 5 makes the envelope tolerant of
unknown fields precisely so these do not break anyone. Add a fixture that
covers the new shape.

A change that makes a previously valid envelope invalid — tightening a bound,
adding a required field, removing a response field — is not a `v1` change. It
gets a `v2` directory alongside this one, because the old files must keep
passing against the old contract for as long as any SDK in the wild speaks it.

Note the invalid cases are all *envelope structure*. There is deliberately no
fixture asserting that a particular `typeKey` or `meta` shape is rejected: the
server does not validate either (§3.1 rules 2 and 3, §3.4). An unknown
`typeKey` is a policy outcome — `approved` with `not_gated` — not a 422.
