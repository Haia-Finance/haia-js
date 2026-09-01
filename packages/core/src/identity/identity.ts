import type { IdentityMeta } from '@haia/types'
import { ulid } from '../id'
import type { Runtime } from '../runtime'

const ANON_KEY = 'haia.anonymous_id'
const USER_KEY = 'haia.user_id'

/**
 * The names of the identity keys in `meta`. The one place they are written as
 * literals: the server reads the same names when it writes the event, so a
 * disagreement does not break the request — it quietly makes the row invisible
 * to analytics.
 */
export const IDENTITY_META_KEYS = ['userId', 'anonymousId'] as const

/**
 * The identity source for the envelope — exactly what the hot path needs.
 *
 * The policy client depends on this interface rather than on the `Identity`
 * class: it needs a snapshot, not a store. It also makes "the source gave us
 * nothing" expressible — `Identity` itself never produces that case (see
 * `fallback`), but attaching has to survive it: an integrator may plug in
 * their own source, and the envelope must still go out rather than fail on the
 * money path.
 */
export interface IdentitySource {
  meta(): IdentityMeta
}

/**
 * Identity: anonymous_id ↔ user_id ↔ wallet address. The address is the
 * identity.
 *
 * One instance per client, and that matters: both the hot path (the `guard()`
 * envelope) and the cold one (analytics events) take `anonymousId` from here,
 * and the server stitches intent → verdict → execution together on it. Two
 * copies holding different values would break no request at all — the funnel
 * would simply stop joining up.
 */
export class Identity implements IdentitySource {
  /**
   * A shadow value for when a write to storage failed (quota, private mode).
   * It keeps the id stable within the session: without it every call would
   * generate a new one, and the hot path would diverge from the cold one
   * exactly where the two have to be joined.
   *
   * It is populated ONLY when `storage.set` threw, and cleared as soon as a
   * write succeeds. Otherwise it would keep shadowing storage after storage
   * started working again — including edits from other tabs.
   */
  private fallback = new Map<string, string>()

  constructor(private readonly runtime: Runtime) {}

  anonymousId(): string {
    const existing = this.read(ANON_KEY)
    if (existing) return existing
    const id = ulid()
    this.write(ANON_KEY, id)
    return id
  }

  /** Links the user (user_id / wallet address) to the anonymous_id. */
  setUserId(userId: string): void {
    this.write(USER_KEY, userId)
  }

  userId(): string | null {
    return this.read(USER_KEY)
  }

  /**
   * The snapshot attached to the envelope's `meta`. Never throws: the gate sits
   * on the money path and must not fail over envelope shape — missing identity
   * means incomplete numbers, not a refusal.
   */
  meta(): IdentityMeta {
    const anonymousId = this.tryAnonymousId()
    const userId = this.userId() ?? undefined
    return {
      ...(userId ? { userId } : {}),
      ...(anonymousId ? { anonymousId } : {}),
    }
  }

  private tryAnonymousId(): string | undefined {
    try {
      return this.anonymousId() || undefined
    } catch {
      return undefined
    }
  }

  /**
   * The shadow value takes priority over storage, and the order here is not a
   * matter of taste.
   *
   * It is non-empty only when a write failed, which means it holds our latest
   * intent while storage holds what came before it. Were storage read first,
   * `setUserId` after a quota overflow would never take effect: the user
   * switches wallets, and envelopes and events keep going out under the old
   * `userId` — money actions attributed to the wrong person and rows the wrong
   * erasure request would reach.
   *
   * In the normal case the fallback is empty and storage is read, so an edit
   * from another tab is still visible.
   *
   * Reading must not bring the caller down: unavailable storage is not an
   * outage.
   */
  private read(key: string): string | null {
    const pending = this.fallback.get(key)
    if (pending !== undefined) return pending
    try {
      return this.runtime.storage.get(key)
    } catch {
      return null
    }
  }

  /**
   * A write is confirmed by reading it back, and that is not paranoia: storage
   * can not only throw but also silently drop a write — which is exactly what
   * the stub `{ get: () => null, set: () => {} }` does when an integrator
   * installs it to persist nothing. Were `set` taken at its word,
   * `anonymousId` would be regenerated on every call and the hot path would
   * diverge from the cold one — with no error anywhere, the funnel would just
   * stop joining up.
   *
   * The cost is one extra read per write, and there are only a handful of
   * writes per session.
   */
  private write(key: string, value: string): void {
    try {
      this.runtime.storage.set(key, value)
      if (this.runtime.storage.get(key) === value) {
        this.fallback.delete(key)
        return
      }
    } catch {
      // Fall through to the shadow value, same as for an unconfirmed write.
    }
    // It will not survive a reload — but within this session the value lives
    // here, and both sides of the funnel see the same one.
    this.fallback.set(key, value)
  }
}
