# Wire-contract fixtures — vendored snapshot

`policy/v1/` is a **snapshot** of the policy/evaluate wire contract, which is
owned by the HAIA control plane. It is vendored here so this repository's test
suite is self-contained: the contract test in
`packages/core/src/contract.test.ts` reads these files and needs nothing else
checked out.

- Contract: `policy/evaluate`, version 1
- Snapshot taken: 2026-08-25
- Consumer: `packages/core/src/contract.test.ts`

## What is in the snapshot, and what is not

The snapshot is **data only**: `index.json`, `envelopes/` and `verdicts/`.
Those are the artifact the two implementations have to agree on, and they are
expected to match their source byte for byte.

Prose is not vendored. `./README.md` describes what the contract says and is
written and owned here — so an update to the snapshot never overwrites it, and
it never carries links or paths that only resolve inside another repository.

## Keeping it current

By hand: copy `policy/v1/` from the source wholesale and update the date above.
A recursive copy is safe — the source keeps its own prose outside that
directory for exactly this reason — and the contract test asserts the snapshot
holds nothing but `index.json`, `envelopes/` and `verdicts/`, so anything
foreign that does arrive fails loudly instead of landing in the repository
unnoticed.

The test then either passes against the new files or names what the SDK has to
change.

**There is no automated freshness check.** A snapshot that has fallen behind
its source looks exactly like a current one — the test suite stays green and
the mismatch surfaces as a rejected envelope at integration time. Treat a
contract change upstream as requiring a re-vendor here in the same cycle.

## Formatting

`contracts/` is excluded from Biome (see `biome.json`). The fixtures are a
copy, not source: reformatting them would make them differ from the artifact
they are supposed to reproduce.

## The mechanism is provisional

Vendoring was chosen because it is the only option that works without extra
infrastructure. The replacement worth building is a published
`@haia/policy-contract` package that both the control plane and this SDK
depend on: freshness then becomes an ordinary dependency bump, visible in a
pull request and checked by CI.

A git submodule is not an option — the contract's source repository is
private, and a submodule would break `git clone --recurse-submodules` for
every external contributor and for any CI job without credentials.
