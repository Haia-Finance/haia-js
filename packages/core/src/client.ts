import type { Facts, Verdict } from '@haia/types'
import { AnalyticsClient } from './analytics/client'
import { type HaiaConfig, resolveEndpoints } from './config'
import { HaiaPolicyError } from './errors'
import { Identity } from './identity/identity'
import { type GuardOptions, PolicyClient } from './policy/client'
import { defaultRuntime } from './runtime'

/**
 * Фасад. Держит два независимых под-клиента: `policy` (горячий путь) и
 * `analytics` (холодный).
 *
 * Конструктор чистый: без сетевых вызовов и side-effects — SSR-безопасен,
 * никакого `init()`. Серверной конфигурации, которую надо было бы подтягивать
 * на старте, у клиента нет: проверка «гейтится ли действие» целиком серверная.
 */
export class HaiaClient {
  readonly policy: PolicyClient
  readonly analytics: AnalyticsClient
  readonly identity: Identity

  constructor(private readonly cfg: HaiaConfig) {
    const runtime = { ...defaultRuntime(), ...cfg.runtime }
    const endpoints = resolveEndpoints(cfg)
    this.identity = new Identity(runtime)
    // Один и тот же экземпляр Identity уходит и в policy, и в analytics: сервер
    // склеивает «намерение → вердикт → исполнение» по anonymousId, и две копии
    // с разными значениями тихо развалили бы воронку, ничего не сломав.
    this.policy = new PolicyClient(cfg, runtime, endpoints.policy, this.identity)
    this.analytics = new AnalyticsClient(cfg, runtime, endpoints.ingest, this.identity)
  }

  /**
   * Горячий путь: гейт произвольного действия. Публичен — партнёр может
   * гейтить свои нестандартные действия вручную.
   *
   * `rejected` → вызывается `onBlocked` и бросается `HaiaPolicyError`.
   * `flagged` → вызывается `onFlagged`, действие проходит (вердикт горячий,
   * последствие холодное).
   */
  async guard(facts: Facts, opts?: GuardOptions): Promise<Verdict> {
    const verdict = await this.policy.evaluate(facts, opts)
    if (verdict.decision === 'rejected') {
      this.notify(this.cfg.onBlocked, verdict, facts)
      throw new HaiaPolicyError(verdict, facts)
    }
    if (verdict.decision === 'flagged') {
      this.notify(this.cfg.onFlagged, verdict, facts)
    }
    return verdict
  }

  /** Холодный путь: fire-and-forget аналитика. */
  track(event: string, properties?: Record<string, unknown>, clientEventId?: string): void {
    this.analytics.enqueue({ type: 'track', event, properties, clientEventId })
  }

  /** Связывает пользователя (user_id / адрес кошелька) и шлёт identify. */
  identify(userId: string, traits?: Record<string, unknown>): void {
    this.identity.setUserId(userId)
    this.analytics.enqueue({ type: 'identify', userId, traits })
  }

  /** Хук партнёра не должен ломать гейт: его исключение — не наша авария. */
  private notify(
    hook: ((verdict: Verdict, facts: Facts) => void) | undefined,
    verdict: Verdict,
    facts: Facts,
  ): void {
    if (!hook) return
    try {
      hook(verdict, facts)
    } catch (err) {
      console.warn('haia: policy hook threw', err)
    }
  }
}

export function createHaiaClient(cfg: HaiaConfig): HaiaClient {
  return new HaiaClient(cfg)
}
