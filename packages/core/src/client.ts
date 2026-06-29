import type { TransactionContext, Verdict } from '@haia/types'
import { AnalyticsClient } from './analytics/client'
import { DEFAULT_ENDPOINTS, type HaiaConfig } from './config'
import { Identity } from './identity/identity'
import { PolicyEngine } from './policy/engine'
import { defaultRuntime, type Runtime } from './runtime'

/**
 * Фасад. Конфигурируется один раз; держит два независимых под-клиента:
 * `policy` (горячий путь) и `analytics` (холодный).
 */
export class HaiaClient {
  readonly policy: PolicyEngine
  readonly analytics: AnalyticsClient
  readonly identity: Identity
  private readonly runtime: Runtime

  constructor(cfg: HaiaConfig) {
    this.runtime = { ...defaultRuntime(), ...cfg.runtime }
    const endpoints = { ...DEFAULT_ENDPOINTS, ...cfg.endpoints }
    this.policy = new PolicyEngine(cfg, this.runtime, endpoints.policy)
    this.analytics = new AnalyticsClient(cfg, this.runtime, endpoints.ingest)
    this.identity = new Identity(this.runtime)
  }

  /** Горячий путь: синхронный policy-gate. Адаптер применяет вердикт. */
  guard(ctx: TransactionContext): Promise<Verdict> {
    return this.policy.evaluate(ctx)
  }

  /** Холодный путь: fire-and-forget аналитика. */
  track(event: string, properties?: Record<string, unknown>): void {
    this.analytics.enqueue({ type: 'track', event, properties })
  }

  /** Связывает пользователя (user_id / адрес кошелька) и шлёт identify. */
  identify(userId: string, traits?: Record<string, unknown>): void {
    this.identity.setUserId(userId)
    this.analytics.enqueue({ type: 'identify', userId, traits })
  }
}

export function createHaiaClient(cfg: HaiaConfig): HaiaClient {
  return new HaiaClient(cfg)
}
