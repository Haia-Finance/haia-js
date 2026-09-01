# Wire-contract fixtures — vendored snapshot

`policy/v1/` is a **snapshot** of the policy/evaluate wire contract, which is
owned by the HAIA control plane. It is vendored here so this repository's test
suite is self-contained: the contract test in
`packages/core/src/contract.test.ts` reads these files and needs nothing else
checked out.

- Contract: `policy/evaluate`, version 1
- Snapshot taken: 2026-08-25
- Consumer: `packages/core/src/contract.test.ts`

## Keeping it current

By hand. When the contract changes, the snapshot is replaced wholesale and the
date above is updated; the contract test then either passes against the new
files or names what the SDK has to change.

**There is no automated freshness check.** A snapshot that has fallen behind
its source looks exactly like a current one — the test suite stays green and
the mismatch surfaces as a rejected envelope at integration time. Treat a
contract change upstream as requiring a re-vendor here in the same cycle.

## Formatting

`contracts/` is excluded from Biome (see `biome.json`). The files are a copy,
not source: reformatting them would make them differ from the artifact they
are supposed to reproduce.

## The mechanism is provisional

Vendoring was chosen because it is the only option that works without extra
infrastructure. The replacement worth building is a published
`@haia/policy-contract` package that both the control plane and this SDK
depend on: freshness then becomes an ordinary dependency bump, visible in a
pull request and checked by CI.

A git submodule is not an option — the contract's source repository is
private, and a submodule would break `git clone --recurse-submodules` for
every external contributor and for any CI job without credentials.
