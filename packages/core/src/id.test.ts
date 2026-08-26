import { describe, expect, it, vi } from 'vitest'
import { asClientEventId, newClientEventId, ulid } from './id'

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/

describe('newClientEventId — ULID', () => {
  it('is 26 chars of Crockford base32 (no I, L, O, U)', () => {
    for (let i = 0; i < 200; i++) {
      const id = newClientEventId()
      expect(id).toMatch(CROCKFORD)
      expect(id).not.toMatch(/[ILOU]/)
    }
  })

  it('encodes the timestamp in the first 10 chars, monotonically non-decreasing', () => {
    const early = newClientEventId(1_000_000_000_000)
    const later = newClientEventId(1_000_000_000_001)
    const muchLater = newClientEventId(2_000_000_000_000)

    expect(early.slice(0, 10) <= later.slice(0, 10)).toBe(true)
    expect(later.slice(0, 10) < muchLater.slice(0, 10)).toBe(true)
  })

  it('sorts lexicographically by creation time — the reason for ULID over UUID', () => {
    const ids = [3_000_000_000_000, 1_000_000_000_000, 2_000_000_000_000].map((t) =>
      newClientEventId(t),
    )
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]])
  })

  it('shares the time prefix but differs in the random part within one millisecond', () => {
    const now = 1_700_000_000_000
    const a = newClientEventId(now)
    const b = newClientEventId(now)

    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
  })

  it('does not collide across many draws', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => ulid()))
    expect(ids.size).toBe(5_000)
  })

  it('survives an environment without Web Crypto (old React Native)', () => {
    vi.stubGlobal('crypto', undefined) // globalThis.crypto — getter-only в Node
    try {
      const ids = new Set(Array.from({ length: 100 }, () => newClientEventId()))
      for (const id of ids) expect(id).toMatch(CROCKFORD)
      expect(ids.size).toBe(100) // фолбэк на Math.random всё ещё различает id
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('asClientEventId — границы приёма, не схема', () => {
  it('accepts our own ULID', () => {
    const id = newClientEventId()
    expect(asClientEventId(id)).toBe(id)
  })

  it('accepts a UUID — server-side and partner sources keep their formats', () => {
    const uuid = '329eaf20-d85e-4b71-87de-a3ea82ca0db8'
    expect(asClientEventId(uuid)).toBe(uuid)
  })

  it('accepts a partner id at the 64-char boundary', () => {
    const max = 'a'.repeat(64)
    expect(asClientEventId(max)).toBe(max)
  })

  const rejected: Array<[string, string]> = [
    ['empty', ''],
    ['65 chars', 'a'.repeat(65)],
    ['space', 'has space'],
    ['slash', 'a/b'],
    ['unicode', 'идентификатор'],
  ]

  for (const [label, value] of rejected) {
    it(`rejects ${label}`, () => {
      expect(() => asClientEventId(value)).toThrow(/clientEventId/)
    })
  }
})
