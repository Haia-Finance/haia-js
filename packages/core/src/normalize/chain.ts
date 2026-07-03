import type { CaipChainId } from '@haia/types'

const ALIASES: Record<string, CaipChainId> = {
  ethereum: 'eip155:1',
  mainnet: 'eip155:1',
  polygon: 'eip155:137',
  base: 'eip155:8453',
  arbitrum: 'eip155:42161',
  optimism: 'eip155:10',
}

/** Нормализует любое представление сети в CAIP-2 ("eip155:1"). */
export function toCaip2(chain: string | number): CaipChainId {
  if (typeof chain === 'number') return `eip155:${chain}`
  if (chain.includes(':')) return chain
  const alias = ALIASES[chain.toLowerCase()]
  if (alias) return alias
  if (/^\d+$/.test(chain)) return `eip155:${chain}`
  if (chain.startsWith('0x')) return `eip155:${Number.parseInt(chain, 16)}`
  throw new Error(`Cannot normalize chain: ${chain}`)
}
