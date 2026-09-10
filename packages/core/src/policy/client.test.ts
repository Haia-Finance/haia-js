import type { Facts, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import type { HaiaConfig } from '../config'
import { asClientEventId } from '../id'
import { Identity, type IdentitySource } from '../identity/identity'
import type { Runtime } from '../runtime'
import { CONTEXT_ID_MAX_LENGTH, PolicyClient } from './client'

const cfg: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_test_123' }

interface Captured {
  url: string
  init: { headers?: Record<string, string>; body?: string; method?: string }
}

function recordingRuntime(
  respond: (n: number) => Response | Promise<Response>,
  now: () => number = () => 1_000,
): {
  runtime: Runtime
  calls: Captured[]
} {
  const calls: Captured[] = []
  const runtime: Runtime = {
    fetch: (async (url: string, init: Captured['init']) => {
      calls.push({ url, init })
      return respond(calls.length)
    }) as unknown as typeof fetch,
    storage: { get: () => null, set: () => {} },
    now,
  }
  return { runtime, calls }
}

/** The published error body: `{"detail": {"code", "message"}}`. */
function gateError(
  code: string,
  status: number,
  extra: { message?: string; headers?: Record<string, string> } = {},
): Response {
  const message = extra.message ?? 'no verdict was reached for this envelope'
  return new Response(JSON.stringify({ detail: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...extra.headers },
  })
}

/** Identity over memory — the same path as a browser with no localStorage. */
function testIdentity(userId?: string): Identity {
  const store = new Map<string, string>()
  const identity = new Identity({
    fetch: (() => {}) as unknown as typeof fetch,
    storage: {
      get: (k) => store.get(k) ?? null,
      set: (k, v) => {
        store.set(k, v)
      },
    },
    now: () => 0,
  })
  if (userId) identity.setUserId(userId)
  return identity
}

function ok(verdict: Partial<Verdict> = {}): Response {
  return new Response(JSON.stringify({ decision: 'approved', decisionId: 'dec_1', ...verdict }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function facts(over: Partial<Facts> = {}): Facts {
  return {
    clientEventId: asClientEventId('01J9ABCDEF'),
    typeKey: 'token_approval',
    meta: { chain: 'eip155:1', from: '0xfrom', spender: '0xspender', isUnlimitedApproval: true },
    ...over,
  }
}

describe('wire contract', () => {
  it('sends the flat facts envelope with publishable-key bearer auth', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(
      cfg,
      runtime,
      'https://api/v1/projects/proj_1/policy/evaluate',
      testIdentity(),
    )

    await client.evaluate(facts())

    const { init } = calls[0] as Captured
    expect(init.method).toBe('POST')
    expect(init.headers?.authorization).toBe('Bearer pk_test_123')
    // Exactly three top-level keys — the envelope is flat, with no nesting.
    const body = JSON.parse(init.body ?? '{}')
    expect(Object.keys(body).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
    expect(body.typeKey).toBe('token_approval')
    expect(body.meta.isUnlimitedApproval).toBe(true)
  })

  it('returns the engine decision a replay carries, minting none of its own', async () => {
    // decisionId is the policy engine's execution id, and clientEventId is the
    // idempotency key it replays a finished decision by — so the same intent
    // comes back with the same id. The SDK has no say in it either way: it
    // returns what the server answered.
    const replayed = { decision: 'flagged' as const, decisionId: 'exec_7', reasons: ['review'] }
    const { runtime } = recordingRuntime(() => ok(replayed))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())
    const intent = facts({ clientEventId: asClientEventId('01JRETRY') })

    const first = await client.evaluate(intent)
    const second = await client.evaluate(intent)

    expect(first).toEqual(replayed)
    expect(second).toEqual(first)
  })

  it('forwards baseType only when the caller set one', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts())
    await client.evaluate(facts({ baseType: 'token_approval_intent' }))

    // Absent means absent: sending `baseType: undefined` would be a fourth key
    // in the envelope, and the packs read the field, not the presence of it.
    expect(Object.keys(JSON.parse(calls[0]?.init.body ?? '{}'))).not.toContain('baseType')
    expect(JSON.parse(calls[1]?.init.body ?? '{}').baseType).toBe('token_approval_intent')
  })

  it('treats a null or empty baseType as no baseType at all', async () => {
    // The field is bounded 1-128 on the wire. An untyped caller passing null,
    // or an empty string read out of JSON, would be a 422 on envelope shape —
    // and on the money path that is a transfer blocked over a field the
    // contract calls optional.
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ baseType: null as unknown as string }))
    await client.evaluate(facts({ baseType: '' }))

    for (const call of calls) {
      expect(Object.keys(JSON.parse(call.init.body ?? '{}'))).not.toContain('baseType')
    }
  })

  it('forwards contextId only when the caller named an operation', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts())
    await client.evaluate(facts({ contextId: 'op_7f3a9c00' }))

    expect(Object.keys(JSON.parse(calls[0]?.init.body ?? '{}'))).not.toContain('contextId')
    expect(JSON.parse(calls[1]?.init.body ?? '{}').contextId).toBe('op_7f3a9c00')
  })

  it('treats a null, empty or whitespace contextId as no operation at all', async () => {
    // The gate trims before it looks and reads a blank as absent, so any of
    // these on the wire would file the decision under no operation while the
    // caller believed otherwise. Whitespace is the realistic one: it is what
    // an untouched form field or a template hole produces.
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ contextId: null as unknown as string }))
    await client.evaluate(facts({ contextId: '' }))
    await client.evaluate(facts({ contextId: '   ' }))

    for (const call of calls) {
      expect(Object.keys(JSON.parse(call.init.body ?? '{}'))).not.toContain('contextId')
    }
  })

  it('trims a padded contextId rather than sending it as the caller typed it', async () => {
    // The value has to equal the one the operation's events carried, and
    // ingest strips those. Sending the padding would leave the two never
    // meeting, with nothing to report it — the receipt would just show no
    // decisions.
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ contextId: '  op_7f3a9c00  ' }))

    expect(JSON.parse(calls[0]?.init.body ?? '{}').contextId).toBe('op_7f3a9c00')
  })

  it('drops an over-long contextId instead of letting it block the action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(
      facts({ contextId: 'o'.repeat(CONTEXT_ID_MAX_LENGTH + 1) }),
    )

    // A 422 on envelope shape becomes the fail-mode, and `transfer_intent`
    // fails closed — so sending it would block a transfer over an id that
    // only decides which receipt a decision appears on.
    expect(Object.keys(JSON.parse(calls[0]?.init.body ?? '{}'))).not.toContain('contextId')
    expect(verdict.decision).toBe('approved')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('warns about an over-long contextId once, not once per action', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())
    const long = 'o'.repeat(CONTEXT_ID_MAX_LENGTH + 1)

    await client.evaluate(facts({ contextId: long }))
    await client.evaluate(facts({ contextId: long }))

    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('sends clientEventId as the Idempotency-Key', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ clientEventId: asClientEventId('01JXYZ') }))

    expect(calls[0]?.init.headers?.['idempotency-key']).toBe('01JXYZ')
  })

  // The idempotency key travels unchanged on both the header and the body: it
  // is what the server deduplicates its journal by and what the engine replays
  // a finished decision by. A retry that renamed the intent would be a second
  // action as far as both are concerned.
  it('keeps the same clientEventId when the caller retries the same intent', async () => {
    const { runtime, calls } = recordingRuntime((n) =>
      n === 1 ? new Response('', { status: 503 }) : ok(),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())
    const intent = facts({ clientEventId: asClientEventId('01JRETRY') })

    await client.evaluate(intent) // 503 → fallback
    await client.evaluate(intent) // a retry of the same intent

    expect(calls.length).toBe(2)
    const ids = calls.map((c) => c.init.headers?.['idempotency-key'])
    expect(ids).toEqual(['01JRETRY', '01JRETRY'])
    expect(JSON.parse(calls[1]?.init.body ?? '{}').clientEventId).toBe('01JRETRY')
  })
})

describe('no verdict caching', () => {
  it('hits the network on every guard, even for identical facts', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())
    const same = facts()

    await client.evaluate(same)
    await client.evaluate(same)
    await client.evaluate(same)

    expect(calls.length).toBe(3)
  })

  it('ignores a server-sent ttl and still re-evaluates', async () => {
    const { runtime, calls } = recordingRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd', ttlMs: 600_000 }), {
          status: 200,
        }),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts())
    await client.evaluate(facts())

    expect(calls.length).toBe(2)
  })
})

describe('fail-mode', () => {
  const down: (n: number) => Response = () => new Response('', { status: 503 })

  it('fails closed for a money typeKey from the conventions table', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'transfer_intent' }))

    expect(verdict.decision).toBe('rejected')
    expect(verdict.reasons).toContain('fallback_closed')
  })

  it('fails open for a non-money typeKey', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.decision).toBe('approved')
    expect(verdict.reasons).toContain('fallback_open')
  })

  it('fails open for an unknown typeKey (not in the money class by definition)', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    expect((await client.evaluate(facts({ typeKey: 'brand_new_key' }))).decision).toBe('approved')
  })

  it('honours a family-layer hint for a typeKey outside the table', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'payout_settlement' }), {
      failMode: 'closed',
    })

    expect(verdict.decision).toBe('rejected')
  })

  it('keeps money fail-closed when the partner sets only failMode.default', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(
      { ...cfg, failMode: { default: 'open' } },
      runtime,
      'https://api',
      testIdentity(),
    )

    // default is the fallback for keys OUTSIDE the conventions table; it must
    // not remove fail-closed from money actions (byTypeKey exists for that).
    expect((await client.evaluate(facts({ typeKey: 'transfer_intent' }))).decision).toBe('rejected')
    expect((await client.evaluate(facts({ typeKey: 'unknown_key' }))).decision).toBe('approved')
  })

  it('lets partner config override both the table and the family hint', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(
      { ...cfg, failMode: { byTypeKey: { transfer_intent: 'open' } } },
      runtime,
      'https://api',
      testIdentity(),
    )

    const verdict = await client.evaluate(facts({ typeKey: 'transfer_intent' }), {
      failMode: 'closed',
    })

    expect(verdict.decision).toBe('approved')
  })
})

describe('malformed responses', () => {
  const cases: Array<[string, string]> = [
    ['empty object', '{}'],
    ['unknown decision', '{"decision":"maybe","decisionId":"d"}'],
    ['missing decisionId', '{"decision":"approved"}'],
    ['not JSON at all', 'ok'],
    ['null body', 'null'],
  ]

  for (const [label, body] of cases) {
    it(`treats a 200 with ${label} as unavailable, not as approval`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { runtime } = recordingRuntime(() => new Response(body, { status: 200 }))
      const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

      // A money action: a broken service has to produce fail-closed rather than
      // slipping through as approved with decision: undefined.
      const verdict = await client.evaluate(facts({ typeKey: 'transfer_intent' }))

      expect(verdict.decision).toBe('rejected')
      warn.mockRestore()
    })
  }

  it('keeps a well-formed verdict intact and drops non-string reasons', async () => {
    const { runtime } = recordingRuntime(
      () =>
        new Response(
          JSON.stringify({ decision: 'flagged', decisionId: 'dec_9', reasons: ['a', 7] }),
          {
            status: 200,
          },
        ),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts())

    expect(verdict.decision).toBe('flagged')
    expect(verdict.decisionId).toBe('dec_9')
    expect(verdict.reasons).toEqual(['a'])
  })
})

describe('error handling', () => {
  it('treats a 401 as a config error (distinct reason), not a transient outage', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = recordingRuntime(() => new Response('unauthorized', { status: 401 }))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' })) // fail-open

    expect(verdict.decision).toBe('approved')
    expect(verdict.reasons).toContain('client_error:401')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does not let 4xx trip the breaker (retries would not help)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => new Response('', { status: 403 }))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(8) // breaker never opened → every call reached the network
    warn.mockRestore()
  })

  it('opens the breaker after a run of outages and stops calling the network', async () => {
    const { runtime, calls } = recordingRuntime(() => new Response('', { status: 503 }))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(5) // the breaker threshold
  })

  it('applies fail-mode — not a blanket block — while the breaker is open', async () => {
    const { runtime } = recordingRuntime(() => new Response('', { status: 503 }))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    for (let i = 0; i < 5; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))
    const opened = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(opened.decision).toBe('approved')
    expect(opened.reasons).toContain('circuit_open')
    // and a money action in the same breaker state is honestly fail-closed
    expect((await client.evaluate(facts({ typeKey: 'transfer_intent' }))).decision).toBe('rejected')
  })

  it('aborts the request when the latency budget is exceeded', async () => {
    const runtime: Runtime = {
      fetch: ((_url: string, init: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 1_000,
    }
    const client = new PolicyClient(
      { ...cfg, latencyBudgetMs: 5 },
      runtime,
      'https://api',
      testIdentity(),
    )

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.reasons).toContain('unavailable')
  })

  it('does not read fail-mode tables through the prototype chain', async () => {
    // By contract typeKey is an arbitrary opaque string. Direct indexing would
    // resolve 'toString' from Object.prototype: the integrator's config would
    // be ignored and a function would end up in reasons.
    const runtime: Runtime = {
      fetch: (async () => {
        throw new Error('down')
      }) as unknown as typeof fetch,
      storage: { get: () => null, set: () => {} },
      now: () => 1_000,
    }
    const client = new PolicyClient(
      { ...cfg, failMode: { default: 'closed' } },
      runtime,
      'https://api',
      testIdentity(),
    )

    const verdict = await client.evaluate(facts({ typeKey: 'toString' }))

    expect(verdict.decision).toBe('rejected') // from failMode.default, not from the prototype
    expect(verdict.reasons).toEqual(['fallback_closed', 'unavailable'])
  })
})

describe('the gate reached no verdict', () => {
  /** The codes a retry cannot fix: the stand is wrong, not the engine. */
  const NOT_RETRYABLE: Array<[string, number]> = [
    ['not_configured', 409],
    ['engine_error', 502],
    ['engine_rejected_request', 500],
  ]

  it('puts the code in reasons and lets the fail-mode decide', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = recordingRuntime(() => gateError('not_configured', 409))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const blocked = await client.evaluate(facts({ typeKey: 'transfer_intent' }))
    const allowed = await client.evaluate(facts({ typeKey: 'sign_message' }))

    // The class of the action decides, exactly as it does for a timeout — and
    // the code rides along in reasons, so an integrator can tell a
    // misconfigured stand from an engine outage in their own telemetry.
    expect(blocked.decision).toBe('rejected')
    expect(blocked.reasons).toEqual(['fallback_closed', 'not_configured'])
    expect(allowed.decision).toBe('approved')
    expect(allowed.reasons).toEqual(['fallback_open', 'not_configured'])
    warn.mockRestore()
  })

  it("relays the engine's own sentence, once per code", async () => {
    // The message is the whole diagnostic value of a 502: it names the stream
    // nothing is deployed for, which is what a developer goes and fixes.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const said = 'policy engine failed (500): no active deployment found for stream token_approval'
    const { runtime } = recordingRuntime(() => gateError('engine_error', 502, { message: said }))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ typeKey: 'sign_message' }))
    await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(warn).toHaveBeenCalledOnce()
    expect(warn.mock.calls[0]?.[0]).toContain(said)
    expect(warn.mock.calls[0]?.[0]).toContain('engine_error')
    warn.mockRestore()
  })

  for (const [code, status] of NOT_RETRYABLE) {
    it(`does not let ${code} trip the breaker (every call would answer the same)`, async () => {
      // The breaker exists to spare a struggling dependency. Nothing here is
      // struggling: opening it would only hide a configuration error behind a
      // fail-mode for ten seconds at a time.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { runtime, calls } = recordingRuntime(() => gateError(code, status))
      const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

      for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

      expect(calls.length).toBe(8)
      warn.mockRestore()
    })
  }

  it('trips the breaker on engine_unavailable, which is the outage a retry is for', async () => {
    const { runtime, calls } = recordingRuntime(() => gateError('engine_unavailable', 503))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(5) // the breaker threshold
  })

  it('backs off on engine_rate_limited instead of spending the next budget being throttled', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() =>
      gateError('engine_rate_limited', 503, { headers: { 'retry-after': '30' } }),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const limited = await client.evaluate(facts({ typeKey: 'sign_message' }))
    const next = await client.evaluate(facts({ typeKey: 'sign_message' }))

    // One rate limit is enough — there is no retry of its own to slow down, so
    // the client stops calling rather than waiting for five of them.
    expect(limited.reasons).toContain('engine_rate_limited')
    expect(calls.length).toBe(1)
    expect(next.reasons).toContain('circuit_open')
    warn.mockRestore()
  })

  it('backs off for the ordinary cooldown when the engine sent no Retry-After', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => gateError('engine_rate_limited', 503))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ typeKey: 'sign_message' }))
    await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(1)
    warn.mockRestore()
  })

  it('caps a Retry-After that would keep the gate shut for a whole session', async () => {
    // A day-long header would leave every action in the session decided by the
    // fail-mode instead of by a rule. Honour it up to a minute, then try again.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    const { runtime, calls } = recordingRuntime(
      (n) =>
        n === 1
          ? gateError('engine_rate_limited', 503, { headers: { 'retry-after': '86400' } })
          : ok(),
      () => clock,
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await client.evaluate(facts({ typeKey: 'sign_message' }))
    clock = 59_000
    await client.evaluate(facts({ typeKey: 'sign_message' }))
    expect(calls.length).toBe(1) // still shut

    clock = 60_001
    expect((await client.evaluate(facts({ typeKey: 'sign_message' }))).decision).toBe('approved')
    expect(calls.length).toBe(2)
    warn.mockRestore()
  })

  it('keeps a backoff that a concurrent success would otherwise clear', async () => {
    // Actions are gated concurrently — the EIP-1193 wrapper runs a batch
    // through Promise.all — so a sibling call answering 200 arrives after the
    // rate limit has already shut the gate. Letting it reopen the gate would
    // put the client straight back onto the engine that just refused it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // The sibling's 200 lands AFTER the rate limit: the order that matters, and
    // the one a real network produces whenever the slower call is the one that
    // succeeded.
    const { runtime, calls } = recordingRuntime((n) =>
      n === 1
        ? gateError('engine_rate_limited', 503, { headers: { 'retry-after': '30' } })
        : new Promise<Response>((resolve) => {
            setTimeout(() => resolve(ok()), 0)
          }),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    await Promise.all([
      client.evaluate(facts({ typeKey: 'sign_message' })),
      client.evaluate(facts({ typeKey: 'sign_message' })),
    ])
    const next = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(2) // both were already in flight; the third is not
    expect(next.reasons).toContain('circuit_open')
    warn.mockRestore()
  })

  it('falls back to the status for a code from a newer contract', async () => {
    // Forward compatibility: a code this build has never heard of must not be
    // guessed at. The status is what is left to read, and a 503 is an outage.
    const { runtime, calls } = recordingRuntime(() => gateError('engine_hiccuped', 503))
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))
    for (let i = 0; i < 7; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.reasons).toEqual(['fallback_open', 'unavailable'])
    expect(calls.length).toBe(5) // counted toward the breaker, like any outage
  })

  it('falls back to the status for an error body with no detail at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime } = recordingRuntime(
      () => new Response('<html>gateway</html>', { status: 400 }),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity())

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.reasons).toContain('client_error:400')
    warn.mockRestore()
  })
})

describe('attaching identity', () => {
  /**
   * A source that gave nothing. `Identity` itself never gets into this state —
   * with storage unavailable it keeps the anonymousId in memory — but attaching
   * has to survive someone else's source: an integrator may plug in their own.
   */
  const noIdentity: IdentitySource = { meta: () => ({}) }

  /** A source that throws: a gate on the money path is not allowed to fail. */
  const throwingIdentity: IdentitySource = {
    meta: () => {
      throw new Error('identity unavailable')
    },
  }

  function metaOf(calls: Captured[], n = 0): Record<string, unknown> {
    return JSON.parse(calls[n]?.init.body ?? '{}').meta
  }

  it('puts both keys in when the user is known', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity('u_42'))

    await client.evaluate(facts())

    expect(metaOf(calls).userId).toBe('u_42')
    expect(metaOf(calls).anonymousId).toEqual(expect.any(String))
  })

  it('sends the envelope as-is with no identity — no exception and no retry', async () => {
    // The gate sits on the money path: unavailable storage is allowed neither
    // to bring the call down nor to turn it into a block.
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', noIdentity)

    const verdict = await client.evaluate(facts())

    expect(verdict.decision).toBe('approved')
    expect(calls.length).toBe(1)
    expect(metaOf(calls)).not.toHaveProperty('userId')
    expect(metaOf(calls)).not.toHaveProperty('anonymousId')
    debug.mockRestore()
  })

  it('reports an identity-less envelope once per session, at debug level only', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { runtime } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', noIdentity)

    await client.evaluate(facts())
    await client.evaluate(facts())
    await client.evaluate(facts())

    expect(debug).toHaveBeenCalledTimes(1)
    debug.mockRestore()
  })

  it('an identity source that throws does not bring the gate down', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', throwingIdentity)

    const verdict = await client.evaluate(facts({ typeKey: 'transfer_intent' }))

    expect(verdict.decision).toBe('approved')
    expect(metaOf(calls)).not.toHaveProperty('anonymousId')
    debug.mockRestore()
  })

  it('keeps anonymousId stable across calls with storage that does not persist', async () => {
    // The "persist nothing" stub does not throw — it silently drops the write.
    // Taken at its word, every call would generate a new id and the hot path
    // would diverge from the cold one exactly where the server joins them.
    const store = { get: () => null, set: () => {} }
    const identity = new Identity({
      fetch: (() => {}) as unknown as typeof fetch,
      storage: store,
      now: () => 0,
    })
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', identity)

    await client.evaluate(facts())
    await client.evaluate(facts())

    expect(metaOf(calls, 1).anonymousId).toBe(metaOf(calls, 0).anonymousId)
  })
})

describe("the caller's identity instead of ours", () => {
  it('does not touch the source when both keys are passed explicitly', async () => {
    // Reading anonymousId CREATES and persists one. For an integrator who gates
    // with their own identity and no analytics, we would be putting a permanent
    // identifier in storage that they never asked for.
    const meta = vi.fn(() => ({ userId: 'u_sdk', anonymousId: 'a_sdk' }))
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', { meta })

    await client.evaluate(
      facts({ meta: { chain: 'eip155:1', userId: 'u_partner', anonymousId: 'a_partner' } }),
    )

    expect(meta).not.toHaveBeenCalled()
    const sent = JSON.parse(calls[0]?.init.body ?? '{}').meta
    expect(sent.userId).toBe('u_partner')
    expect(sent.anonymousId).toBe('a_partner')
  })

  it('fills in only the missing key', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api', testIdentity('u_sdk'))

    await client.evaluate(facts({ meta: { anonymousId: 'a_partner' } }))

    const sent = JSON.parse(calls[0]?.init.body ?? '{}').meta
    expect(sent.anonymousId).toBe('a_partner')
    expect(sent.userId).toBe('u_sdk')
  })
})
