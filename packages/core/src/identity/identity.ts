import type { Runtime } from '../runtime'
import { randomId } from '../util'

const ANON_KEY = 'haia.anonymous_id'
const USER_KEY = 'haia.user_id'

/**
 * Identity: anonymous_id ↔ user_id ↔ wallet address. Адрес как identity.
 */
export class Identity {
  constructor(private readonly runtime: Runtime) {}

  anonymousId(): string {
    const existing = this.runtime.storage.get(ANON_KEY)
    if (existing) return existing
    const id = randomId()
    this.runtime.storage.set(ANON_KEY, id)
    return id
  }

  /** Связывает пользователя (user_id / адрес кошелька) с anonymous_id. */
  setUserId(userId: string): void {
    this.runtime.storage.set(USER_KEY, userId)
  }

  userId(): string | null {
    return this.runtime.storage.get(USER_KEY)
  }
}
