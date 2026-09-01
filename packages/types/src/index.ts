/**
 * The Haia wire contract. Pure types with no runtime, so server-side TypeScript
 * consumers can depend on them without pulling in the `@haia/core` runtime.
 */

/** CAIP-2 chain id, e.g. "eip155:1". */
export type CaipChainId = string

/**
 * The kind of action. On the wire it is an opaque string in the control
 * plane's namespace: the server does not validate it against a closed list,
 * and an unknown key is simply not gated. Closed enums of their own keys are
 * held by the family layers (`@haia/evm` and friends) — that is a detail of
 * their machinery, not of the contract.
 */
export type TypeKey = string

declare const clientEventIdBrand: unique symbol

/**
 * The id of an action: idempotency for the gate, and correlation between
 * intent, decision and execution.
 *
 * The type is branded deliberately: a bare string must not reach the envelope
 * around `newClientEventId()` (generation) or `asClientEventId()` (bounds
 * check). Otherwise ids of arbitrary shape leak into the journal and
 * idempotency rests on the caller's good intentions.
 *
 * The wire form stays liberal: the SDK generates a ULID, but ids are admitted
 * against bounds and a charset rather than a schema — otherwise server-side and
 * partner sources with their own id formats could not speak the same contract.
 */
export type ClientEventId = string & { readonly [clientEventIdBrand]: true }

/**
 * The identity keys in `meta`.
 *
 * In shape they are ordinary `meta` keys: optional, never rejected. In meaning
 * they are special — the server lifts them out of the envelope into columns of
 * their own on the event it writes for every verdict. A row without them is
 * accepted exactly the same way, but no funnel sees it (they all filter on
 * `COALESCE(user_id, anonymous_id) IS NOT NULL`) and the erasure cascade never
 * reaches it, because it deletes by user and the anonymous ids linked to them.
 *
 * So the cost of omitting them is not a failure but silently incomplete numbers
 * and a record that cannot be deleted. That is why the SDK attaches them
 * (`@haia/core` does it on every `guard()`) instead of every integrator
 * remembering to.
 */
export interface IdentityMeta {
  /** The integrator's authenticated user (or a wallet address). */
  userId?: string
  /** Pre-login device id; the same one the analytics events carry. */
  anonymousId?: string
}

/**
 * The envelope of facts — the body of
 * `POST /v1/projects/{projectId}/policy/evaluate`.
 *
 * Only `clientEventId` and `typeKey` are required; `meta` is flat and is not
 * validated (schema-on-read). The names of `meta` keys are a de facto contract
 * for policy rules, so they come from the shared conventions dictionary
 * (`userId`, `anonymousId`, `chain`, `from`, `to`, `amount`, `amountRaw`,
 * `spender`, `isUnlimitedApproval`, `method`, `selector`, …) rather than being
 * invented on the spot.
 *
 * Discipline about values: amounts are strings, always (human-readable plus
 * minor units); chains are CAIP-2; floats are forbidden. Secrets and sensitive
 * PII must not go into `meta` — an identifier outside the conventions tables
 * (see `IdentityMeta`) is not found by an erasure request.
 */
export interface Facts {
  clientEventId: ClientEventId
  typeKey: TypeKey
  /** Flat, no nesting. */
  meta: Record<string, unknown> & IdentityMeta
}

export type Decision = 'approved' | 'rejected' | 'flagged'

/**
 * The resolver's verdict. Never cached: every gate is a real call, and every
 * intent is journalled on the server.
 */
export interface Verdict {
  decision: Decision
  /** Id of the RESOLVER's decision (not the engine's): the mapping to
   * individual deciders is internal. */
  decisionId: string
  /** Machine-readable codes from a documented vocabulary. */
  reasons?: string[]
}

/** What to do when policy is unavailable: open → proceed, closed → block. */
export type FailMode = 'open' | 'closed'

/**
 * Segment-compatible cold-path events. `clientEventId`, when set, is the
 * deduplication key and ties the event to the hot-path intent.
 */
export type AnalyticsEvent = { clientEventId?: string } & (
  | { type: 'track'; event: string; properties?: Record<string, unknown> }
  | { type: 'identify'; userId: string; traits?: Record<string, unknown> }
  | { type: 'page'; name?: string; properties?: Record<string, unknown> }
  | { type: 'screen'; name?: string; properties?: Record<string, unknown> }
)
