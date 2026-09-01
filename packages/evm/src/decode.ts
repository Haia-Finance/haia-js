/**
 * Decoding calldata and EIP-712 typed data to recognise approval intents.
 * An unlimited approval is the primary phishing vector, so the decoder lives in
 * one place rather than in every adapter.
 */

const SELECTORS = {
  approve: '0x095ea7b3', // approve(address,uint256)
  increaseAllowance: '0x39509351', // increaseAllowance(address,uint256)
  setApprovalForAll: '0xa22cb465', // setApprovalForAll(address,bool)
} as const

/**
 * The "unlimited" threshold. Real approval amounts (even for a huge supply ×
 * 1e18) stay below 2^128, whereas the sentinel values of max approvals (uint256
 * for ERC-2612, uint160 for Permit2) are certain to exceed it.
 */
const UNLIMITED_THRESHOLD = 2n ** 128n

export interface DecodedApproval {
  method: 'approve' | 'increaseAllowance' | 'setApprovalForAll' | 'permit'
  spender: string
  isUnlimitedApproval: boolean
}

function word(body: string, i: number): string {
  return body.slice(i * 64, i * 64 + 64)
}

function addressFromWord(w: string): string {
  return `0x${w.slice(24)}`
}

function toBigIntOrNull(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v
  if (typeof v === 'number') return BigInt(v)
  if (typeof v === 'string' && v.length > 0) {
    try {
      return BigInt(v)
    } catch {
      return null
    }
  }
  return null
}

/**
 * Decodes approve / increaseAllowance / setApprovalForAll from calldata.
 * Slices only the selector (10 characters), not the whole calldata.
 */
export function decodeApproval(data?: string): DecodedApproval | null {
  if (!data) return null
  const selector = data.slice(0, 10).toLowerCase()
  const body = data.slice(10)

  if (selector === SELECTORS.approve || selector === SELECTORS.increaseAllowance) {
    if (body.length < 128) return null
    const amount = BigInt(`0x${word(body, 1)}`)
    return {
      method: selector === SELECTORS.approve ? 'approve' : 'increaseAllowance',
      spender: addressFromWord(word(body, 0)),
      isUnlimitedApproval: amount >= UNLIMITED_THRESHOLD,
    }
  }

  if (selector === SELECTORS.setApprovalForAll) {
    if (body.length < 128) return null
    // approved === true ⇒ an approval for the whole collection (ERC-721/1155).
    return {
      method: 'setApprovalForAll',
      spender: addressFromWord(word(body, 0)),
      isUnlimitedApproval: BigInt(`0x${word(body, 1)}`) !== 0n,
    }
  }

  return null
}

interface TypedDataShape {
  primaryType?: string
  message?: Record<string, unknown>
}

/**
 * Decodes EIP-712 typed data looking for a gasless approval: EIP-2612 `Permit`
 * and Permit2 `PermitSingle` / `PermitBatch`.
 */
export function decodePermit(typedData: unknown): DecodedApproval | null {
  if (!typedData || typeof typedData !== 'object') return null
  const { primaryType, message } = typedData as TypedDataShape
  if (!message || typeof message.spender !== 'string') return null

  if (primaryType === 'Permit') {
    const value = toBigIntOrNull(message.value)
    return {
      method: 'permit',
      spender: message.spender,
      isUnlimitedApproval: value !== null && value >= UNLIMITED_THRESHOLD,
    }
  }

  if (primaryType === 'PermitSingle' || primaryType === 'PermitBatch') {
    const details = message.details
    // PermitBatch: check EVERY element — an unlimited one can hide outside details[0].
    const list = Array.isArray(details) ? details : [details]
    const isUnlimited = list.some((entry) => {
      const amount = toBigIntOrNull((entry as { amount?: unknown } | undefined)?.amount)
      return amount !== null && amount >= UNLIMITED_THRESHOLD
    })
    return { method: 'permit', spender: message.spender, isUnlimitedApproval: isUnlimited }
  }

  return null
}
