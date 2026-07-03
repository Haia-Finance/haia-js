/**
 * Разбор calldata и EIP-712 typed-data для распознавания approval-намерений.
 * unlimited-approval — главный фишинг-вектор, поэтому декодер живёт в ядре, а не
 * в каждом адаптере.
 */

const SELECTORS = {
  approve: '0x095ea7b3', // approve(address,uint256)
  increaseAllowance: '0x39509351', // increaseAllowance(address,uint256)
  setApprovalForAll: '0xa22cb465', // setApprovalForAll(address,bool)
} as const

/**
 * Порог «безлимитности». Реальные суммы аппрувов (даже при огромном supply ×
 * 1e18) не дотягивают до 2^128, тогда как sentinel-значения max-аппрувов
 * (uint256 у ERC-2612, uint160 у Permit2) его заведомо превышают.
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
 * Декодирует approve / increaseAllowance / setApprovalForAll из calldata.
 * Слайсит только селектор (10 символов), не весь calldata.
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
    // approved === true ⇒ аппрув на всю коллекцию (ERC-721/1155).
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
 * Декодирует EIP-712 typed-data на предмет gasless-аппрува: EIP-2612 `Permit`
 * и Permit2 `PermitSingle`/`PermitBatch`.
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
    // PermitBatch: проверяем ВСЕ элементы — безлимит может прятаться не в details[0].
    const list = Array.isArray(details) ? details : [details]
    const isUnlimited = list.some((entry) => {
      const amount = toBigIntOrNull((entry as { amount?: unknown } | undefined)?.amount)
      return amount !== null && amount >= UNLIMITED_THRESHOLD
    })
    return { method: 'permit', spender: message.spender, isUnlimitedApproval: isUnlimited }
  }

  return null
}
