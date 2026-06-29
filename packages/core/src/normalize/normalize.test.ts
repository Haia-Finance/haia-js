import { describe, expect, it } from 'vitest'
import { weiToDecimalString } from './amount'
import { toCaip2 } from './chain'
import { decodeApproval } from './intent'

describe('toCaip2', () => {
  it('normalizes aliases and numeric ids', () => {
    expect(toCaip2('ethereum')).toBe('eip155:1')
    expect(toCaip2(8453)).toBe('eip155:8453')
    expect(toCaip2('0x1')).toBe('eip155:1')
    expect(toCaip2('eip155:137')).toBe('eip155:137')
  })
})

describe('weiToDecimalString', () => {
  it('renders decimals without float', () => {
    expect(weiToDecimalString(1_000_000n, 6)).toBe('1')
    expect(weiToDecimalString(1_500_000n, 6)).toBe('1.5')
    expect(weiToDecimalString('0', 18)).toBe('0')
  })
})

describe('decodeApproval', () => {
  it('flags unlimited approvals', () => {
    const max = 'f'.repeat(64)
    const spender = `${'0'.repeat(24)}${'a'.repeat(40)}`
    const decoded = decodeApproval(`0x095ea7b3${spender}${max}`)
    expect(decoded?.isUnlimitedApproval).toBe(true)
    expect(decoded?.spender).toBe(`0x${'a'.repeat(40)}`)
  })

  it('returns null for non-approve calldata', () => {
    expect(decodeApproval('0xdeadbeef')).toBeNull()
    expect(decodeApproval(undefined)).toBeNull()
  })
})
