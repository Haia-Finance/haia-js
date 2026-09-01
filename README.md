# haia-js

JavaScript/TypeScript adapters for HAIA — a non-custodial control plane for onchain
execution. Adapters gate transactions through a policy check and stream analytics,
with minimal code on the integrator side.

🚧 Under active development.

## Packages

A monorepo: one shared kernel plus thin per-SDK packages.

| Package | Purpose |
|---|---|
| [`@haia/types`](./packages/types) | The wire contract with no runtime: `Facts`, `Verdict`, events |
| [`@haia/core`](./packages/core) | The universal kernel: policy `/evaluate`, ingest, identity, runtime injection. Knows nothing about EVM or wallet providers |
| [`@haia/evm`](./packages/evm) | The EVM family layer: EIP-1193 interception, calldata decoding, normalization into facts |
| [`@haia/wagmi`](./packages/wagmi) | A thin adapter for viem / wagmi on top of `@haia/evm` |
| `tooling/*` | Shared configs (`@haia/tsconfig`, `@haia/biome-config`) |

## Identity in the envelope

Every `guard()` leaves with identity in `meta` — the SDK attaches it itself, at
every integration level (transport, connector, manual `guard`). `anonymousId` is
always present; `userId` appears after `identify()` and is not sent before login.

```ts
const haia = createHaiaClient({ projectId, publishableKey })
haia.identify(address)   // the wallet address as identity is enough
```

Why. The control plane writes an event for every verdict and lifts these two keys
into columns of their own. Without them the row is accepted exactly the same way
and the action is gated as usual — but no funnel sees it (they all filter on
`COALESCE(user_id, anonymous_id) IS NOT NULL`) and no erasure request ever reaches
it, because the cascade looks up by user and the anonymous ids linked to them. The
cost of omitting them is not a failure but silently incomplete numbers and a record
that cannot be deleted. That is why the SDK attaches the keys instead of every
integrator having to remember to.

The rules:

- **An explicit value from the caller wins.** A `meta.userId` you pass reaches the
  server unchanged; attaching fills in what is empty.
- **`anonymousId` is the same one analytics uses.** The hot and cold paths take it
  from a single `Identity` instance — this is the identifier the server uses to
  stitch intent → verdict → execution together.
- **Missing identity is not an error.** The envelope goes out as it is, with no
  exception and no block; one `console.debug` per session.
- **The keys do not become required on the wire.** The contract fixes exactly two
  required fields, and failing closed over envelope shape on the money path is
  not acceptable.

`clientEventId` stays the stable correlation key. `decisionId` does not: a retry
re-evaluates the intent from scratch, and the contract declares its stability
best-effort.

## Examples

[`examples/transfer-page`](./examples/transfer-page) — a transfer page built on
wagmi: connect a wallet, pick a network, address, amount, Send. The gate is added
by one wrapper around the connector and appears neither in the form nor in the
submit handler.

```bash
cd examples/transfer-page
cp .env.example .env.local   # projectId + publishableKey
pnpm dev
```

Examples are not published to npm, but they live in the workspace — so they consume
the packages through the same public entry point an external project does.

## Tooling

pnpm (workspaces + catalog) · Turborepo · Biome · tsup · Changesets · Vitest.

```bash
pnpm install        # install (requires corepack / pnpm 11+)
pnpm build          # build every package (turbo)
pnpm check-types    # tsc --noEmit across packages
pnpm test           # vitest
pnpm lint           # biome check
pnpm changeset      # add a changeset for the next release
```
