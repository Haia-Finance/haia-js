---
'@haia/types': minor
'@haia/core': minor
---

A verdict now means a policy pack reached one, and everything else says why it could not.

**`Facts.baseType`, optional.** The base event type the pack behind a `typeKey` guards its rules on. It is optional on the wire and the SDK forwards it verbatim only when you set it — it derives nothing from the `typeKey`, because which base type a pack expects is the pack's business and a guessed one matches no rule. Packs are commonly written as `event.type == "<typeKey>_intent"`; a rule that matches nothing leaves the decision to the pack's own default, so send it wherever your pack expects one.

**There is no `approved` for an action nothing looked at.** The `approved` / `flagged` / `rejected` verdict now arrives only when a pack produced it, and the reason code `not_gated` is gone with the branch that emitted it. If you branched on that code, the equivalent today is a fallback verdict whose `reasons` name a gate error code.

**Five error codes, and the code — not the status — says what to do.** `not_configured` (409): the workspace has no policy engine tenant; provision it, a retry cannot. `engine_error` (502): the engine failed on its own terms, a `typeKey` with no deployment behind it included; its own sentence is relayed. `engine_unavailable` (503): the engine did not answer. `engine_rate_limited` (503): back off, honouring `Retry-After`. `engine_rejected_request` (500): the payload sent to the engine was refused. The union is exported as `GateErrorCode`.

**What the client does with them.** Every one of them produces the same fail-mode fallback as an outage does — the class of the action decides — with the code itself added to `reasons`, so a misconfigured stand can be told from an engine outage in your telemetry. A configuration code no longer counts toward the circuit breaker (every call would answer the same), a rate limit shuts the gate for the `Retry-After` the engine asked for, up to a minute, and the engine's message is written to the console once per code: on a 502 it names the stream nothing is deployed for, which is the thing to go and fix.

**`decisionId` is the policy engine's execution id.** `clientEventId` is the idempotency key the engine is handed, so a retry of the same intent replays the same decision instead of minting a second one. Earlier releases documented it as the resolver's own id with best-effort stability; the correlation key remains `clientEventId`.
