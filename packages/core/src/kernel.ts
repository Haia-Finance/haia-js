import type { TransactionContext } from '@haia/types'
import type { HaiaClient } from './client'
import { toCaip2 } from './normalize/chain'
import { decodeApproval, decodePermit } from './normalize/intent'
import { randomId } from './util'

/**
 * Переиспользуемое ядро перехвата. Многие embedded-кошельки (Privy/Dynamic/CDP/
 * Reown) экспонируют стандартный EIP-1193 provider → один wrapper покрывает их
 * разом, адаптеры остаются тонкими.
 */

export interface Eip1193RequestArgs {
  method: string
  params?: unknown[]
}

export interface Eip1193Provider {
  request(args: Eip1193RequestArgs): Promise<unknown>
}

interface RawTx {
  from?: string
  to?: string
  value?: string
  data?: string
}

/** EIP-5792 wallet_sendCalls envelope. */
interface SendCallsParams {
  from?: string
  chainId?: string | number
  calls?: RawTx[]
}

/** chainId фиксированным значением или резолвером (для live-сетей: chainChanged). */
type ChainIdSource = string | number | (() => string | number)

const GATED_METHODS = new Set([
  'eth_sendTransaction',
  'wallet_sendCalls',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
])

/**
 * Оборачивает EIP-1193 provider: гейтит отправку транзакций и подпись typed-data
 * через policy, после успеха шлёт fire-and-forget аналитику. Батч (wallet_sendCalls)
 * оценивается покалльно — если хоть один call отклонён, весь запрос блокируется.
 */
export function wrapEip1193Provider(
  provider: Eip1193Provider,
  client: HaiaClient,
  chainId: ChainIdSource,
): Eip1193Provider {
  const resolveChainId = (): string | number =>
    typeof chainId === 'function' ? chainId() : chainId

  // Прозрачно прокидываем ВСЕ аргументы (viem передаёт вторым options:
  // dedupe/retryCount/uid), чтобы не терять их на gated/passthrough вызовах.
  const forward = provider.request.bind(provider) as (...args: unknown[]) => Promise<unknown>

  const request = (async (...args: unknown[]) => {
    const reqArgs = (args[0] ?? {}) as Eip1193RequestArgs
    if (!GATED_METHODS.has(reqArgs.method)) {
      return forward(...args)
    }
    const evaluated = await Promise.all(
      buildContexts(reqArgs, resolveChainId()).map(async (ctx) => ({
        ctx,
        verdict: await client.guard(ctx),
      })),
    )
    const blocked = evaluated.find((e) => e.verdict.decision === 'rejected')
    if (blocked) {
      throw new Error(
        `haia: transaction blocked (${blocked.verdict.reasons?.join(', ') ?? 'policy'})`,
      )
    }
    const result = await forward(...args)
    for (const { ctx, verdict } of evaluated) {
      client.track(ctx.eventType, {
        decision: verdict.decision,
        chain: ctx.chain,
        clientEventId: ctx.clientEventId,
      })
    }
    return result
  }) as Eip1193Provider['request']

  // Proxy сохраняет остальной интерфейс провайдера (on/removeListener/…),
  // подменяя только request. Важно:
  //  - Reflect.get без receiver → геттеры исполняются с this=target, иначе
  //    приватные поля (#field) класс-провайдеров бросают TypeError;
  //  - кэш связанных методов → стабильная идентичность (provider.on === provider.on),
  //    иначе removeListener не находит обработчик и подписки текут.
  const boundMethods = new Map<PropertyKey, unknown>()
  return new Proxy(provider, {
    get(target, prop) {
      if (prop === 'request') return request
      const value = Reflect.get(target, prop)
      if (typeof value !== 'function') return value
      let bound = boundMethods.get(prop)
      if (bound === undefined) {
        bound = value.bind(target)
        boundMethods.set(prop, bound)
      }
      return bound
    },
  })
}

/** Строит один или несколько контекстов из запроса (батч ⇒ несколько). */
function buildContexts(args: Eip1193RequestArgs, chainId: string | number): TransactionContext[] {
  if (args.method === 'wallet_sendCalls') {
    const env = (args.params?.[0] ?? {}) as SendCallsParams
    const chain = env.chainId ?? chainId
    const calls = env.calls ?? []
    if (calls.length === 0) return [txContext({ from: env.from }, chain)]
    return calls.map((call) => txContext({ from: env.from, ...call }, chain))
  }
  if (args.method.startsWith('eth_signTypedData')) {
    return [typedDataContext(args.params, chainId)]
  }
  return [txContext((args.params?.[0] ?? {}) as RawTx, chainId)]
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

function txContext(tx: RawTx, chainId: string | number): TransactionContext {
  const approval = decodeApproval(tx.data)
  const hasCalldata = !!tx.data && tx.data !== '0x'
  return {
    clientEventId: randomId(),
    // Не помечаем произвольный контракт-вызов как transfer_intent: только
    // нативный перевод без calldata — transfer_intent.
    eventType: approval ? 'token_approval' : hasCalldata ? 'contract_call' : 'transfer_intent',
    chain: toCaip2(chainId),
    from: tx.from,
    to: tx.to,
    amountRaw: parseValue(tx.value),
    spender: approval?.spender,
    isUnlimitedApproval: approval?.isUnlimitedApproval,
    method: approval?.method,
  }
}

interface TypedDataDomain {
  domain?: { chainId?: number | string; verifyingContract?: string }
}

function typedDataContext(
  params: unknown[] | undefined,
  chainId: string | number,
): TransactionContext {
  const { signer, typedData } = parseTypedData(params)
  const permit = decodePermit(typedData)
  const domainChain = typedData?.domain?.chainId
  return {
    clientEventId: randomId(),
    eventType: permit ? 'token_approval' : 'sign_message',
    chain: toCaip2(domainChain ?? chainId),
    from: signer,
    to: typedData?.domain?.verifyingContract,
    spender: permit?.spender,
    isUnlimitedApproval: permit?.isUnlimitedApproval,
    method: permit?.method,
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
