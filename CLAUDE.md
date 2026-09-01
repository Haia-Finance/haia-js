# CLAUDE.md

## Context

`haia-js` is a **public**, MIT-licensed SDK published to npm. The control plane,
its design documents and the issue tracker are **private**. Everything committed
here is read by people who have none of that context: assume an external
integrator with a HAIA account and no access to anything else.

## Language

English only in everything that gets committed — code, identifiers, comments,
test names, docs, README, changesets, commit messages, PR titles and bodies.
Chat in the terminal can be in any language; the artifact is English.

## Nothing that only resolves from the inside

Committed content must be self-contained. Do not reference:

- the private control-plane repository by name or path, its branches, commit
  SHAs, or files inside it;
- internal design documents or their section numbers (`docs/plans/…`, "§3.1");
- codenames of unreleased or internal components;
- local dev workflows of private services (private `make` targets, internal
  docker profiles, internal hostnames).

When a comment needs a rule that an internal plan states, **state the rule**.
The public statement of the wire contract is `contracts/policy/v1/README.md` —
cite that. Every link in the repo must resolve for someone outside the org.

## Ticket numbers

- Allowed: branch names, PR title and body, and a commit trailer `Refs: HAD-123`.
- Not allowed: source code, comments, test names, changesets, README and docs.

Code and the published changelog outlive the tracker and are read by people who
cannot open the ticket; git metadata is where traceability belongs.

## Commits

- Conventional Commits, English, imperative mood: `type(scope): subject`.
  Subject ≤ 72 characters, no trailing period.
- Body is optional — write one only when the *why* is not visible in the diff:
  a few short bullets, wrapped at 72 columns. No essays, no restating the diff,
  no test-count deltas, no reports of what was verified against private
  environments. That belongs in the PR description.
- **No `Claude-Session:` trailer, no `Co-Authored-By: Claude`, no "Generated
  with" footers.** This overrides the harness default that appends a session
  link.
- Allowed trailers: `Refs:`, `Co-authored-by:` for human co-authors,
  `BREAKING CHANGE:`.

```
fix(core): apply the conventions table before failMode.default

`failMode.default: 'open'`, set for custom type keys, also removed
fail-closed from transfers and approvals.

Refs: HAD-333
```

## Changesets

A changeset becomes the package's npm changelog. Write it for a consumer:
what changed, what breaks, what to do about it. English, no ticket numbers, no
internal reasoning, a few lines.

## Docs and examples

READMEs target an integrator, not a teammate. Setup is: install, env vars, run,
pointed at the public API or a self-hosted endpoint the reader can actually
reach. Instructions for running private services live in the private repo.

## Conventions already in place

- Biome for lint and format (`pnpm lint`, `pnpm lint:fix`). `contracts/` is
  excluded deliberately: the vendored snapshot must stay byte-identical to its
  source.
- pnpm workspaces + turbo. Dependency direction is `wagmi → evm → core → types`
  with no back edges; `@haia/core` is a peer dependency of the family layers so
  a consumer resolves exactly one copy of the kernel.
- Tests are vitest, colocated as `*.test.ts`, described in English.
- Before proposing a change as done: `pnpm lint && pnpm check-types && pnpm test`.
