import type { ClientEventId } from '@haia/types'

/**
 * A ULID with no external dependencies: 48 bits of time plus 80 bits of
 * randomness, Crockford base32, 26 characters.
 *
 * Why a ULID and not a UUID: the time prefix makes the id lexicographically
 * sortable, so the journal of intents and decisions orders by key without a
 * separate time index, and the correlation between intent and execution can be
 * read by eye. The implementation is our own (~30 lines) — carrying a
 * dependency into a package that gets embedded in wallets costs more than
 * maintaining it.
 */

// Crockford base32: no I, L, O or U, so ids are not confused when read aloud.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

/** The bounds ids are admitted under — the same ones the gateway validates.
 * Bounds, not a schema. */
const MAX_LEN = 64
const ALLOWED = /^[A-Za-z0-9_-]+$/

function encodeTime(ms: number): string {
  let out = ''
  let rest = ms
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENCODING[rest % 32] + out
    rest = Math.floor(rest / 32)
  }
  return out
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  const c = globalThis.crypto
  if (c && typeof c.getRandomValues === 'function') return c.getRandomValues(bytes)
  // Fallback for environments without Web Crypto (older React Native). The
  // entropy is weaker here, but the id is not a secret: it exists for
  // idempotency and correlation, not for unpredictability.
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function encodeRandom(): string {
  // 256 is a multiple of 32, so `% 32` spreads bytes evenly over the alphabet.
  const bytes = randomBytes(RANDOM_LEN)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[(bytes[i] as number) % 32]
  return out
}

/**
 * A raw ULID. The only id generator in the SDK — the analytics anonymous_id
 * uses it too, so there is one id format rather than two.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/**
 * A new action id. The time prefix is non-decreasing: two ids issued in the
 * same millisecond share the prefix and differ in the random part.
 */
export function newClientEventId(now: number = Date.now()): ClientEventId {
  return ulid(now) as ClientEventId
}

/**
 * Admits an id we did not generate: an integrator's own identifier in a manual
 * `guard()`, or an id from a server-side source. Bounds and charset are
 * checked — exactly what the gateway checks. Requiring a strict ULID on the way
 * in is deliberately not done: it would cut off non-browser sources with their
 * own formats.
 */
export function asClientEventId(value: string): ClientEventId {
  if (value.length === 0 || value.length > MAX_LEN) {
    throw new Error(`haia: clientEventId must be 1..${MAX_LEN} characters, got ${value.length}`)
  }
  if (!ALLOWED.test(value)) {
    throw new Error('haia: clientEventId must match [A-Za-z0-9_-]')
  }
  return value as ClientEventId
}
