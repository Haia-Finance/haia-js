import type { Facts, FailMode, Verdict } from '@haia/types'
import {
  DEFAULT_FAIL_MODE_BY_TYPE_KEY,
  DEFAULT_LATENCY_BUDGET_MS,
  FALLBACK_FAIL_MODE,
  type HaiaConfig,
} from '../config'
import type { Runtime } from '../runtime'
import { unref } from '../util'

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 10_000

export interface GuardOptions {
  /**
   * Подсказка класса действия от семейного слоя: он знает, денежный ли его
   * typeKey, а ядро — нет. Конфиг партнёра (`failMode.byTypeKey`) её перекрывает.
   */
  failMode?: FailMode
}

/**
 * Клиент горячего пути. Жёсткий timeout = бюджет латентности, fail-mode по
 * классу действия, circuit breaker.
 *
 * Кэша вердиктов НЕТ по построению: каждый гейт — реальный вызов, каждое
 * намерение попадает в серверный журнал. Проверка «гейтится ли действие» —
 * тоже серверная: клиент шлёт всё перехваченное, негейченное получает быстрый
 * `approved` + reason `not_gated`.
 */
export class PolicyClient {
  private failures = 0
  private breakerOpenUntil = 0
  private warnedClientError = false

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
  ) {}

  async evaluate(facts: Facts, opts?: GuardOptions): Promise<Verdict> {
    if (this.runtime.now() < this.breakerOpenUntil) {
      return this.fallback(facts, 'circuit_open', opts)
    }

    const budget = this.cfg.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    unref(timer)
    try {
      const res = await this.runtime.fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // Идемпотентность: id принадлежит вызывающему и НЕ перегенерируется
          // здесь — ретрай того же намерения не плодит записей в журнале и
          // реплеит уже вынесенное решение.
          'idempotency-key': facts.clientEventId,
          authorization: `Bearer ${this.cfg.publishableKey}`,
        },
        body: JSON.stringify({
          clientEventId: facts.clientEventId,
          typeKey: facts.typeKey,
          meta: facts.meta ?? {},
        }),
      })
      if (!res.ok) {
        // 4xx (кроме 429) — конфиг/авторизация, а не транзиентная авария: не
        // копим в circuit breaker (ретраи не помогут) и сигналим явной
        // причиной, чтобы мисконфиг publishableKey/projectId был виден, а не
        // молча маскировался fail-mode под «недоступность».
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.warnClientError(res.status)
          return this.fallback(facts, `client_error:${res.status}`, opts)
        }
        throw new Error(`policy responded ${res.status}`)
      }
      const verdict = (await res.json()) as Verdict
      this.onSuccess()
      return verdict
    } catch {
      this.onFailure()
      return this.fallback(facts, 'unavailable', opts)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Приоритет: явный конфиг партнёра → подсказка семейного слоя → дефолт
   * партнёра → таблица конвенций → `open`.
   */
  private resolveFailMode(facts: Facts, opts?: GuardOptions): FailMode {
    return (
      this.cfg.failMode?.byTypeKey?.[facts.typeKey] ??
      opts?.failMode ??
      this.cfg.failMode?.default ??
      DEFAULT_FAIL_MODE_BY_TYPE_KEY[facts.typeKey] ??
      FALLBACK_FAIL_MODE
    )
  }

  private fallback(facts: Facts, reason: string, opts?: GuardOptions): Verdict {
    const mode = this.resolveFailMode(facts, opts)
    return {
      decision: mode === 'open' ? 'approved' : 'rejected',
      decisionId: `fallback:${facts.clientEventId}`,
      reasons: [`fallback_${mode}`, reason],
    }
  }

  private onSuccess(): void {
    this.failures = 0
    this.breakerOpenUntil = 0
  }

  private warnClientError(status: number): void {
    if (this.warnedClientError) return
    this.warnedClientError = true
    console.warn(
      `haia: policy /evaluate returned ${status}; check publishableKey/projectId. Applying configured fail-mode.`,
    )
  }

  private onFailure(): void {
    this.failures += 1
    if (this.failures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = this.runtime.now() + BREAKER_COOLDOWN_MS
    }
  }
}
