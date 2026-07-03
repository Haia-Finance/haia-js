/**
 * Контракт Haia-адаптеров. Чистые типы без рантайма — на них могут зависеть и
 * серверные TS-потребители, не таща рантайм `@haia/core`.
 */

/** CAIP-2 chain id, например "eip155:1". */
export type CaipChainId = string

export interface AssetRef {
  chain: CaipChainId
  address?: string
  symbol?: string
  decimals?: number
}

/**
 * Тип намерения. Намеренно абстрактен (не «EOA tx»), чтобы ERC-4337 (P1) мог
 * заполнить контекст из UserOperation без изменения ядра.
 */
export type EventType =
  | 'transfer_intent'
  | 'swap_intent'
  | 'bridge_intent'
  | 'token_approval'
  | 'contract_call'
  | 'sign_message'
  | 'wallet_connected'

/**
 * Каноническое описание намерения, которое кормит и policy `/evaluate`, и ingest.
 * Суммы — строго decimal-as-string, никакого float. Chain — CAIP-2.
 */
export interface TransactionContext {
  /** ULID — идемпотентность + корреляция intent↔completed. */
  clientEventId: string
  eventType: EventType
  chain: CaipChainId
  asset?: AssetRef
  /** Человекочитаемая сумма, decimal-as-string. */
  amount?: string
  /** Сырая сумма в минимальных единицах (wei), string. */
  amountRaw?: string
  /** Отправитель. Необязателен: многие EIP-1193 кошельки заполняют его сами. */
  from?: string
  to?: string
  /** Для approve — кому выдаётся аппрув. */
  spender?: string
  isUnlimitedApproval?: boolean
  method?: string
  /** schema-on-read; без чувствительных полей. */
  meta?: Record<string, unknown>
}

export type Decision = 'approved' | 'rejected' | 'flagged'

export interface Verdict {
  decision: Decision
  decisionId: string
  reasons?: string[]
  /** Окно кэша решения, мс (приходит от сервера). */
  ttlMs?: number
}

/** Поведение при недоступности policy: open → пропустить, closed → блок. */
export type FailMode = 'open' | 'closed'

/** Segment-совместимые события холодного пути. */
export type AnalyticsEvent =
  | { type: 'track'; event: string; properties?: Record<string, unknown> }
  | { type: 'identify'; userId: string; traits?: Record<string, unknown> }
  | { type: 'page'; name?: string; properties?: Record<string, unknown> }
  | { type: 'screen'; name?: string; properties?: Record<string, unknown> }
