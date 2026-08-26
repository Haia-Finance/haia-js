/**
 * Wire-контракт Haia. Чистые типы без рантайма — на них могут зависеть и
 * серверные TS-потребители, не таща рантайм `@haia/core`.
 */

/** CAIP-2 chain id, например "eip155:1". */
export type CaipChainId = string

/**
 * Ключ вида действия. На wire — непрозрачная строка в неймспейсе haia-cp:
 * сервер не валидирует её против закрытого списка, незнакомый ключ просто не
 * гейтится. Закрытые enum-ы своих ключей держат семейные слои (`@haia/evm` и
 * далее) — это деталь их механики, а не контракта.
 */
export type TypeKey = string

declare const clientEventIdBrand: unique symbol

/**
 * Идентификатор действия: идемпотентность гейта и корреляция
 * намерение↔решение↔исполнение.
 *
 * Тип брендирован намеренно: голая строка не должна попадать в конверт мимо
 * `newClientEventId()` (генерация) или `asClientEventId()` (проверка границ) —
 * иначе в журнал утекают id произвольной формы, а идемпотентность держится на
 * честном слове вызывающего.
 *
 * Форма на wire остаётся либеральной (§3.1): sdk генерирует ULID, но приём
 * ограничен границами и charset-ом, а не схемой — иначе серверные и партнёрские
 * источники со своими id-форматами не смогли бы пользоваться тем же контрактом.
 */
export type ClientEventId = string & { readonly [clientEventIdBrand]: true }

/**
 * Ключи идентичности в `meta`.
 *
 * По форме — обычные ключи `meta`: необязательные, никогда не отвергаемые.
 * По смыслу — особые: сервер поднимает их из конверта в собственные колонки
 * события, которое пишет на каждый вердикт. Строка без них принимается ровно
 * так же, но её не видит ни одна воронка (все фильтруют по
 * `COALESCE(user_id, anonymous_id) IS NOT NULL`) и до неё никогда не доберётся
 * GDPR-каскад — он стирает по пользователю и связанным с ним анонимным id.
 *
 * То есть цена их отсутствия — не отказ, а тихо неполные цифры и неудаляемая
 * запись. Поэтому подмешивает их SDK (`@haia/core` делает это на каждом
 * `guard()`), а не каждый интегратор по памяти.
 */
export interface IdentityMeta {
  /** Аутентифицированный пользователь партнёра (или адрес кошелька). */
  userId?: string
  /** Долигиновый идентификатор устройства; тот же, что у событий аналитики. */
  anonymousId?: string
}

/**
 * Конверт фактов — тело `POST /v1/projects/{projectId}/policy/evaluate`.
 *
 * Обязательны только `clientEventId` и `typeKey`; `meta` плоская и не
 * валидируется (schema-on-read). Имена ключей `meta` — де-факто контракт для
 * правил паков, поэтому берутся из общего словаря конвенций (`userId`,
 * `anonymousId`, `chain`, `from`, `to`, `amount`, `amountRaw`, `spender`,
 * `isUnlimitedApproval`, `method`, `selector`, …), а не изобретаются на месте.
 *
 * Дисциплина значений: суммы — строго строками (человекочитаемая + minor
 * units), chain — CAIP-2, float запрещён. Секреты и чувствительные PII в `meta`
 * запрещены — идентификаторы вне таблиц конвенций (см. `IdentityMeta`) не
 * находит запрос на стирание.
 */
export interface Facts {
  clientEventId: ClientEventId
  typeKey: TypeKey
  /** Плоская, без вложенности. */
  meta: Record<string, unknown> & IdentityMeta
}

export type Decision = 'approved' | 'rejected' | 'flagged'

/**
 * Вердикт резолвера. Не кэшируется: каждый гейт — реальный вызов, каждое
 * намерение журналируется на сервере.
 */
export interface Verdict {
  decision: Decision
  /** id решения РЕЗОЛВЕРА (не движка): маппинг на решателей — внутренний. */
  decisionId: string
  /** Машиночитаемые коды из документированного словаря. */
  reasons?: string[]
}

/** Поведение при недоступности policy: open → пропустить, closed → блок. */
export type FailMode = 'open' | 'closed'

/**
 * Segment-совместимые события холодного пути. `clientEventId` (если задан)
 * служит ключом дедупликации и связывает событие с намерением горячего пути.
 */
export type AnalyticsEvent = { clientEventId?: string } & (
  | { type: 'track'; event: string; properties?: Record<string, unknown> }
  | { type: 'identify'; userId: string; traits?: Record<string, unknown> }
  | { type: 'page'; name?: string; properties?: Record<string, unknown> }
  | { type: 'screen'; name?: string; properties?: Record<string, unknown> }
)
