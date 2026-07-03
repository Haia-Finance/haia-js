import type { FailMode, TransactionContext, Verdict } from '@haia/types'
import { DEFAULT_FAIL_MODE, DEFAULT_LATENCY_BUDGET_MS, type HaiaConfig } from '../config'
import type { Runtime } from '../runtime'
import { unref } from '../util'

interface CacheEntry {
  verdict: Verdict
  expiresAt: number
}

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 10_000
const MAX_CACHE_ENTRIES = 1000

/**
 * Горячий путь. Жёсткий timeout = latency budget, кэш решений на окно ttlMs,
 * fail-open/closed per event_type, circuit breaker.
 */
export class PolicyEngine {
  private readonly cache = new Map<string, CacheEntry>()
  private failures = 0
  private breakerOpenUntil = 0
  private warnedClientError = false

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
  ) {}

  async evaluate(ctx: TransactionContext): Promise<Verdict> {
    const key = this.cacheKey(ctx)
    const cached = this.cache.get(key)
    if (cached) {
      if (cached.expiresAt > this.runtime.now()) return cached.verdict
      this.cache.delete(key)
    }

    if (this.runtime.now() < this.breakerOpenUntil) {
      return this.fallback(ctx, 'circuit_open')
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
          'idempotency-key': ctx.clientEventId,
          ...(this.cfg.serverApiKey ? { authorization: `Bearer ${this.cfg.serverApiKey}` } : {}),
        },
        body: JSON.stringify(ctx),
      })
      if (!res.ok) {
        // 4xx (кроме 429) — конфиг/авторизация, а не транзиентная авария:
        // не копим в circuit breaker (ретраи не помогут) и сигналим явной
        // причиной, чтобы мисконфиг serverApiKey/projectId был виден, а не
        // молча маскировался fail-mode под «недоступность».
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.warnClientError(res.status)
          return this.fallback(ctx, `client_error:${res.status}`)
        }
        throw new Error(`policy responded ${res.status}`)
      }
      const verdict = (await res.json()) as Verdict
      this.onSuccess()
      if (verdict.ttlMs && verdict.ttlMs > 0) {
        if (this.cache.size >= MAX_CACHE_ENTRIES) {
          const oldest = this.cache.keys().next().value
          if (oldest !== undefined) this.cache.delete(oldest)
        }
        this.cache.set(key, {
          verdict,
          expiresAt: this.runtime.now() + verdict.ttlMs,
        })
      }
      return verdict
    } catch {
      this.onFailure()
      return this.fallback(ctx, 'unavailable')
    } finally {
      clearTimeout(timer)
    }
  }

  private resolveFailMode(ctx: TransactionContext): FailMode {
    return this.cfg.failMode?.[ctx.eventType] ?? DEFAULT_FAIL_MODE[ctx.eventType]
  }

  private fallback(ctx: TransactionContext, reason: string): Verdict {
    const mode = this.resolveFailMode(ctx)
    return {
      decision: mode === 'open' ? 'approved' : 'rejected',
      decisionId: `fallback:${ctx.clientEventId}`,
      reasons: [`fail_${mode}`, reason],
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
      `haia: policy /evaluate returned ${status}; check serverApiKey/projectId. Applying configured fail-mode.`,
    )
  }

  private onFailure(): void {
    this.failures += 1
    if (this.failures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = this.runtime.now() + BREAKER_COOLDOWN_MS
    }
  }

  /** Ключ кэша по decision-релевантным полям. */
  private cacheKey(ctx: TransactionContext): string {
    return [
      ctx.chain,
      ctx.from ?? '',
      ctx.eventType,
      ctx.to ?? '',
      ctx.method ?? '',
      ctx.spender ?? '',
      ctx.amount ?? ctx.amountRaw ?? '',
      ctx.isUnlimitedApproval ? '1' : '',
    ].join('|')
  }
}
