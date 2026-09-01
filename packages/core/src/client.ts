import type { Facts, Verdict } from '@haia/types'
import { AnalyticsClient } from './analytics/client'
import { type HaiaConfig, resolveEndpoints } from './config'
import { HaiaPolicyError } from './errors'
import { Identity } from './identity/identity'
import { type GuardOptions, PolicyClient } from './policy/client'
import { defaultRuntime } from './runtime'

/**
 * The facade. It holds two independent sub-clients: `policy` (the hot path) and
 * `analytics` (the cold one).
 *
 * The constructor is pure: no network calls, no side effects — SSR-safe, and no
 * `init()`. The client has no server-side configuration to fetch at startup,
 * because whether an action is gated is decided entirely on the server.
 */
export class HaiaClient {
  readonly policy: PolicyClient
  readonly analytics: AnalyticsClient
  readonly identity: Identity

  constructor(private readonly cfg: HaiaConfig) {
    const runtime = { ...defaultRuntime(), ...cfg.runtime }
    const endpoints = resolveEndpoints(cfg)
    this.identity = new Identity(runtime)
    // The same Identity instance goes to both policy and analytics: the server
    // stitches intent → verdict → execution together on anonymousId, and two
    // copies holding different values would quietly break the funnel without
    // breaking anything else.
    this.policy = new PolicyClient(cfg, runtime, endpoints.policy, this.identity)
    this.analytics = new AnalyticsClient(cfg, runtime, endpoints.ingest, this.identity)
  }

  /**
   * The hot path: gate an arbitrary action. Public, so an integrator can gate
   * their own non-standard actions by hand.
   *
   * `rejected` → `onBlocked` is called and `HaiaPolicyError` is thrown.
   * `flagged` → `onFlagged` is called and the action proceeds (the verdict is
   * hot, the consequence is cold).
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

  /** The cold path: fire-and-forget analytics. */
  track(event: string, properties?: Record<string, unknown>, clientEventId?: string): void {
    this.analytics.enqueue({ type: 'track', event, properties, clientEventId })
  }

  /** Links the user (user_id / wallet address) and sends an identify. */
  identify(userId: string, traits?: Record<string, unknown>): void {
    this.identity.setUserId(userId)
    this.analytics.enqueue({ type: 'identify', userId, traits })
  }

  /** An integrator's hook must not break the gate: its exception is not our outage. */
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
