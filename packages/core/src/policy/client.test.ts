import type { Facts, Verdict } from '@haia/types'
import { describe, expect, it, vi } from 'vitest'
import type { HaiaConfig } from '../config'
import type { Runtime } from '../runtime'
import { PolicyClient } from './client'

const cfg: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_test_123' }

interface Captured {
  url: string
  init: { headers?: Record<string, string>; body?: string; method?: string }
}

function recordingRuntime(respond: (n: number) => Response | Promise<Response>): {
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
    now: () => 1_000,
  }
  return { runtime, calls }
}

function ok(verdict: Partial<Verdict> = {}): Response {
  return new Response(JSON.stringify({ decision: 'approved', decisionId: 'dec_1', ...verdict }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function facts(over: Partial<Facts> = {}): Facts {
  return {
    clientEventId: '01J9ABCDEF',
    typeKey: 'token_approval',
    meta: { chain: 'eip155:1', from: '0xfrom', spender: '0xspender', isUnlimitedApproval: true },
    ...over,
  }
}

describe('wire contract (§3)', () => {
  it('sends the flat facts envelope with publishable-key bearer auth', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api/v1/projects/proj_1/policy/evaluate')

    await client.evaluate(facts())

    const { init } = calls[0] as Captured
    expect(init.method).toBe('POST')
    expect(init.headers?.authorization).toBe('Bearer pk_test_123')
    // Ровно три ключа верхнего уровня — конверт плоский, без вложенности.
    const body = JSON.parse(init.body ?? '{}')
    expect(Object.keys(body).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
    expect(body.typeKey).toBe('token_approval')
    expect(body.meta.isUnlimitedApproval).toBe(true)
  })

  it('sends clientEventId as the Idempotency-Key', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api')

    await client.evaluate(facts({ clientEventId: '01JXYZ' }))

    expect(calls[0]?.init.headers?.['idempotency-key']).toBe('01JXYZ')
  })

  it('keeps the same clientEventId when the caller retries the same intent', async () => {
    const { runtime, calls } = recordingRuntime((n) =>
      n === 1 ? new Response('', { status: 503 }) : ok(),
    )
    const client = new PolicyClient(cfg, runtime, 'https://api')
    const intent = facts({ clientEventId: '01JRETRY' })

    await client.evaluate(intent) // 503 → fallback
    await client.evaluate(intent) // ретрай того же намерения

    expect(calls.length).toBe(2)
    const ids = calls.map((c) => c.init.headers?.['idempotency-key'])
    expect(ids).toEqual(['01JRETRY', '01JRETRY'])
    expect(JSON.parse(calls[1]?.init.body ?? '{}').clientEventId).toBe('01JRETRY')
  })
})

describe('no verdict caching (§3.2)', () => {
  it('hits the network on every guard, even for identical facts', async () => {
    const { runtime, calls } = recordingRuntime(() => ok())
    const client = new PolicyClient(cfg, runtime, 'https://api')
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
    const client = new PolicyClient(cfg, runtime, 'https://api')

    await client.evaluate(facts())
    await client.evaluate(facts())

    expect(calls.length).toBe(2)
  })
})

describe('fail-mode', () => {
  const down: (n: number) => Response = () => new Response('', { status: 503 })

  it('fails closed for a money typeKey from the conventions table', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api')

    const verdict = await client.evaluate(facts({ typeKey: 'transfer_intent' }))

    expect(verdict.decision).toBe('rejected')
    expect(verdict.reasons).toContain('fallback_closed')
  })

  it('fails open for a non-money typeKey', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api')

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.decision).toBe('approved')
    expect(verdict.reasons).toContain('fallback_open')
  })

  it('fails open for an unknown typeKey (not in the money class by definition)', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api')

    expect((await client.evaluate(facts({ typeKey: 'brand_new_key' }))).decision).toBe('approved')
  })

  it('honours a family-layer hint for a typeKey outside the table', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(cfg, runtime, 'https://api')

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
    )

    // default — фолбэк для ключей ВНЕ таблицы конвенций; он не должен снимать
    // fail-closed с денежных действий (для этого есть явный byTypeKey).
    expect((await client.evaluate(facts({ typeKey: 'transfer_intent' }))).decision).toBe('rejected')
    expect((await client.evaluate(facts({ typeKey: 'unknown_key' }))).decision).toBe('approved')
  })

  it('lets partner config override both the table and the family hint', async () => {
    const { runtime } = recordingRuntime(down)
    const client = new PolicyClient(
      { ...cfg, failMode: { byTypeKey: { transfer_intent: 'open' } } },
      runtime,
      'https://api',
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
      const client = new PolicyClient(cfg, runtime, 'https://api')

      // Денежное действие: сломанный сервис обязан приводить к fail-closed,
      // а не проскакивать как approved с decision: undefined.
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
    const client = new PolicyClient(cfg, runtime, 'https://api')

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
    const client = new PolicyClient(cfg, runtime, 'https://api')

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' })) // fail-open

    expect(verdict.decision).toBe('approved')
    expect(verdict.reasons).toContain('client_error:401')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('does not let 4xx trip the breaker (retries would not help)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { runtime, calls } = recordingRuntime(() => new Response('', { status: 403 }))
    const client = new PolicyClient(cfg, runtime, 'https://api')

    for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(8) // breaker never opened → каждый вызов дошёл до сети
    warn.mockRestore()
  })

  it('opens the breaker after a run of outages and stops calling the network', async () => {
    const { runtime, calls } = recordingRuntime(() => new Response('', { status: 503 }))
    const client = new PolicyClient(cfg, runtime, 'https://api')

    for (let i = 0; i < 8; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(calls.length).toBe(5) // порог breaker-а
  })

  it('applies fail-mode — not a blanket block — while the breaker is open', async () => {
    const { runtime } = recordingRuntime(() => new Response('', { status: 503 }))
    const client = new PolicyClient(cfg, runtime, 'https://api')

    for (let i = 0; i < 5; i++) await client.evaluate(facts({ typeKey: 'sign_message' }))
    const opened = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(opened.decision).toBe('approved')
    expect(opened.reasons).toContain('circuit_open')
    // а денежное действие в том же состоянии breaker-а — честно fail-closed
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
    const client = new PolicyClient({ ...cfg, latencyBudgetMs: 5 }, runtime, 'https://api')

    const verdict = await client.evaluate(facts({ typeKey: 'sign_message' }))

    expect(verdict.reasons).toContain('unavailable')
  })
})
