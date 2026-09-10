---
'@haia/types': minor
'@haia/core': minor
---

`Facts` gains an optional `contextId` — the operation an intent belongs to.

The control plane files each decision under it and assembles one Operation Receipt per distinct value, so sending the same id here and with the operation's events is what puts the verdict on that operation's receipt beside everything else it did. Without it the verdict is identical and the decision is simply one no receipt can show.

- **Yours to choose, and reused across the calls of one operation.** Distinct from `clientEventId`, which names this single call and is the idempotency key: one operation usually makes several calls, each with its own `clientEventId` and all with the same `contextId`.
- **Optional, and forwarded only when set.** An empty string is left out of the envelope rather than sent: the gate trims the value and reads a blank as absent, so sending one would file the decision under no operation while you believed otherwise.
- **Over the contract's 256 characters it is dropped, not sent.** A length violation is a 422 on envelope shape, and this SDK turns a 422 into the configured fail-mode — so sending one would block a money action over an id that only decides which receipt a decision appears on. The call goes without it and the console says so.
- **It cannot be added later.** The decision's timestamp is part of its idempotency key, so a decision written without an operation never gains one.
- **Reachable from `guard(facts)` today, not from the wrappers.** `txFacts` / `typedDataFacts` and the wagmi transport and connector build their own `Facts` and have nowhere to take an operation id from, so an integration on those paths cannot name one yet. How a transport-level wrapper learns which operation it is inside is an open design question.
