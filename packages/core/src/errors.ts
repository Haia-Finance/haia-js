import type { Decision, Facts, Verdict } from '@haia/types'

/**
 * Блокировка политикой. Отдельный класс — чтобы партнёр программно отличал
 * haia-блок от ошибок кошелька (user rejected, insufficient funds, …).
 */
export class HaiaPolicyError extends Error {
  /** Из вердикта, а не константой: иначе поле лгало бы при любом ином исходе. */
  readonly decision: Decision
  readonly decisionId: string
  /** Машиночитаемые коды из документированного словаря — по ним строится UI. */
  readonly reasons: string[]
  readonly facts: Facts

  constructor(verdict: Verdict, facts: Facts) {
    super(`haia: action blocked by policy (${verdict.reasons?.join(', ') || 'no reason given'})`)
    this.name = 'HaiaPolicyError'
    this.decision = verdict.decision
    this.decisionId = verdict.decisionId
    this.reasons = verdict.reasons ?? []
    this.facts = facts
    // Прототип восстанавливаем явно: при компиляции в ES5 target extends Error
    // ломает instanceof, а SDK собирается под несколько таргетов.
    Object.setPrototypeOf(this, HaiaPolicyError.prototype)
  }
}

const MAX_CAUSE_DEPTH = 10

/**
 * Достаёт haia-блок из ошибки, как её увидел партнёр. Голый
 * `err instanceof HaiaPolicyError` недостаточен: стеки оборачивают ошибку
 * транспорта в свою (viem → `TransactionExecutionError`), и блок оказывается
 * в цепочке `cause`. Партнёрский код должен спрашивать через этот хелпер.
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
