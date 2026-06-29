import type { FailMode, TransactionContext, Verdict } from '@haia/types'
import { DEFAULT_FAIL_MODE, DEFAULT_LATENCY_BUDGET_MS, type HaiaConfig } from '../config'
import type { Runtime } from '../runtime'

interface CacheEntry {
  verdict: Verdict
  expiresAt: number
}

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 10_000

/**
 * Горячий путь. Жёсткий timeout = latency budget, кэш решений на окно ttlMs,
 * fail-open/closed per event_type, circuit breaker.
 */
export class PolicyEngine {
  private readonly cache = new Map<string, CacheEntry>()
  private failures = 0
  private breakerOpenUntil = 0

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
  ) {}

  async evaluate(ctx: TransactionContext): Promise<Verdict> {
    const key = this.cacheKey(ctx)
    const cached = this.cache.get(key)
    if (cached && cached.expiresAt > this.runtime.now()) return cached.verdict

    if (this.runtime.now() < this.breakerOpenUntil) {
      return this.fallback(ctx, 'circuit_open')
    }

    const budget = this.cfg.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
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
      if (!res.ok) throw new Error(`policy responded ${res.status}`)
      const verdict = (await res.json()) as Verdict
      this.onSuccess()
      if (verdict.ttlMs && verdict.ttlMs > 0) {
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
      ctx.eventType,
      ctx.to ?? '',
      ctx.method ?? '',
      ctx.spender ?? '',
      ctx.amount ?? '',
    ].join('|')
  }
}
