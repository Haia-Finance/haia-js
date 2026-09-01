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
 * The closed enum of EVM-family keys. A detail of the family layer's machinery,
 * not of the contract: the server accepts an arbitrary string.
 */
export const TYPE_KEYS = {
  transfer: 'transfer_intent',
  approval: 'token_approval',
  contractCall: 'contract_call',
  signMessage: 'sign_message',
} as const

/** Builds one or more fact envelopes from a request (a batch yields several). */
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
  // The method is in GATED_METHODS but nothing here knows how to read it.
  // Silently treating its params[0] as a transaction is not an option — made-up
  // facts would go into the journal. An explicit error during development is
  // cheaper than a quiet lie.
  throw new Error(
    `haia: ${args.method} is gated but has no fact mapping; add a branch in buildFacts`,
  )
}

/** Methods whose params[0] is a transaction object (the same field envelope). */
const TX_SHAPED = new Set(['eth_sendTransaction', 'eth_signTransaction'])

/** Drops undefined: meta is flat, and empty keys do not go into it. */
function compact(meta: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined))
}

/** Parses an EIP-1193 value (hex quantity) into a wei string; malformed → undefined. */
function parseValue(value?: string): string | undefined {
  if (!value || value === '0x') return undefined
  try {
    return BigInt(value).toString()
  } catch {
    return undefined
  }
}

/**
 * The selector — the first 4 bytes of calldata; a key of the conventions
 * dictionary.
 *
 * Lowercasing is mandatory: `decodeApproval` matches selectors already
 * lowercased, and without the same treatment here one and the same transaction
 * with calldata like `0x095EA7B3…` would produce `isUnlimitedApproval: true`
 * next to `selector: '0x095EA7B3'` — and a policy rule written against the
 * canonical selector would silently never match it.
 */
function selectorOf(data?: string): string | undefined {
  return data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : undefined
}

/** The native EVM coin always has 18 decimals; for ERC-20 the decimals are unknown. */
const NATIVE_DECIMALS = 18

function txFacts(tx: RawTx, chainId: string | number): Facts {
  const approval = decodeApproval(tx.data)
  const hasCalldata = !!tx.data && tx.data !== '0x'
  const amountRaw = parseValue(tx.value)
  return {
    clientEventId: newClientEventId(),
    // An arbitrary contract call is not labelled transfer_intent: only a
    // native transfer with no calldata is.
    typeKey: approval
      ? TYPE_KEYS.approval
      : hasCalldata
        ? TYPE_KEYS.contractCall
        : TYPE_KEYS.transfer,
    meta: compact({
      chain: toCaip2(chainId),
      from: tx.from,
      to: tx.to,
      // The conventions dictionary expects both forms: policy rules are
      // written against the human-readable `amount` as well as against minor
      // units. For a native transfer the decimals are known; for ERC-20 they
      // are not, and only amountRaw remains.
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
 * Unpacks the params of a typed-data signature. v3/v4: `[address, data]`;
 * legacy eth_signTypedData: `[data, address]`. The address is identified by its
 * shape.
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
