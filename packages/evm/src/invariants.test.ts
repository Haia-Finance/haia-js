import { DEFAULT_FAIL_MODE_BY_TYPE_KEY } from '@haia/core'
import { describe, expect, it } from 'vitest'
import { buildFacts, TYPE_KEYS } from './facts'
import { GATED_METHODS } from './methods'

/**
 * Инварианты на стыке пакетов. Оба держались на комментарии и разъезжались бы
 * молча — с тихим fail-open на деньгах либо выдуманными фактами в журнале.
 */
describe('TYPE_KEYS ⊆ таблица fail-mode ядра', () => {
  // Этим обоснован отказ от подсказки failMode в семейном слое: ключи EVM уже
  // покрыты таблицей конвенций. Если инвариант сломается, ключ провалится в
  // FALLBACK_FAIL_MODE = 'open' и денежное действие при недоступности policy
  // пройдёт вместо блокировки.
  for (const typeKey of Object.values(TYPE_KEYS)) {
    it(`${typeKey} имеет явный fail-mode в ядре`, () => {
      expect(DEFAULT_FAIL_MODE_BY_TYPE_KEY[typeKey]).toBeDefined()
    })
  }

  it('денежные ключи семейства — fail-closed', () => {
    for (const typeKey of Object.values(TYPE_KEYS)) {
      const expected = typeKey === TYPE_KEYS.signMessage ? 'open' : 'closed'
      expect(DEFAULT_FAIL_MODE_BY_TYPE_KEY[typeKey]).toBe(expected)
    }
  })
})

describe('GATED_METHODS ⊆ разбираемые buildFacts', () => {
  // Метод в списке перехвата без ветки в buildFacts раньше молча уезжал в
  // catch-all и притворялся transfer_intent.
  const paramsFor = (method: string): unknown[] =>
    method === 'wallet_sendCalls'
      ? [{ from: '0xf', calls: [{ to: '0xa', value: '0x1' }] }]
      : method.startsWith('eth_signTypedData')
        ? [`0x${'1'.repeat(40)}`, '{"domain":{"chainId":1}}']
        : [{ to: '0xr', value: '0x1' }]

  for (const method of GATED_METHODS) {
    it(`${method} строит факты, а не падает`, () => {
      const facts = buildFacts({ method, params: paramsFor(method) }, 1)
      expect(facts.length).toBeGreaterThan(0)
      for (const f of facts) {
        expect(f.typeKey.length).toBeGreaterThan(0)
        expect(f.clientEventId.length).toBeGreaterThan(0)
      }
    })
  }

  it('гейтимый метод без маппинга падает явно, а не выдумывает transfer_intent', () => {
    expect(() => buildFacts({ method: 'wallet_grantPermissions', params: [{}] }, 1)).toThrow(
      /no fact mapping/,
    )
  })
})
