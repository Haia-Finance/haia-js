import { describe, expect, it } from 'vitest'
import type { KeyValueStorage, Runtime } from '../runtime'
import { Identity } from './identity'

function identityOn(storage: KeyValueStorage): Identity {
  return new Identity({
    fetch: (() => {}) as unknown as typeof fetch,
    storage,
    now: () => 0,
  } as Runtime)
}

/** localStorage is full: reads work, writes throw. */
function readOnlyStorage(seed: Record<string, string> = {}): KeyValueStorage {
  const store = new Map(Object.entries(seed))
  return {
    get: (k) => store.get(k) ?? null,
    set: () => {
      throw new Error('QuotaExceededError')
    },
  }
}

function memoryStorage(seed: Record<string, string> = {}): KeyValueStorage & {
  raw: Map<string, string>
} {
  const raw = new Map(Object.entries(seed))
  return {
    raw,
    get: (k) => raw.get(k) ?? null,
    set: (k, v) => {
      raw.set(k, v)
    },
  }
}

describe('Identity', () => {
  it('sees an edit from another tab while writes work', () => {
    // The shadow value must not shadow storage in the normal case — otherwise
    // an identify() in one tab would stop reaching another.
    const storage = memoryStorage()
    const identity = identityOn(storage)
    identity.setUserId('u_1')

    storage.raw.set('haia.user_id', 'u_from_other_tab')

    expect(identity.userId()).toBe('u_from_other_tab')
  })

  it('setUserId takes effect even when the write to storage failed', () => {
    // The quota is full and storage holds the previous user. Were storage read
    // first, switching wallets would never take effect: B’s money actions
    // would go out under A's userId (and an erasure request for A would take
    // B's rows).
    const identity = identityOn(readOnlyStorage({ 'haia.user_id': 'u_old' }))

    identity.setUserId('u_new')

    expect(identity.userId()).toBe('u_new')
    expect(identity.meta().userId).toBe('u_new')
  })

  it('keeps anonymousId stable when the write throws', () => {
    const identity = identityOn(readOnlyStorage())

    const first = identity.anonymousId()

    expect(identity.anonymousId()).toBe(first)
    expect(identity.meta().anonymousId).toBe(first)
  })

  it('stops shadowing storage as soon as a write succeeds again', () => {
    let broken = true
    const raw = new Map<string, string>()
    const identity = identityOn({
      get: (k) => raw.get(k) ?? null,
      set: (k, v) => {
        if (broken) throw new Error('QuotaExceededError')
        raw.set(k, v)
      },
    })

    identity.setUserId('u_while_broken')
    broken = false
    identity.setUserId('u_after_recovery')
    raw.set('haia.user_id', 'u_from_other_tab')

    expect(identity.userId()).toBe('u_from_other_tab')
  })

  it('meta() does not throw and omits what is absent', () => {
    const identity = identityOn({
      get: () => {
        throw new Error('storage unavailable')
      },
      set: () => {
        throw new Error('storage unavailable')
      },
    })

    const meta = identity.meta()

    expect(meta).not.toHaveProperty('userId')
    expect(meta.anonymousId).toEqual(expect.any(String))
  })
})

describe('Identity + storage that silently drops the write', () => {
  it('keeps anonymousId stable', () => {
    // `set` does not throw, but `get` then returns null — the "persist
    // nothing" stub. Without confirming the write by reading it back, the id
    // would change on every call.
    const identity = identityOn({ get: () => null, set: () => {} })

    expect(identity.anonymousId()).toBe(identity.anonymousId())
  })

  it('keeps the userId set through setUserId', () => {
    const identity = identityOn({ get: () => null, set: () => {} })

    identity.setUserId('u_42')

    expect(identity.meta().userId).toBe('u_42')
  })
})
