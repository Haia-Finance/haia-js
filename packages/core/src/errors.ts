import type { Facts, Verdict } from '@haia/types'

/**
 * Блокировка политикой. Отдельный класс — чтобы партнёр программно отличал
 * haia-блок от ошибок кошелька (user rejected, insufficient funds, …).
 */
export class HaiaPolicyError extends Error {
  readonly decision = 'rejected' as const
  readonly decisionId: string
  /** Машиночитаемые коды из документированного словаря — по ним строится UI. */
  readonly reasons: string[]
  readonly facts: Facts

  constructor(verdict: Verdict, facts: Facts) {
    super(`haia: action blocked by policy (${verdict.reasons?.join(', ') || 'no reason given'})`)
    this.name = 'HaiaPolicyError'
    this.decisionId = verdict.decisionId
    this.reasons = verdict.reasons ?? []
    this.facts = facts
    // Прототип восстанавливаем явно: при компиляции в ES5 target extends Error
    // ломает instanceof, а SDK собирается под несколько таргетов.
    Object.setPrototypeOf(this, HaiaPolicyError.prototype)
  }
}
