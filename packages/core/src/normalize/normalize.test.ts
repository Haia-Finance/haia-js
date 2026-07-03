import { describe, expect, it } from 'vitest'
import { weiToDecimalString } from './amount'
import { toCaip2 } from './chain'
import { decodeApproval, decodePermit } from './intent'

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

  it('treats a limited approve as not unlimited', () => {
    const small = `${'0'.repeat(62)}64` // 0x64 = 100
    const spender = `${'0'.repeat(24)}${'b'.repeat(40)}`
    const decoded = decodeApproval(`0x095ea7b3${spender}${small}`)
    expect(decoded?.method).toBe('approve')
    expect(decoded?.isUnlimitedApproval).toBe(false)
  })

  it('flags setApprovalForAll(operator, true) as unlimited', () => {
    const operator = `${'0'.repeat(24)}${'c'.repeat(40)}`
    const approvedTrue = `${'0'.repeat(63)}1`
    const decoded = decodeApproval(`0xa22cb465${operator}${approvedTrue}`)
    expect(decoded?.method).toBe('setApprovalForAll')
    expect(decoded?.spender).toBe(`0x${'c'.repeat(40)}`)
    expect(decoded?.isUnlimitedApproval).toBe(true)
  })

  it('returns null for non-approve calldata', () => {
    expect(decodeApproval('0xdeadbeef')).toBeNull()
    expect(decodeApproval(undefined)).toBeNull()
  })
})

describe('decodePermit', () => {
  it('decodes an EIP-2612 Permit with an unlimited value', () => {
    const decoded = decodePermit({
      primaryType: 'Permit',
      domain: { chainId: 1 },
      message: { spender: '0xspender', value: (2n ** 200n).toString() },
    })
    expect(decoded?.method).toBe('permit')
    expect(decoded?.spender).toBe('0xspender')
    expect(decoded?.isUnlimitedApproval).toBe(true)
  })

  it('decodes a Permit2 PermitSingle from details.amount', () => {
    const decoded = decodePermit({
      primaryType: 'PermitSingle',
      message: { spender: '0xspender', details: { amount: '1000' } },
    })
    expect(decoded?.method).toBe('permit')
    expect(decoded?.isUnlimitedApproval).toBe(false)
  })

  it('flags unlimited hidden in a Permit2 PermitBatch (not just details[0])', () => {
    const decoded = decodePermit({
      primaryType: 'PermitBatch',
      message: {
        spender: '0xspender',
        details: [{ amount: '1000' }, { amount: (2n ** 200n).toString() }],
      },
    })
    expect(decoded?.method).toBe('permit')
    expect(decoded?.isUnlimitedApproval).toBe(true)
  })

  it('returns null for non-permit typed data', () => {
    expect(decodePermit({ primaryType: 'Mail', message: { spender: '0x0' } })).toBeNull()
    expect(decodePermit(undefined)).toBeNull()
  })
})
