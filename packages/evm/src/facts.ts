import { newClientEventId } from '@haia/core'
import type { Facts } from '@haia/types'
import { weiToDecimalString } from './amount'
import { toCaip2 } from './chain'
import { decodeApproval, decodePermit } from './decode'

export interface RawTx {
  from?: string
  to?: string
  value?: string
  data?: string
}

/** EIP-5792 wallet_sendCalls envelope. */
export interface SendCallsParams {
  from?: string
  chainId?: string | number
  calls?: RawTx[]
}

export interface Eip1193RequestArgs {
  method: string
  params?: unknown[]
}

/**
 * Закрытый enum ключей EVM-семейства. Это деталь механики семейного слоя, а не
 * контракта: сервер принимает произвольную строку.
 */
export const TYPE_KEYS = {
  transfer: 'transfer_intent',
  approval: 'token_approval',
  contractCall: 'contract_call',
  signMessage: 'sign_message',
} as const

/** Строит один или несколько конвертов фактов из запроса (батч ⇒ несколько). */
export function buildFacts(args: Eip1193RequestArgs, chainId: string | number): Facts[] {
  if (args.method === 'wallet_sendCalls') {
    const env = (args.params?.[0] ?? {}) as SendCallsParams
    const chain = env.chainId ?? chainId
    const calls = env.calls ?? []
    if (calls.length === 0) return [txFacts({ from: env.from }, chain)]
    return calls.map((call) => txFacts({ from: env.from, ...call }, chain))
  }
  if (args.method.startsWith('eth_signTypedData')) {
    return [typedDataFacts(args.params, chainId)]
  }
  if (TX_SHAPED.has(args.method)) {
    return [txFacts((args.params?.[0] ?? {}) as RawTx, chainId)]
  }
  // Метод попал в GATED_METHODS, но разбирать его здесь не научили: молча
  // трактовать его params[0] как транзакцию нельзя — в журнал уехали бы
  // выдуманные факты. Явная ошибка на этапе разработки дешевле тихой лжи.
  throw new Error(
    `haia: ${args.method} is gated but has no fact mapping; add a branch in buildFacts`,
  )
}

/** Методы, у которых params[0] — объект транзакции (тот же конверт полей). */
const TX_SHAPED = new Set(['eth_sendTransaction', 'eth_signTransaction'])

/** Отбрасывает undefined: meta плоская, пустые ключи в неё не попадают. */
function compact(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
}

/** Парсит EIP-1193 value (hex quantity) → wei-string; малформенный → undefined. */
function parseValue(value?: string): string | undefined {
  if (!value || value === '0x') return undefined
  try {
    return BigInt(value).toString()
  } catch {
    return undefined
  }
}

/** Селектор — первые 4 байта calldata; ключ словаря конвенций. */
function selectorOf(data?: string): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10) : undefined
}

/** Нативная монета EVM — всегда 18 знаков; для ERC-20 decimals неизвестны. */
const NATIVE_DECIMALS = 18

function txFacts(tx: RawTx, chainId: string | number): Facts {
  const approval = decodeApproval(tx.data)
  const hasCalldata = !!tx.data && tx.data !== '0x'
  const amountRaw = parseValue(tx.value)
  return {
    clientEventId: newClientEventId(),
    // Не помечаем произвольный контракт-вызов как transfer_intent: только
    // нативный перевод без calldata — transfer_intent.
    typeKey: approval
      ? TYPE_KEYS.approval
      : hasCalldata
        ? TYPE_KEYS.contractCall
        : TYPE_KEYS.transfer,
    meta: compact({
      chain: toCaip2(chainId),
      from: tx.from,
      to: tx.to,
      // Словарь конвенций (§3.1) ждёт обе формы: правила паков пишутся и на
      // человекочитаемую `amount`, и на minor units. Для нативного перевода
      // decimals известны; у ERC-20 — нет, там остаётся только amountRaw.
      amount: amountRaw ? weiToDecimalString(amountRaw, NATIVE_DECIMALS) : undefined,
      amountRaw,
      spender: approval?.spender,
      isUnlimitedApproval: approval?.isUnlimitedApproval,
      method: approval?.method,
      selector: selectorOf(tx.data),
    }),
  }
}

interface TypedDataDomain {
  domain?: { chainId?: number | string; verifyingContract?: string }
}

function typedDataFacts(params: unknown[] | undefined, chainId: string | number): Facts {
  const { signer, typedData } = parseTypedData(params)
  const permit = decodePermit(typedData)
  const domainChain = typedData?.domain?.chainId
  return {
    clientEventId: newClientEventId(),
    typeKey: permit ? TYPE_KEYS.approval : TYPE_KEYS.signMessage,
    meta: compact({
      chain: toCaip2(domainChain ?? chainId),
      from: signer,
      to: typedData?.domain?.verifyingContract,
      spender: permit?.spender,
      isUnlimitedApproval: permit?.isUnlimitedApproval,
      method: permit?.method,
    }),
  }
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

/**
 * Раскладывает params подписи typed-data. v3/v4: `[address, data]`;
 * legacy eth_signTypedData: `[data, address]`. Адрес определяем по форме.
 */
function parseTypedData(params: unknown[] | undefined): {
  signer?: string
  typedData?: TypedDataDomain
} {
  const a = params?.[0]
  const b = params?.[1]
  const aIsAddress = typeof a === 'string' && ADDRESS_RE.test(a)
  const signer = aIsAddress ? a : typeof b === 'string' && ADDRESS_RE.test(b) ? b : undefined
  return { signer, typedData: coerceTypedData(aIsAddress ? b : a) }
}

function coerceTypedData(raw: unknown): TypedDataDomain | undefined {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as TypedDataDomain
    } catch {
      return undefined
    }
  }
  if (raw && typeof raw === 'object') return raw as TypedDataDomain
  return undefined
}
