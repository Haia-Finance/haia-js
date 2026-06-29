import type { Runtime } from '../runtime'
import { randomId } from '../util'

const ANON_KEY = 'haia.anonymous_id'

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
}
