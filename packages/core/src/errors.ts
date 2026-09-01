import type { Decision, Facts, Verdict } from '@haia/types'

/**
 * A block by policy. A class of its own, so an integrator can tell a haia block
 * apart from wallet errors (user rejected, insufficient funds, …) in code.
 */
export class HaiaPolicyError extends Error {
  /** Taken from the verdict, not hardcoded: otherwise the field would lie on any other outcome. */
  readonly decision: Decision
  readonly decisionId: string
  /** Machine-readable codes from a documented vocabulary — the UI is built from them. */
  readonly reasons: string[]
  readonly facts: Facts

  constructor(verdict: Verdict, facts: Facts) {
    super(`haia: action blocked by policy (${verdict.reasons?.join(', ') || 'no reason given'})`)
    this.name = 'HaiaPolicyError'
    this.decision = verdict.decision
    this.decisionId = verdict.decisionId
    this.reasons = verdict.reasons ?? []
    this.facts = facts
    // Restore the prototype explicitly: compiled to an ES5 target, extending
    // Error breaks instanceof, and the SDK is built for several targets.
    Object.setPrototypeOf(this, HaiaPolicyError.prototype)
  }
}

const MAX_CAUSE_DEPTH = 10

/**
 * Extracts a haia block from an error as the integrator sees it. A bare
 * `err instanceof HaiaPolicyError` is not enough: stacks wrap a transport error
 * in their own (viem → `TransactionExecutionError`), leaving the block in the
 * `cause` chain. Integrator code should ask through this helper.
 *
 *   catch (e) { const block = asHaiaPolicyError(e); if (block) showUi(block.reasons) }
 */
export function asHaiaPolicyError(err: unknown): HaiaPolicyError | undefined {
  let current = err
  for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
    if (current instanceof HaiaPolicyError) return current
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
