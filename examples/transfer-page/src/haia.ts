import type { Facts, Verdict } from '@haia/core'
import { createHaiaClient } from '@haia/core'
import { createLogStore } from './store'
import { observingFetch } from './wire-log'

/**
 * Клиент Haia. Один на приложение и создаётся прямо на модуле: конструктор
 * чистый — ни сетевых вызовов, ни `init()`, — поэтому его не нужно тащить в
 * React-стейт и он безопасен при SSR.
 */

function env(name: string): string | undefined {
  const value = import.meta.env[name]
  // Незаданная переменная приезжает из Vite пустой строкой, а не undefined.
  // Разница существенна: `baseUrl: ''` — это не «взять дефолт», а пустой хост,
  // и запросы молча ушли бы на origin самой страницы.
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const projectId = env('VITE_HAIA_PROJECT_ID') ?? ''
export const publishableKey = env('VITE_HAIA_PUBLISHABLE_KEY') ?? ''
export const baseUrl = env('VITE_HAIA_BASE_URL')

/** Без ключей отправлять нечего — страница скажет это явно, а не 401-ом в консоли. */
export const isConfigured = projectId !== '' && publishableKey !== ''

const latencyBudget = Number(env('VITE_HAIA_LATENCY_BUDGET_MS') ?? Number.NaN)

/** Уведомление от политики — то, что партнёр в проде показал бы пользователю. */
export interface PolicyNotice {
  at: number
  decision: Verdict['decision']
  decisionId: string
  reasons: string[]
  typeKey: string
}

export const policyNotices = createLogStore<PolicyNotice>(10)

function notice(verdict: Verdict, facts: Facts): PolicyNotice {
  return {
    at: Date.now(),
    decision: verdict.decision,
    decisionId: verdict.decisionId,
    reasons: verdict.reasons ?? [],
    typeKey: facts.typeKey,
  }
}

export const haia = createHaiaClient({
  projectId,
  publishableKey,
  baseUrl,
  latencyBudgetMs: Number.isFinite(latencyBudget) ? latencyBudget : undefined,
  environment: 'example',
  // `runtime` — штатная точка инъекции. Здесь через неё подключён журнал wire-
  // вызовов страницы (`wire-log.ts`); в проде подменять fetch не нужно.
  runtime: { fetch: observingFetch(globalThis.fetch.bind(globalThis)) },
  // `flagged` — единственный исход, о котором иначе не узнать: действие
  // проходит, ошибки нет, вердикт горячий, а последствие холодное. Без хука
  // партнёр не отличил бы его от обычного approved.
  onFlagged: (verdict, facts) => {
    policyNotices.push(notice(verdict, facts))
  },
  // `rejected` дублируется в `HaiaPolicyError`, и на месте отправки его ловить
  // удобнее — там исход привязан к конкретному нажатию Send. Хук нужен для
  // глобального UI (тост, баннер), поэтому показан здесь тоже.
  onBlocked: (verdict, facts) => {
    policyNotices.push(notice(verdict, facts))
  },
})
