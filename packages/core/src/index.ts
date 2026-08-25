export type {
  AnalyticsEvent,
  ClientEventId,
  Decision,
  Facts,
  FailMode,
  IdentityMeta,
  TypeKey,
  Verdict,
} from '@haia/types'
export { AnalyticsClient } from './analytics/client'
export { createHaiaClient, HaiaClient } from './client'
export {
  DEFAULT_API_BASE,
  DEFAULT_FAIL_MODE_BY_TYPE_KEY,
  DEFAULT_LATENCY_BUDGET_MS,
  type HaiaConfig,
  type HaiaEndpoints,
  type HaiaFailModeConfig,
  resolveEndpoints,
} from './config'
export { asHaiaPolicyError, HaiaPolicyError } from './errors'
export { asClientEventId, newClientEventId } from './id'
export { IDENTITY_META_KEYS, Identity, type IdentitySource } from './identity/identity'
export { type GuardOptions, PolicyClient } from './policy/client'
export type { KeyValueStorage, Runtime } from './runtime'
