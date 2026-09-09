import type { Decision, Facts, FailMode, GateErrorCode, IdentityMeta, Verdict } from '@haia/types'
import {
  DEFAULT_FAIL_MODE_BY_TYPE_KEY,
  DEFAULT_LATENCY_BUDGET_MS,
  FALLBACK_FAIL_MODE,
  type HaiaConfig,
} from '../config'
import { IDENTITY_META_KEYS, type IdentitySource } from '../identity/identity'
import type { Runtime } from '../runtime'
import { unref } from '../util'

const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 10_000
/**
 * The ceiling on a `Retry-After` the engine asked for. Honouring an arbitrary
 * one would let a single header keep the gate shut for longer than any session
 * lasts, with every action in it decided by the fail-mode instead of a rule.
 */
const MAX_BACKOFF_MS = 60_000

const DECISIONS = new Set<Decision>(['approved', 'rejected', 'flagged'])

/** The published codes. An unknown one is not treated as any of them. */
const GATE_ERROR_CODES = new Set<string>([
  'not_configured',
  'engine_error',
  'engine_unavailable',
  'engine_rate_limited',
  'engine_rejected_request',
])

/** What the developer can do about each code — the half a status cannot say. */
const GATE_ERROR_ADVICE: Record<GateErrorCode, string> = {
  not_configured:
    'This workspace has no policy engine tenant; provisioning one is the fix and a retry is not.',
  engine_error:
    'The policy engine failed on its own terms — a typeKey with no deployment behind it is the usual cause.',
  engine_unavailable: 'The policy engine did not answer.',
  engine_rate_limited:
    'The policy engine is at capacity; the client is backing off before it calls again.',
  engine_rejected_request:
    'The control plane sent the engine a payload it refused; that one is not yours to fix.',
}

/** A gate that reached no verdict, and the reason it publishes for it. */
interface GateError {
  code: GateErrorCode
  /** The engine's own sentence, when it had one. A diagnostic, not user-facing copy. */
  message?: string
}

/**
 * Read the published error body: `{"detail": {"code", "message"}}`.
 *
 * Anything else answers null — a proxy's HTML 502, an empty body, a code from
 * a newer contract this build does not know. The caller then falls back to
 * reading the status, which is all a body like that leaves to go on.
 */
async function parseGateError(res: Response): Promise<GateError | null> {
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return null
  }
  const detail = (body as { detail?: unknown } | null)?.detail
  if (!detail || typeof detail !== 'object') return null
  const { code, message } = detail as Record<string, unknown>
  if (typeof code !== 'string' || !GATE_ERROR_CODES.has(code)) return null
  return {
    code: code as GateErrorCode,
    ...(typeof message === 'string' && message !== '' ? { message } : {}),
  }
}

/**
 * `Retry-After` in its delay-seconds form, which is the one the engine sends.
 * The HTTP-date form is deliberately not parsed: it would make the wall clock
 * load-bearing on the hot path, and the ordinary cooldown is the right answer
 * for a header this client cannot read.
 */
function backoffMs(res: Response): number {
  const raw = res.headers.get('retry-after')
  const seconds = raw === null ? Number.NaN : Number(raw.trim())
  if (!Number.isFinite(seconds) || seconds <= 0) return BREAKER_COOLDOWN_MS
  return Math.min(seconds * 1000, MAX_BACKOFF_MS)
}

/**
 * Validate the verdict: `as Verdict` cannot be trusted — the gate has to tell
 * "the server allowed it" apart from "the server answered with nonsense".
 */
function parseVerdict(body: unknown): Verdict | null {
  if (!body || typeof body !== 'object') return null
  const { decision, decisionId, reasons } = body as Record<string, unknown>
  if (!DECISIONS.has(decision as Decision)) return null
  if (typeof decisionId !== 'string' || decisionId === '') return null
  if (reasons !== undefined && !Array.isArray(reasons)) return null
  return {
    decision: decision as Decision,
    decisionId,
    ...(reasons ? { reasons: reasons.filter((r): r is string => typeof r === 'string') } : {}),
  }
}

/**
 * Read the table by own keys only.
 *
 * By contract `typeKey` is an arbitrary opaque string, and an integrator is
 * free to name an action `toString` or `constructor`. Indexing an object
 * literal directly would resolve such a key up the prototype chain: instead of
 * `undefined` it would return an `Object.prototype` function, the integrator's
 * config would be ignored, and `fallback_function toString() {…}` would end up
 * in `reasons`.
 */
function own(table: Record<string, FailMode> | undefined, key: string): FailMode | undefined {
  if (!table || !Object.hasOwn(table, key)) return undefined
  return table[key]
}

export interface GuardOptions {
  /**
   * A hint about the class of the action from the family layer: it knows
   * whether its typeKey is a money action and the kernel does not. The
   * integrator's config (`failMode.byTypeKey`) overrides it.
   */
  failMode?: FailMode
}

/**
 * The hot-path client. A hard timeout equal to the latency budget, a fail-mode
 * chosen by the class of the action, and a circuit breaker.
 *
 * There is NO verdict cache, by construction: every gate is a real call, and
 * every intent lands on the server as its own event. Whether an action is
 * gated at all is a server-side question too — the client sends everything it
 * intercepts, and a verdict comes back only where a policy pack reached one.
 * Every other answer is a published error code, and the fail-mode decides:
 * nothing is waved through on the grounds that no rule looked at it.
 *
 * Identity is attached to the envelope (`withIdentity`); without it the
 * decision record the server writes is counted by no funnel and reached by no
 * erasure request.
 */
export class PolicyClient {
  private failures = 0
  private breakerOpenUntil = 0
  private readonly warnedGateCodes = new Set<GateErrorCode>()
  private warnedClientError = false
  private warnedMalformed = false
  private warnedNoIdentity = false

  constructor(
    private readonly cfg: HaiaConfig,
    private readonly runtime: Runtime,
    private readonly endpoint: string,
    /**
     * Required, not optional: attaching identity is not decoration of the
     * envelope, it is what keeps the decision record visible to any funnel at
     * all. An optional parameter would mean a client that quietly sends
     * identity-less envelopes — exactly the failure this dependency prevents.
     */
    private readonly identity: IdentitySource,
  ) {}

  async evaluate(facts: Facts, opts?: GuardOptions): Promise<Verdict> {
    if (this.runtime.now() < this.breakerOpenUntil) {
      return this.fallback(facts, 'circuit_open', opts)
    }

    const budget = this.cfg.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), budget)
    unref(timer)
    try {
      const res = await this.runtime.fetch(this.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          // Idempotency: the id belongs to the caller and is NOT regenerated
          // here. It is the key the policy engine replays a finished decision
          // by, so a retry of the same intent comes back with that decision
          // rather than a second one.
          'idempotency-key': facts.clientEventId,
          authorization: `Bearer ${this.cfg.publishableKey}`,
        },
        body: JSON.stringify({
          clientEventId: facts.clientEventId,
          typeKey: facts.typeKey,
          // Forwarded verbatim and only when the caller set one. The SDK does
          // not derive it from the typeKey: which base type a pack guards on
          // is the pack's business, and a guessed value matches no rule just
          // as surely as a missing one.
          //
          // `!= null` and not `!== undefined`: the field is bounded 1-128 on
          // the wire, so a null from an untyped caller or an empty string read
          // out of JSON would be a 422 on envelope shape — and on the money
          // path that is a transfer blocked over a field the contract calls
          // optional.
          ...(facts.baseType != null && facts.baseType !== '' ? { baseType: facts.baseType } : {}),
          meta: this.withIdentity(facts.meta),
        }),
      })
      if (!res.ok) {
        const gate = await parseGateError(res)
        if (gate) return this.onGateError(facts, gate, res, opts)
        // No published code: the gateway itself answered (a 401 on the key),
        // or something in between did. The status is then all there is to go
        // on. A 4xx other than 429 is configuration or authorization, not a
        // transient outage: it is not counted toward the circuit breaker
        // (retries will not help) and is reported with an explicit reason, so
        // a misconfigured publishableKey/projectId is visible instead of being
        // quietly disguised as "unavailable" by the fail-mode.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) {
          this.warnClientError(res.status)
          return this.fallback(facts, `client_error:${res.status}`, opts)
        }
        throw new Error(`policy responded ${res.status}`)
      }
      const verdict = parseVerdict(await res.json())
      // An invalid body under a 200 is a broken service, not permission:
      // without this check `decision: undefined` would reach the facade, fail
      // to match 'rejected' and silently let a money action through. Treat it
      // as a failure and apply the fail-mode.
      if (!verdict) {
        this.onFailure()
        this.warnMalformed()
        return this.fallback(facts, 'malformed_response', opts)
      }
      this.onSuccess()
      return verdict
    } catch {
      this.onFailure()
      return this.fallback(facts, 'unavailable', opts)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Branch on the published code, not on the status: two of them are 503 and
   * want opposite things, and `engine_error` is a 502 no retry will fix.
   *
   * The fail-mode applies in every branch — the gate reached no verdict, so
   * the class of the action decides, exactly as for a timeout. What the code
   * changes is what happens next: whether the failure counts toward the
   * breaker, how long the client stays off the network, and what the developer
   * is told. The code itself goes into `reasons`, so an integrator's telemetry
   * can tell a misconfigured stand from an engine outage.
   */
  private onGateError(facts: Facts, gate: GateError, res: Response, opts?: GuardOptions): Verdict {
    switch (gate.code) {
      case 'engine_rate_limited':
        // Backing off IS the answer to a rate limit, and this client has no
        // retry of its own to slow down: shut the gate for as long as the
        // engine asked, so the calls behind this one do not spend their
        // latency budget being throttled.
        this.breakerOpenUntil = Math.max(this.breakerOpenUntil, this.runtime.now() + backoffMs(res))
        this.warnGateError(gate)
        break
      case 'engine_unavailable':
        // The engine did not answer: the ordinary outage path, and what the
        // breaker exists for.
        this.onFailure()
        break
      default:
        // not_configured, engine_error, engine_rejected_request: the stand is
        // wrong, not the engine. Every call will be answered the same way, so
        // this does not count toward the breaker — which is there to spare a
        // struggling dependency, not to hide a configuration error — and the
        // engine's own sentence is what a developer fixes it by.
        this.warnGateError(gate)
    }
    return this.fallback(facts, gate.code, opts)
  }

  /**
   * Fills `meta` in with identity on EVERY call, whatever the integration
   * level (transport, action-level, manual `guard`). An integrator forgetting
   * on one of those paths is the whole reason this lives in the SDK, so there
   * is one place it happens and it cannot be bypassed.
   *
   * It fills in what is empty; it does not override. An explicit value from
   * the caller reaches the server unchanged, and the original object is not
   * mutated — the integrator gets their own `facts` back (including inside
   * `HaiaPolicyError`) exactly as they passed them.
   */
  private withIdentity(meta: Facts['meta'] | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = { ...meta }
    const missing = IDENTITY_META_KEYS.filter((key) => out[key] == null)
    // The caller filled both keys in themselves — do not touch the source at
    // all. Not a micro-optimization: reading `anonymousId` CREATES and
    // persists one, so for an integrator who gates with their own identity and
    // no analytics we would be putting a permanent identifier in localStorage
    // that they never asked for and may have no consent for.
    if (missing.length === 0) return out

    const identity = this.readIdentity()
    for (const key of missing) {
      const mixed = identity[key]
      if (mixed !== undefined) out[key] = mixed
    }
    if (out.userId == null && out.anonymousId == null) this.noteMissingIdentity()
    return out
  }

  /**
   * The identity source is not allowed to bring the gate down: someone else's
   * `IdentitySource` may throw, and the price of that is incomplete numbers,
   * not a blocked transfer.
   */
  private readIdentity(): IdentityMeta {
    try {
      return this.identity.meta()
    } catch {
      return {}
    }
  }

  /**
   * Once per session, and only at debug level. An identity-less envelope is
   * not an error: it is accepted, the action is gated as usual, and all that
   * is lost is the analytic reachability of the row. Warning on every call
   * would be noise in the integrator's console for something they did not
   * break.
   *
   * With the built-in `Identity` this branch is unreachable — it always
   * returns an `anonymousId`. It exists for someone else's `IdentitySource`,
   * which is why the advice points there rather than at `identify()`: that
   * would change nothing, since the envelope is filled from the integrator's
   * own source.
   */
  private noteMissingIdentity(): void {
    if (this.warnedNoIdentity) return
    this.warnedNoIdentity = true
    console.debug(
      'haia: policy envelope carries no userId/anonymousId — the decision is still enforced, ' +
        'but the analytics row it writes will not be counted by funnels or reachable by erasure. ' +
        'The configured IdentitySource returned neither key; check its meta() implementation.',
    )
  }

  /**
   * Priority: the integrator's per-key override → the family layer's hint →
   * the conventions table → the integrator's default → `open`.
   *
   * `failMode.default` comes AFTER the table deliberately: it is the fallback
   * for keys the table does not have. Otherwise an integrator who set
   * `default: 'open'` for their own custom keys would silently remove
   * fail-closed from every money action — to weaken those specifically there
   * is an explicit `byTypeKey`.
   */
  private resolveFailMode(facts: Facts, opts?: GuardOptions): FailMode {
    return (
      own(this.cfg.failMode?.byTypeKey, facts.typeKey) ??
      opts?.failMode ??
      own(DEFAULT_FAIL_MODE_BY_TYPE_KEY, facts.typeKey) ??
      this.cfg.failMode?.default ??
      FALLBACK_FAIL_MODE
    )
  }

  private fallback(facts: Facts, reason: string, opts?: GuardOptions): Verdict {
    const mode = this.resolveFailMode(facts, opts)
    return {
      decision: mode === 'open' ? 'approved' : 'rejected',
      decisionId: `fallback:${facts.clientEventId}`,
      reasons: [`fallback_${mode}`, reason],
    }
  }

  private onSuccess(): void {
    this.failures = 0
    // A window the engine asked for is NOT cleared by someone else's success.
    // Actions are gated concurrently — the EIP-1193 wrapper runs a batch
    // through `Promise.all` — so a sibling call answering 200 must not put the
    // client straight back onto an engine that has just refused it. Only a
    // window that has already run out is cleared.
    if (this.breakerOpenUntil <= this.runtime.now()) this.breakerOpenUntil = 0
  }

  private warnMalformed(): void {
    if (this.warnedMalformed) return
    this.warnedMalformed = true
    console.warn(
      'haia: policy /evaluate returned 200 with an unrecognised body; treating as unavailable and applying fail-mode.',
    )
  }

  /**
   * Once per code, not once per call: a misconfigured stand answers the same
   * thing on every action, and a console line per gated action would bury the
   * one that says what to fix.
   */
  private warnGateError(gate: GateError): void {
    if (this.warnedGateCodes.has(gate.code)) return
    this.warnedGateCodes.add(gate.code)
    const said = gate.message ? ` — ${gate.message}` : ''
    console.warn(
      `haia: policy /evaluate answered ${gate.code}${said}. ${GATE_ERROR_ADVICE[gate.code]} ` +
        'Applying the configured fail-mode meanwhile.',
    )
  }

  private warnClientError(status: number): void {
    if (this.warnedClientError) return
    this.warnedClientError = true
    console.warn(
      `haia: policy /evaluate returned ${status}; check publishableKey/projectId. Applying configured fail-mode.`,
    )
  }

  private onFailure(): void {
    this.failures += 1
    if (this.failures >= BREAKER_THRESHOLD) {
      // Never shorten a window already open: the ordinary cooldown must not
      // undercut a longer Retry-After the engine asked for.
      this.breakerOpenUntil = Math.max(
        this.breakerOpenUntil,
        this.runtime.now() + BREAKER_COOLDOWN_MS,
      )
    }
  }
}
