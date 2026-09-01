import type { Facts, FailMode, TypeKey, Verdict } from '@haia/types'
import type { Runtime } from './runtime'

export interface HaiaEndpoints {
  /** The hot path. Defaults to `{baseUrl}/v1/projects/{projectId}/policy/evaluate`. */
  policy: string
  /** The cold path. Defaults to `{baseUrl}/v1/batch`. */
  ingest: string
}

export interface HaiaFailModeConfig {
  /** Fallback for keys outside the conventions table and with no family-layer hint. */
  default?: FailMode
  /** Per-typeKey override — takes priority over everything else. */
  byTypeKey?: Record<TypeKey, FailMode>
}

export interface HaiaConfig {
  projectId: string
  /**
   * The single public client key, with the scopes `{ingest:write,
   * policy:evaluate}`. It is embedded in a public frontend and carries no
   * secret.
   */
  publishableKey: string
  endpoints?: Partial<HaiaEndpoints>
  baseUrl?: string
  /** Latency budget for `/evaluate`, in ms. */
  latencyBudgetMs?: number
  failMode?: HaiaFailModeConfig
  /** A `rejected` verdict: show UI with the reason. Called before the throw. */
  onBlocked?: (verdict: Verdict, facts: Facts) => void
  /**
   * A `flagged` verdict: a notification, not a gate. No return value is
   * expected, an exception is swallowed, and the action reaches the wallet
   * immediately after the hook returns — a step-up confirmation cannot be
   * built here, because the wallet window opens before the user can answer.
   * For a confirmation you need your own gate ahead of the call:
   * `client.guard(facts)` plus your own UI.
   */
  onFlagged?: (verdict: Verdict, facts: Facts) => void
  environment?: string
  runtime?: Partial<Runtime>
}

/**
 * A realistic budget for a cross-region call from a browser: every intercepted
 * call is a full network round trip, with no local bypass and no verdict cache.
 */
export const DEFAULT_LATENCY_BUDGET_MS = 400

export const DEFAULT_API_BASE = 'https://api.haia.finance'

/**
 * The default fail-mode for the keys of the conventions dictionary: money →
 * closed, everything else → open. The table covers the documented typeKeys;
 * unknown keys fall to `failMode.default` (and to `open` otherwise — an unknown
 * key is by definition not in the money class, and fail-closed by default would
 * block every new action on the first timeout).
 */
export const DEFAULT_FAIL_MODE_BY_TYPE_KEY: Record<string, FailMode> = {
  transfer_intent: 'closed',
  swap_intent: 'closed',
  bridge_intent: 'closed',
  token_approval: 'closed',
  contract_call: 'closed',
  sign_message: 'open',
  wallet_connected: 'open',
}

export const FALLBACK_FAIL_MODE: FailMode = 'open'

/**
 * The policy path is per project: the projectId lives in the URL rather than in
 * the body, because the server matches it against the key's scope.
 */
export function resolveEndpoints(cfg: HaiaConfig): HaiaEndpoints {
  const base = (cfg.baseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  // Drop explicit undefined in the overrides: with an unset variable,
  // `endpoints: { policy: process.env.X }` would otherwise overwrite a working
  // URL with undefined and the requests would silently go to the page origin.
  const overrides = Object.fromEntries(
    Object.entries(cfg.endpoints ?? {}).filter(([, v]) => v !== undefined),
  )
  return {
    policy: `${base}/v1/projects/${encodeURIComponent(cfg.projectId)}/policy/evaluate`,
    ingest: `${base}/v1/batch`,
    ...overrides,
  }
}
