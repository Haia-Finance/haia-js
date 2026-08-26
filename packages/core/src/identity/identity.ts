import type { IdentityMeta } from '@haia/types'
import { ulid } from '../id'
import type { Runtime } from '../runtime'

const ANON_KEY = 'haia.anonymous_id'
const USER_KEY = 'haia.user_id'

/**
 * Имена ключей идентичности в `meta`. Единственное место, где они записаны
 * литералами: те же имена сервер читает при записи события, поэтому
 * расхождение не ломает запрос, а тихо делает строку невидимой для аналитики.
 */
export const IDENTITY_META_KEYS = ['userId', 'anonymousId'] as const

/**
 * Источник идентичности для конверта — ровно то, что нужно горячему пути.
 *
 * Policy-клиент зависит от этого интерфейса, а не от класса `Identity`: ему
 * нужен снимок, а не хранилище. Заодно это делает выразимым случай «источник
 * не дал ничего» — сам `Identity` его не порождает (см. `fallback`), но
 * подмешивание обязано его переживать: партнёр волен подставить свой источник,
 * и конверт всё равно должен уйти, а не упасть на денежном пути.
 */
export interface IdentitySource {
  meta(): IdentityMeta
}

/**
 * Identity: anonymous_id ↔ user_id ↔ wallet address. Адрес как identity.
 *
 * Один экземпляр на клиента, и это существенно: и горячий путь (конверт
 * `guard()`), и холодный (события аналитики) берут `anonymousId` отсюда, а
 * сервер стыкует «намерение → вердикт → исполнение» именно по нему. Две копии
 * с разными значениями не сломали бы ни один запрос — просто воронка перестала
 * бы склеиваться.
 */
export class Identity implements IdentitySource {
  /**
   * Теневое значение на случай, когда запись в storage провалилась (квота,
   * приватный режим). Держит id стабильным в пределах сессии: без него каждый
   * вызов генерировал бы новый, и горячий путь разошёлся бы с холодным ровно
   * там, где их нужно склеить.
   *
   * Заполняется ТОЛЬКО когда `storage.set` бросил, и очищается, как только
   * запись прошла. Иначе оно затеняло бы storage и после того, как тот снова
   * заработал, — в том числе правки из соседних вкладок.
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

  /** Связывает пользователя (user_id / адрес кошелька) с anonymous_id. */
  setUserId(userId: string): void {
    this.write(USER_KEY, userId)
  }

  userId(): string | null {
    return this.read(USER_KEY)
  }

  /**
   * Снимок для подмешивания в `meta` конверта. Не бросает никогда: гейт стоит
   * на денежном пути, и падать из-за формы конверта нельзя — отсутствующая
   * идентичность это неполные цифры, а не отказ.
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
   * Теневое значение имеет приоритет над storage, и порядок здесь — не
   * стилистика.
   *
   * Оно непусто только когда запись провалилась, то есть в нём лежит наше
   * последнее намерение, а в storage — то, что было до него. Прочитай мы
   * сначала storage, `setUserId` после переполненной квоты не вступил бы в
   * силу никогда: пользователь сменил кошелёк, а конверты и события продолжали
   * бы ехать со старым `userId` — чужая атрибуция денежных действий и чужие
   * строки под запрос на стирание.
   *
   * В обычном же случае fallback пуст, и читается storage — поэтому правка из
   * соседней вкладки по-прежнему видна.
   *
   * Чтение не должно ронять вызывающего: недоступный storage — не авария.
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
   * Запись подтверждается чтением, и это не паранойя: хранилище умеет не
   * только бросать, но и молча не сохранять — так ведёт себя заглушка
   * `{ get: () => null, set: () => {} }`, которую партнёр ставит, чтобы ничего
   * не персистить. Поверь мы `set` на слово, `anonymousId` генерировался бы
   * заново на каждый вызов, и горячий путь разошёлся бы с холодным — без
   * единой ошибки, просто воронка перестала бы склеиваться.
   *
   * Цена — одно лишнее чтение на запись, а записей за сессию единицы.
   */
  private write(key: string, value: string): void {
    try {
      this.runtime.storage.set(key, value)
      if (this.runtime.storage.get(key) === value) {
        this.fallback.delete(key)
        return
      }
    } catch {
      // Проваливаемся в теневое значение — как и при неподтверждённой записи.
    }
    // Не сохранится между перезагрузками — но в этой сессии значение живёт
    // здесь, и обе стороны воронки видят одно и то же.
    this.fallback.set(key, value)
  }
}
