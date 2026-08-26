import type { ClientEventId } from '@haia/types'

/**
 * ULID без внешних зависимостей: 48 бит времени + 80 бит случайности,
 * Crockford base32, 26 символов.
 *
 * Почему ULID, а не UUID: временной префикс делает id лексикографически
 * сортируемым, поэтому журнал намерений и решений упорядочивается по ключу без
 * отдельного индекса по времени, а корреляция намерение↔исполнение читается
 * глазами. Реализация своя (~30 строк) — тащить зависимость в пакет, который
 * встраивается в кошельки, дороже, чем её содержать.
 */

// Crockford base32: без I, L, O, U — чтобы id не путались при чтении вслух.
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

/** Границы приёма — те же, что валидирует gateway (§5.1): не схема, а рамки. */
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
  // Фолбэк для сред без Web Crypto (старый RN). Качество энтропии здесь ниже,
  // но id не является секретом: он нужен для идемпотентности и корреляции,
  // а не для непредсказуемости.
  for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  return bytes
}

function encodeRandom(): string {
  // 256 кратно 32, поэтому `% 32` распределяет байты по алфавиту равномерно.
  const bytes = randomBytes(RANDOM_LEN)
  let out = ''
  for (let i = 0; i < RANDOM_LEN; i++) out += ENCODING[(bytes[i] as number) % 32]
  return out
}

/**
 * Сырой ULID. Единственный генератор идентификаторов в SDK — им пользуется и
 * anonymous_id аналитики, чтобы форматов id было не два, а один.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

/**
 * Новый id действия. Временной префикс неубывающий: два id, выданные в одну
 * миллисекунду, делят префикс и различаются случайной частью.
 */
export function newClientEventId(now: number = Date.now()): ClientEventId {
  return ulid(now) as ClientEventId
}

/**
 * Впускает в контракт id, сгенерированный не нами: собственный идентификатор
 * партнёра в manual `guard()`, id из серверного источника. Проверяются границы
 * и charset — ровно то, что проверяет gateway; строгий ULID на приёме запрещён
 * планом §3.1, иначе не-браузерные источники со своими форматами отрезаются.
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
