import type { Decision, Facts, FailMode, Verdict } from '@haia/types'
import {
  DEFAULT_FAIL_MODE_BY_TYPE_KEY,
  DEFAULT_LATENCY_BUDGET_MS,
  FALLBACK_FAIL_MODE,
  type HaiaConfig,
} from '../config'
import type { Runtime } from '../runtime'
import { unref } from '../util'

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 10_000

const DECISIONS = new Set<Decision>(['approved', 'rejected', 'flagged'])

/**
 * Валидация вердикта: доверять `as Verdict` нельзя — гейт обязан отличать
 * «сервер разрешил» от «сервер ответил мусором».
 */
function parseVerdict(body: unknown): Verdict | null {
  if (!body || typeof body !== 'object') return null
  const { decision, decisionId, reasons } = body as Record<string, unknown>
  if (!DECISIONS.has(decision as Decision)) return null
  if (typeof decisionId !== 'string' || decisionId === '') return null
  if (reasons !== undefined && !Array.isArray(reasons)) return null
  return {
    decision: decision as Decision,
    decisionId,
    ...(reasons ? { reasons: reasons.filter((r): r is string => typeof r === 'string') } : {}),
  }
}

/**
 * Чтение таблицы только по собственным ключам.
 *
 * `typeKey` по контракту — произвольная непрозрачная строка, и партнёр волен
 * назвать действие `toString` или `constructor`. Прямая индексация объектного
 * литерала подняла бы такой ключ по цепочке прототипов: вместо `undefined`
 * вернулась бы функция `Object.prototype`, конфиг партнёра оказался бы
 * проигнорирован, а в `reasons` уехало бы `fallback_function toString() {…}`.
 */
function own(table: Record<string, FailMode> | undefined, key: string): FailMode | undefined {
  if (!table || !Object.hasOwn(table, key)) return undefined
  return table[key]
}

export interface GuardOptions {
  /**
   * Подсказка класса действия от семейного слоя: он знает, денежный ли его
   * typeKey, а ядро — нет. Конфиг партнёра (`failMode.byTypeKey`) её перекрывает.
   */
  failMode?: FailMode
}

/**
 * Клиент горячего пути. Жёсткий timeout = бюджет латентности, fail-mode по
 * классу действия, circuit breaker.
 *
 * Кэша вердиктов НЕТ по построению: каждый гейт — реальный вызов, каждое
 * намерение попадает в серверный журнал. Проверка «гейтится ли действие» —
 * тоже серверная: клиент шлёт всё перехваченное, негейченное получает быстрый
 * `approved` + reason `not_gated`.
 */
export class PolicyClient {
  private failures = 0
  private breakerOpenUntil = 0
  private warnedClientError = false
  private warnedMalformed = false

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
  ) {}

  async evaluate(facts: Facts, opts?: GuardOptions): Promise<Verdict> {
    if (this.runtime.now() < this.breakerOpenUntil) {
      return this.fallback(facts, 'circuit_open', opts)
    }

    const budget = this.cfg.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    unref(timer)
    try {
      const res = await this.runtime.fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // Идемпотентность: id принадлежит вызывающему и НЕ перегенерируется
          // здесь — ретрай того же намерения не плодит записей в журнале и
          // реплеит уже вынесенное решение.
          'idempotency-key': facts.clientEventId,
          authorization: `Bearer ${this.cfg.publishableKey}`,
        },
        body: JSON.stringify({
          clientEventId: facts.clientEventId,
          typeKey: facts.typeKey,
          meta: facts.meta ?? {},
        }),
      })
      if (!res.ok) {
        // 4xx (кроме 429) — конфиг/авторизация, а не транзиентная авария: не
        // копим в circuit breaker (ретраи не помогут) и сигналим явной
        // причиной, чтобы мисконфиг publishableKey/projectId был виден, а не
        // молча маскировался fail-mode под «недоступность».
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.warnClientError(res.status)
          return this.fallback(facts, `client_error:${res.status}`, opts)
        }
        throw new Error(`policy responded ${res.status}`)
      }
      const verdict = parseVerdict(await res.json())
      // Невалидное тело при 200 — сломанный сервис, а не разрешение: без
      // проверки `decision: undefined` дошёл бы до фасада, не совпал бы с
      // 'rejected' и молча пропустил денежное действие. Считаем это отказом и
      // применяем fail-mode.
      if (!verdict) {
        this.onFailure()
        this.warnMalformed()
        return this.fallback(facts, 'malformed_response', opts)
      }
      this.onSuccess()
      return verdict
    } catch {
      this.onFailure()
      return this.fallback(facts, 'unavailable', opts)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Приоритет: точечное переопределение партнёра → подсказка семейного слоя →
   * таблица конвенций → дефолт партнёра → `open`.
   *
   * `failMode.default` стоит ПОСЛЕ таблицы намеренно: это фолбэк для ключей,
   * которых в таблице нет. Иначе партнёр, задавший `default: 'open'` ради
   * своих кастомных ключей, молча снял бы fail-closed со всех денежных
   * действий — чтобы ослабить именно их, есть явный `byTypeKey`.
   */
  private resolveFailMode(facts: Facts, opts?: GuardOptions): FailMode {
    return (
      own(this.cfg.failMode?.byTypeKey, facts.typeKey) ??
      opts?.failMode ??
      own(DEFAULT_FAIL_MODE_BY_TYPE_KEY, facts.typeKey) ??
      this.cfg.failMode?.default ??
      FALLBACK_FAIL_MODE
    )
  }

  private fallback(facts: Facts, reason: string, opts?: GuardOptions): Verdict {
    const mode = this.resolveFailMode(facts, opts)
    return {
      decision: mode === 'open' ? 'approved' : 'rejected',
      decisionId: `fallback:${facts.clientEventId}`,
      reasons: [`fallback_${mode}`, reason],
    }
  }

  private onSuccess(): void {
    this.failures = 0
    this.breakerOpenUntil = 0
  }

  private warnMalformed(): void {
    if (this.warnedMalformed) return
    this.warnedMalformed = true
    console.warn(
      'haia: policy /evaluate returned 200 with an unrecognised body; treating as unavailable and applying fail-mode.',
    )
  }

  private warnClientError(status: number): void {
    if (this.warnedClientError) return
    this.warnedClientError = true
    console.warn(
      `haia: policy /evaluate returned ${status}; check publishableKey/projectId. Applying configured fail-mode.`,
    )
  }

  private onFailure(): void {
    this.failures += 1
    if (this.failures >= BREAKER_THRESHOLD) {
      this.breakerOpenUntil = this.runtime.now() + BREAKER_COOLDOWN_MS
    }
  }
}
