# Policy evaluate — the wire contract

`policy/v1/` holds the fixtures for `POST /v1/projects/{projectId}/policy/evaluate`:
the executable form of the envelope and verdict contract. Two independent
implementations have to agree on it — the control plane that validates
envelopes, and the browser SDK in this repository that builds them. Both check
against the same files, so a disagreement fails a unit test in whichever side
drifted instead of surfacing at the slowest possible moment, in an end-to-end
run, with the symptom far from the cause.

The fixtures are a vendored snapshot of an artifact this repository does not
own; `PROVENANCE.md` covers where they come from and how they are kept current.
This document is ours, and describes what the contract says.

## Layout

`policy/v1/index.json` is the manifest — it names every case file and, for envelopes,
whether the gateway must accept it. Iterate the manifest rather than globbing
the directories, so a new fixture with no declared expectation is a loud error
instead of a silently unchecked file.

```
policy/v1/index.json                  manifest: case files + expected accept/reject
policy/v1/envelopes/valid-*.json      must be accepted
policy/v1/envelopes/invalid-*.json    must be rejected (422)
policy/v1/verdicts/valid-*.json       200 response shapes, for decoder tests
policy/v1/errors/<code>.json          error bodies, one per published error code
```

## The envelope

Exactly two fields are required — `clientEventId` and `typeKey`. `meta` is flat
and is not validated: no key is required, none is rejected, and unknown
top-level fields are tolerated on purpose so additive changes break no one.

The envelope is forwarded to the policy engine in the engine's own names,
nothing translated in between:

| Envelope | Engine | Meaning |
| --- | --- | --- |
| `typeKey` | `stream` | the policy pack that evaluates the action |
| `baseType` | `type` | the pack's base event type; optional here because it is optional there |
| `clientEventId` | `id` | the idempotency key |
| `meta` | `data` | every field the pack's rules read |

`baseType` is optional, and omitting it is not an error — but a pack whose
rules guard on the event type (`event.type == "<stream>_intent"`, which is how
the shipped packs are written) matches nothing without it, and the engine
answers with its own default rather than with a rule's decision. Send it
whenever the pack behind a `typeKey` expects one.

An unknown `typeKey` is not a 422 either: it is the engine's stream name, and
the engine is the side that answers for it. A stream with nothing deployed
behind it comes back as `engine_error` — an error, not a pass. That is why the
invalid fixtures are all about envelope *structure*: there is deliberately no
fixture asserting that a particular `typeKey` or `meta` shape is rejected,
because the server validates neither.

## Limits

`index.json` carries a `limits` block. It is part of the contract, not an
implementation detail, and an SDK should check against it before sending rather
than discover it from a rejection.

| What | Limit | Exceeded → |
| --- | --- | --- |
| `clientEventId` | 1–64 chars, `[A-Za-z0-9_-]` | 422 |
| `typeKey` | 1–128 chars | 422 |
| `baseType` | 1–128 chars, optional | 422 |
| `meta` | 65536 bytes serialized | 422 |
| whole body | 262144 bytes | 413 `payload_too_large` |

The `meta` ceiling bounds *size only*. It does not walk back the rule above: no
key is required, none is rejected, and nesting is still accepted. It exists
because `meta` is journalled verbatim into JSONB and the key that authorises
the write is public by design — without it, anyone holding a publishable key
lifted from a page bundle can append megabytes per call.

Two layers, because they answer different questions. The body cap is the
transport backstop and cannot say which field was at fault; the `meta` cap
answers 422 naming the field, which is what makes it legible as a contract
rule.

## What an answer is

A `200` is the only status that carries a verdict, and a verdict exists only
because the policy engine produced one: `decision` is its word, `reasons` carry
the codes its pack emitted, `decisionId` is its execution id. The gate adds
nothing and suppresses nothing — there is no outcome where an action is waved
through because no rule looked at it.

A pack that blocks without emitting a code produces `reasons: []`. The block
still stands; the missing code is a bug in the pack, not a reason to withhold
the verdict.

Every other status means nothing judged the action, and `code` says what would
have to change for a verdict to exist:

| Status | `code` | What the caller does |
| --- | --- | --- |
| 409 | `not_configured` | the workspace has no policy engine tenant — provision it; a retry cannot |
| 502 | `engine_error` | the engine failed on its own terms, "no deployment for this stream" included; `message` carries what it said |
| 503 | `engine_unavailable` | retry, then apply your own fail-mode |
| 503 | `engine_rate_limited` | retry with backoff; `Retry-After` is set when the engine supplied one |
| 500 | `engine_rejected_request` | do not retry — the payload sent to the engine was refused |

The body is `{"detail": {"code", "message"}}`; `policy/v1/errors/` carries one
fixture per code and `index.json` publishes the status and the retryability of
each. `message` is the diagnostic — for anything the engine answered it is the
engine's own text — and it is what an integrator needs to see to fix a stand,
so an SDK should surface it rather than swallow it.

Read the codes, not the status: two of them share `503` and differ in what the
caller should do about it.

## Idempotency, precisely

`clientEventId` is the idempotency key. `Idempotency-Key`, when sent, must
carry the same value — the header exists so proxies and HTTP retry machinery
can see the key without parsing the body, and a request whose header and body
disagree is rejected rather than silently resolved in favour of one.

What a retry of the same key gets back:

- **The same decision.** `clientEventId` is handed to the policy engine as its
  own idempotency key, and the engine replays a decision it has already
  finished for that key instead of evaluating the envelope a second time. The
  verdict and its reasons are the ones the first call got.
- **The same `decisionId`.** It is the engine's execution id, and a replay
  carries the id the original decision was recorded under rather than a second
  one that happens to agree. `decisionId` is what a support case quotes;
  `clientEventId` stays the key that correlates an intent with its verdict and
  later with its execution.

Journalling is deduplicated by `clientEventId` on a best-effort basis too: the
server drops a retry it can see, and a race between two of its own writers can
still leave two analytics rows. The record that has to be exact is the policy
engine's, not this one.

## Identity in `meta`

`userId` and `anonymousId` are ordinary `meta` keys by the rules above —
optional, never rejected — but the server reads them by name and lifts them
onto the event it writes. An envelope that carries neither is accepted exactly
like one that does, and produces a decision record that no funnel counts and no
erasure request can reach.

Nothing fails when they are missing; the numbers are simply incomplete. That is
why the SDK attaches them automatically from whatever identity it already holds
rather than leaving it to each integrator to remember. See
`policy/v1/envelopes/valid-with-identity.json`.

## Changing the contract

Additive changes — a new optional envelope field, a new `meta` key, a new
reason code — belong in `v1`: the envelope tolerates unknown fields precisely
so these do not break anyone. Add a fixture that covers the new shape.

A change that makes a previously valid envelope invalid — tightening a bound,
adding a required field, removing a response field — is not a `v1` change. It
gets a `v2` directory alongside this one, because the old files must keep
passing against the old contract for as long as any SDK in the wild speaks it.
