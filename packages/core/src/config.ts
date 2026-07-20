import type { Facts, FailMode, TypeKey, Verdict } from '@haia/types'
import type { Runtime } from './runtime'

export interface HaiaEndpoints {
  /** Горячий путь. По умолчанию `{baseUrl}/v1/projects/{projectId}/policy/evaluate`. */
  policy: string
  /** Холодный путь. По умолчанию `{baseUrl}/v1/batch`. */
  ingest: string
}

export interface HaiaFailModeConfig {
  /** Фолбэк для ключей вне таблицы конвенций и без подсказки семейного слоя. */
  default?: FailMode
  /** Точечное переопределение по typeKey — имеет приоритет над всем остальным. */
  byTypeKey?: Record<TypeKey, FailMode>
}

export interface HaiaConfig {
  projectId: string
  /**
   * Единый публичный клиентский ключ со scope-набором `{ingest:write,
   * policy:evaluate}`. Встраивается в публичный фронтенд — секретов не несёт.
   */
  publishableKey: string
  endpoints?: Partial<HaiaEndpoints>
  baseUrl?: string
  /** Бюджет латентности на `/evaluate`, мс. */
  latencyBudgetMs?: number
  failMode?: HaiaFailModeConfig
  /** Вердикт `rejected`: показать UI с причиной. Вызывается перед throw. */
  onBlocked?: (verdict: Verdict, facts: Facts) => void
  /** Вердикт `flagged`: step-up подтверждение. По умолчанию действие проходит. */
  onFlagged?: (verdict: Verdict, facts: Facts) => void
  environment?: string
  runtime?: Partial<Runtime>
}

/**
 * Реалистичный бюджет межрегионального браузерного вызова: каждый перехваченный
 * вызов — полный сетевой RTT, локального пропуска и кэша вердиктов нет.
 */
export const DEFAULT_LATENCY_BUDGET_MS = 400

export const DEFAULT_API_BASE = 'https://api.haia.finance'

/**
 * Дефолтный fail-mode для ключей словаря конвенций: деньги → closed, прочее →
 * open. Таблица покрывает документированные typeKey; для незнакомых ключей
 * действует `failMode.default` (иначе `open` — незнакомый ключ по определению
 * не входит в денежный класс, а fail-closed по умолчанию заблокировал бы любое
 * новое действие при первом же таймауте).
 */
export const DEFAULT_FAIL_MODE_BY_TYPE_KEY: Record<string, FailMode> = {
  transfer_intent: 'closed',
  swap_intent: 'closed',
  bridge_intent: 'closed',
  token_approval: 'closed',
  contract_call: 'closed',
  sign_message: 'open',
  wallet_connected: 'open',
}

export const FALLBACK_FAIL_MODE: FailMode = 'open'

/**
 * Policy-путь per-project: projectId живёт в URL, а не в теле — сервер матчит
 * его со scope ключа.
 */
export function resolveEndpoints(cfg: HaiaConfig): HaiaEndpoints {
  const base = (cfg.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  // Явный undefined в overrides отбрасываем: `endpoints: { policy: process.env.X }`
  // с незаданной переменной иначе затёр бы рабочий URL на undefined, и запросы
  // молча ушли бы на origin страницы.
  const overrides = Object.fromEntries(
    Object.entries(cfg.endpoints ?? {}).filter(([, v]) => v !== undefined),
  )
  return {
    policy: `${base}/v1/projects/${encodeURIComponent(cfg.projectId)}/policy/evaluate`,
    ingest: `${base}/v1/batch`,
    ...overrides,
  }
}
