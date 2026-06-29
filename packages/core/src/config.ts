import type { EventType, FailMode } from '@haia/types'
import type { Runtime } from './runtime'

export interface HaiaEndpoints {
  policy: string
  ingest: string
}

export interface HaiaConfig {
  projectId: string
  /** Server API Key для policy `/evaluate` (горячий путь). */
  serverApiKey?: string
  /** Public Ingest Token — строго `ingest:write`, виден клиенту. */
  ingestToken?: string
  endpoints?: Partial<HaiaEndpoints>
  /** Бюджет латентности на `/evaluate`, мс. */
  latencyBudgetMs?: number
  /** Переопределение fail-mode по типу события. */
  failMode?: Partial<Record<EventType, FailMode>>
  environment?: string
  runtime?: Partial<Runtime>
}

export const DEFAULT_LATENCY_BUDGET_MS = 80

/**
 * Безопасный дефолт: деньги → fail-closed, UI-флоу → fail-open.
 * Политика fail-mode задаётся per-event-type и переопределяется через config.
 */
export const DEFAULT_FAIL_MODE: Record<EventType, FailMode> = {
  transfer_intent: 'closed',
  swap_intent: 'closed',
  bridge_intent: 'closed',
  token_approval: 'closed',
  sign_message: 'open',
  wallet_connected: 'open',
}

export const DEFAULT_ENDPOINTS: HaiaEndpoints = {
  policy: 'https://api.haia.finance/v1/policy/evaluate',
  ingest: 'https://api.haia.finance/v1/ingest',
}
