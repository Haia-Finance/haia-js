/**
 * Разбор calldata для общих ERC-20 методов. Распознавание unlimited-approval —
 * главный фишинг-вектор и цель policy-пресетов, поэтому живёт в ядре, а не в
 * каждом адаптере.
 */

const APPROVE_SELECTOR = '0x095ea7b3'
const MAX_UINT256 = 2n ** 256n - 1n
/** Порог, выше которого approve считаем «безлимитным». */
const UNLIMITED_THRESHOLD = MAX_UINT256 / 2n

export interface DecodedApproval {
  method: 'approve'
  spender: string
  isUnlimitedApproval: boolean
}

export function decodeApproval(data?: string): DecodedApproval | null {
  if (!data || !data.toLowerCase().startsWith(APPROVE_SELECTOR)) return null
  const body = data.slice(APPROVE_SELECTOR.length)
  if (body.length < 128) return null
  const spenderWord = body.slice(0, 64)
  const amountWord = body.slice(64, 128)
  const spender = `0x${spenderWord.slice(24)}`
  const amount = BigInt(`0x${amountWord}`)
  return {
    method: 'approve',
    spender,
    isUnlimitedApproval: amount >= UNLIMITED_THRESHOLD,
  }
}
