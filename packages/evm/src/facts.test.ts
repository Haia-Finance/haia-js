import type { Facts } from '@haia/types'
import { describe, expect, it } from 'vitest'
import { buildFacts } from './facts'

const CONVENTION_KEYS = new Set([
  'chain',
  'from',
  'to',
  'amount',
  'amountRaw',
  'assetAddress',
  'assetSymbol',
  'assetDecimals',
  'method',
  'spender',
  'isUnlimitedApproval',
  'selector',
])

const APPROVE_UNLIMITED = `0x095ea7b3${'0'.repeat(24)}${'a'.repeat(40)}${'f'.repeat(64)}`

function metaKeys(facts: Facts[]): string[] {
  return [...new Set(facts.flatMap((f) => Object.keys(f.meta)))]
}

describe('facts match the conventions dictionary', () => {
  const cases: Array<[string, Facts[]]> = [
    [
      'native transfer',
      buildFacts({ method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1' }] }, 1),
    ],
    [
      'approval',
      buildFacts(
        { method: 'eth_sendTransaction', params: [{ to: '0xt', data: APPROVE_UNLIMITED }] },
        1,
      ),
    ],
    [
      'contract call',
      buildFacts({ method: 'eth_sendTransaction', params: [{ to: '0xc', data: '0xdeadbeef' }] }, 1),
    ],
    [
      'batch',
      buildFacts(
        {
          method: 'wallet_sendCalls',
          params: [
            {
              from: '0xf',
              calls: [
                { to: '0xa', value: '0x1' },
                { to: '0xb', data: APPROVE_UNLIMITED },
              ],
            },
          ],
        },
        1,
      ),
    ],
  ]

  for (const [label, facts] of cases) {
    it(`emits only dictionary keys for a ${label}`, () => {
      for (const key of metaKeys(facts)) {
        expect(CONVENTION_KEYS.has(key), `meta.${key} is not in the conventions dictionary`).toBe(
          true,
        )
      }
    })

    it(`emits a flat meta and a non-empty clientEventId for a ${label}`, () => {
      for (const f of facts) {
        expect(f.clientEventId.length).toBeGreaterThan(0)
        expect(typeof f.typeKey).toBe('string')
        for (const [k, v] of Object.entries(f.meta)) {
          expect(v === null || typeof v !== 'object', `meta.${k} must be flat`).toBe(true)
          expect(v, `meta.${k} must not be undefined`).not.toBeUndefined()
        }
      }
    })
  }

  it('gives every call in a batch its own clientEventId', () => {
    const facts = buildFacts(
      {
        method: 'wallet_sendCalls',
        params: [
          {
            from: '0xf',
            calls: [
              { to: '0xa', value: '0x1' },
              { to: '0xb', value: '0x2' },
            ],
          },
        ],
      },
      1,
    )
    expect(new Set(facts.map((f) => f.clientEventId)).size).toBe(2)
  })

  it('emits both amount forms for a native transfer', () => {
    const [f] = buildFacts(
      { method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0x1bc16d674ec80000' }] },
      1,
    )
    expect(f?.meta.amountRaw).toBe('2000000000000000000')
    expect(f?.meta.amount).toBe('2') // policy rules are written against this form too
  })

  it('omits amount for an ERC-20 call, where decimals are unknown', () => {
    const [f] = buildFacts(
      { method: 'eth_sendTransaction', params: [{ to: '0xtoken', data: APPROVE_UNLIMITED }] },
      1,
    )
    expect(f?.meta.amount).toBeUndefined()
  })

  it('keeps amounts as strings, never floats', () => {
    const [f] = buildFacts(
      { method: 'eth_sendTransaction', params: [{ to: '0xr', value: '0xde0b6b3a7640000' }] },
      1,
    )
    expect(f?.meta.amountRaw).toBe('1000000000000000000')
    expect(typeof f?.meta.amountRaw).toBe('string')
  })
})
