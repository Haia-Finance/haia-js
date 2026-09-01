import { DEFAULT_FAIL_MODE_BY_TYPE_KEY } from '@haia/core'
import { describe, expect, it } from 'vitest'
import { buildFacts, TYPE_KEYS } from './facts'
import { GATED_METHODS } from './methods'

/**
 * Invariants across the package boundary. Both used to rest on a comment and
 * would have drifted apart silently — into either a quiet fail-open on money or
 * made-up facts in the journal.
 */
describe("TYPE_KEYS ⊆ the kernel's fail-mode table", () => {
  // This is what justifies not passing a failMode hint from the family layer:
  // the EVM keys are already covered by the conventions table. Were the
  // invariant to break, a key would fall through to FALLBACK_FAIL_MODE =
  // 'open' and a money action would go through instead of being blocked when
  // policy is unavailable.
  for (const typeKey of Object.values(TYPE_KEYS)) {
    it(`${typeKey} has an explicit fail-mode in the kernel`, () => {
      expect(DEFAULT_FAIL_MODE_BY_TYPE_KEY[typeKey]).toBeDefined()
    })
  }

  it("the family's money keys are fail-closed", () => {
    for (const typeKey of Object.values(TYPE_KEYS)) {
      const expected = typeKey === TYPE_KEYS.signMessage ? 'open' : 'closed'
      expect(DEFAULT_FAIL_MODE_BY_TYPE_KEY[typeKey]).toBe(expected)
    }
  })
})

describe('GATED_METHODS ⊆ what buildFacts can read', () => {
  // A method in the interception list with no branch in buildFacts used to fall
  // silently into the catch-all and pass itself off as a transfer_intent.
  const paramsFor = (method: string): unknown[] =>
    method === 'wallet_sendCalls'
      ? [{ from: '0xf', calls: [{ to: '0xa', value: '0x1' }] }]
      : method.startsWith('eth_signTypedData')
        ? [`0x${'1'.repeat(40)}`, '{"domain":{"chainId":1}}']
        : [{ to: '0xr', value: '0x1' }]

  for (const method of GATED_METHODS) {
    it(`${method} builds facts instead of throwing`, () => {
      const facts = buildFacts({ method, params: paramsFor(method) }, 1)
      expect(facts.length).toBeGreaterThan(0)
      for (const f of facts) {
        expect(f.typeKey.length).toBeGreaterThan(0)
        expect(f.clientEventId.length).toBeGreaterThan(0)
      }
    })
  }

  it('a gated method with no mapping throws explicitly instead of inventing a transfer_intent', () => {
    expect(() => buildFacts({ method: 'wallet_grantPermissions', params: [{}] }, 1)).toThrow(
      /no fact mapping/,
    )
  })
})
