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

/** localStorage переполнен: чтение работает, запись бросает. */
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
  it('видит правку соседней вкладки, пока запись исправна', () => {
    // Теневое значение не должно затенять storage в обычном случае — иначе
    // identify() в одной вкладке перестал бы доезжать до другой.
    const storage = memoryStorage()
    const identity = identityOn(storage)
    identity.setUserId('u_1')

    storage.raw.set('haia.user_id', 'u_from_other_tab')

    expect(identity.userId()).toBe('u_from_other_tab')
  })

  it('setUserId вступает в силу, даже когда запись в storage провалилась', () => {
    // Квота переполнена, а в storage лежит прошлый пользователь. Прочитай мы
    // сначала storage — смена кошелька не вступила бы в силу никогда, и
    // денежные действия B ушли бы под userId A (а запрос на стирание A забрал
    // бы строки B).
    const identity = identityOn(readOnlyStorage({ 'haia.user_id': 'u_old' }))

    identity.setUserId('u_new')

    expect(identity.userId()).toBe('u_new')
    expect(identity.meta().userId).toBe('u_new')
  })

  it('держит anonymousId стабильным, когда запись бросает', () => {
    const identity = identityOn(readOnlyStorage())

    const first = identity.anonymousId()

    expect(identity.anonymousId()).toBe(first)
    expect(identity.meta().anonymousId).toBe(first)
  })

  it('перестаёт затенять storage, как только запись снова прошла', () => {
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

  it('meta() не бросает и опускает то, чего нет', () => {
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

describe('Identity + storage, который молча теряет запись', () => {
  it('держит anonymousId стабильным', () => {
    // `set` не бросает, но `get` потом отдаёт null — заглушка «ничего не
    // персистить». Без подтверждения записи чтением id менялся бы на каждый
    // вызов.
    const identity = identityOn({ get: () => null, set: () => {} })

    expect(identity.anonymousId()).toBe(identity.anonymousId())
  })

  it('держит userId, заданный через setUserId', () => {
    const identity = identityOn({ get: () => null, set: () => {} })

    identity.setUserId('u_42')

    expect(identity.meta().userId).toBe('u_42')
  })
})
