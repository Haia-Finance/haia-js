# Transfer page

A transfer page built on wagmi: connect a wallet → pick a network → address →
amount → Send. Exactly what every wallet and dApp already has. The point of the
example is what it did **not** have to write: the policy gate appears neither in
the form nor in the Send handler.

```sh
pnpm install                 # from the monorepo root
cp .env.example .env.local   # projectId + publishableKey
pnpm --filter @haia/example-transfer-page dev
```

## The integration

Three lines, all of them in [`src/wagmi.ts`](./src/wagmi.ts) and
[`src/haia.ts`](./src/haia.ts):

```ts
const haia = createHaiaClient({ projectId, publishableKey })

createConfig({
  connectors: [haiaConnector(injected(), haia)],
  multiInjectedProviderDiscovery: false,
})
```

`haiaConnector` replaces exactly one method on the connector — `getProvider`. What
comes out is the same EIP-1193 provider, except that the methods in `GATED_METHODS`
(`eth_sendTransaction`, `wallet_sendCalls`, `eth_signTypedData*`, …) go to
`POST /v1/projects/{projectId}/policy/evaluate` first, and only approved ones reach
the wallet. That is why [`App.tsx`](./src/App.tsx) knows nothing about policy:
`useSendTransaction` stays an ordinary wagmi hook, and the gate can be removed from
the whole application by deleting that one wrapper.

`multiInjectedProviderDiscovery: false` is not cosmetic. By default wagmi adds
connectors it discovers over EIP-6963 to the config itself — wagmi creates them,
not our code, which means they bypass the wrapper. One unwrapped connector in the
list makes the gate optional: the user simply picks the other entry in the connect
menu.

The wallet does not go anywhere: `injected()` talks to `window.ethereum`, which the
installed extension occupies — in the example the button is labelled with the name
of the wallet that was found. What is lost is not the wallet but the choice between
several installed at once. If you need that choice, list the targets explicitly,
each in its own wrapper, with discovery still off:

```ts
connectors: [
  haiaConnector(injected({ target: 'metaMask' }), haia),
  haiaConnector(injected({ target: 'coinbaseWallet' }), haia),
]
```

The one place where the application does know about haia is handling the outcome:

```ts
try {
  await sendTransactionAsync({ to, value })
} catch (err) {
  const blocked = asHaiaPolicyError(err)   // not instanceof: viem puts the block in cause
  if (blocked) showReasons(blocked.reasons)
}
```

## What to look at

The **Wire** panel at the bottom of the page shows the request and the response of
every call to the control plane, with the same body the SDK sent. It is not part of
the integration (it is wired in through `runtime.fetch`, see
[`src/wire-log.ts`](./src/wire-log.ts)) and exists so the contract can be seen with
your own eyes:

```json
{
  "clientEventId": "01KZWDXC5WG7ZHBFBZ4PDDVPYV",
  "typeKey": "transfer_intent",
  "meta": {
    "chain": "eip155:11155111",
    "from": "0x1111…",
    "to": "0x2222…",
    "amount": "0.01",
    "amountRaw": "10000000000000000",
    "userId": "0x1111…",
    "anonymousId": "01KZWDX9F3B0S2QK7YV4M8N1TG"
  }
}
```

→

```json
{ "decision": "approved", "decisionId": "dec_019ff8dd…", "reasons": ["policy_not_configured"] }
```

It shows things the UI does not:

- **`clientEventId` is a ULID**, and it is also the `Idempotency-Key` header and the
  `messageId` of the cold-path event. The server stitches intent, decision and
  execution together on it, and deduplicates retries by it. `decisionId`, by
  contrast, will differ on a retry: the server evaluates the intent again, and the
  contract declares its stability best-effort. The stable key is `clientEventId`.
- **The amount travels in two forms** — `amount` and `amountRaw`, both as strings.
  Floats are not allowed on the money path.
- **The page never wrote `userId` / `anonymousId`.** The SDK attached them: `userId`
  from `haia.identify(address)` in step 1, `anonymousId` its own. Compare the latter
  with the same key in `/v1/batch` below — the value is identical, and it is what
  the server uses to join the intent to its execution.
- **`/v1/batch` arrives later** than the hot path and in a batch: analytics is
  fire-and-forget and its failure is invisible to the application.
- **A verdict is never silent about itself**: `reasons` explains why it came out
  that way. `policy_not_configured` means the project has no policy pack armed;
  `not_gated` means the action type is not registered.

### Fail-closed

Stop the control plane and press Send. The transaction is **blocked** and the wallet
window never opens:

```
reasons=[fallback_closed, unavailable]  decisionId=fallback:01KZWDXC…
```

That is intended: `transfer_intent` is a money action, so when policy is unavailable
the SDK fails closed. For `sign_message` or `wallet_connected` in the same situation
the action would go through (fail-open). The client is the side that knows the class
of the action, so the client is the side that decides.

## Pointing at a control plane

Three variables in `.env.local`:

```sh
VITE_HAIA_PROJECT_ID=<project uuid>
VITE_HAIA_PUBLISHABLE_KEY=pit_…
VITE_HAIA_BASE_URL=          # empty → https://api.haia.finance
```

`projectId` and the publishable key come from the project's API keys. The key must
carry the **`policy:evaluate`** scope — without it the gate answers 403 and the SDK
goes to its fail-mode, which for a transfer means the send is blocked.

Leave `VITE_HAIA_BASE_URL` empty to talk to the hosted control plane, or set it to
your own deployment. Two things a self-hosted run usually trips over:

- **CORS.** The control plane only admits origins on its allowlist. The dev server
  is pinned to port 5173 (`strictPort` in [`vite.config.ts`](./vite.config.ts))
  because that is the origin most deployments allow out of the box; from another
  port you hit a preflight failure, not a policy decision.
- **The latency budget.** A deployment that is cold on the first request can exceed
  the SDK's 400 ms budget, and for a transfer that budget expiring means fail-closed.
  Raise it with `VITE_HAIA_LATENCY_BUDGET_MS` while you are testing.

To confirm what actually arrived, read the Wire panel: it shows the exact request
body and the exact verdict, including whether `userId` / `anonymousId` were present
in `meta`. If both are empty, the SDK sent an envelope with no identity — the verdict
is unaffected, but the record it produces will not be counted by any funnel and will
not be reachable by an erasure request.

## What is real here

Real: the SDK, the wallet, the network, the transaction and the calls to the control
plane. The example mocks nothing — if Send goes through, the transaction really did
go to the network.

That is why the networks are **testnets** (Sepolia, Base Sepolia, Arbitrum Sepolia):
the example is public and gets opened by people with real wallets. Gating does not
depend on the network; to look at mainnet, change `chains` and `transports` in
[`src/wagmi.ts`](./src/wagmi.ts).

Against a project with no policy pack armed, verdicts are almost always `approved`
with the reason `policy_not_configured`: a gate with nothing armed does not invent a
decision, it lets the action through and says why. To see a real `rejected`, arm a
pack on the project.
