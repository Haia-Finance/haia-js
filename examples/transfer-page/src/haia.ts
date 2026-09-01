import type { Facts, Verdict } from '@haia/core'
import { createHaiaClient } from '@haia/core'
import { createLogStore } from './store'
import { observingFetch } from './wire-log'

/**
 * The Haia client. One per application, created at module level: the
 * constructor is pure — no network calls, no `init()` — so it does not need to
 * live in React state and is safe under SSR.
 */

function env(name: string): string | undefined {
  const value = import.meta.env[name]
  // An unset variable arrives from Vite as an empty string, not undefined.
  // The difference matters: `baseUrl: ''` does not mean "take the default", it
  // means an empty host, and the requests would silently go to the page origin.
  return typeof value === 'string' && value !== '' ? value : undefined
}

export const projectId = env('VITE_HAIA_PROJECT_ID') ?? ''
export const publishableKey = env('VITE_HAIA_PUBLISHABLE_KEY') ?? ''
export const baseUrl = env('VITE_HAIA_BASE_URL')

/** With no keys there is nothing to send — the page says so, rather than leaving a 401 in the console. */
export const isConfigured = projectId !== '' && publishableKey !== ''

const latencyBudget = Number(env('VITE_HAIA_LATENCY_BUDGET_MS') ?? Number.NaN)

/** A notice from policy — what an integrator would show the user in production. */
export interface PolicyNotice {
  at: number
  decision: Verdict['decision']
  decisionId: string
  reasons: string[]
  typeKey: string
}

export const policyNotices = createLogStore<PolicyNotice>(10)

function notice(verdict: Verdict, facts: Facts): PolicyNotice {
  return {
    at: Date.now(),
    decision: verdict.decision,
    decisionId: verdict.decisionId,
    reasons: verdict.reasons ?? [],
    typeKey: facts.typeKey,
  }
}

export const haia = createHaiaClient({
  projectId,
  publishableKey,
  baseUrl,
  latencyBudgetMs: Number.isFinite(latencyBudget) ? latencyBudget : undefined,
  environment: 'example',
  // `runtime` is the supported injection point. Here it carries the page's
  // wire-call log (`wire-log.ts`); in production there is no need to replace
  // fetch.
  runtime: { fetch: observingFetch(globalThis.fetch.bind(globalThis)) },
  // `flagged` is the one outcome there is no other way to learn about: the
  // action proceeds, there is no error, the verdict is hot and the consequence
  // is cold. Without the hook an integrator could not tell it from a plain
  // approved.
  onFlagged: (verdict, facts) => {
    policyNotices.push(notice(verdict, facts))
  },
  // `rejected` is duplicated in `HaiaPolicyError`, and catching it at the send
  // site is more convenient — there the outcome is tied to a specific press of
  // Send. The hook is for global UI (a toast, a banner), so it is shown here
  // too.
  onBlocked: (verdict, facts) => {
    policyNotices.push(notice(verdict, facts))
  },
})
