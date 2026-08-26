/**
 * Перевод сырой суммы (wei-scale) в decimal-as-string. Только bigint/строки —
 * никакого float, который «убивает деньги».
 */
export function weiToDecimalString(raw: bigint | string, decimals: number): string {
  const value = typeof raw === 'bigint' ? raw : BigInt(raw)
  const negative = value < 0n
  const abs = negative ? -value : value
  const base = 10n ** BigInt(decimals)
  const whole = abs / base
  const frac = abs % base
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '')
  const out = fracStr ? `${whole.toString()}.${fracStr}` : whole.toString()
  return negative ? `-${out}` : out
}
