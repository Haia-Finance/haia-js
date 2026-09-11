import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { HaiaConfig } from './config'
import { asClientEventId } from './id'
import { IDENTITY_META_KEYS, Identity } from './identity/identity'
import { CONTEXT_ID_MAX_LENGTH, PolicyClient } from './policy/client'
import type { Runtime } from './runtime'

/**
 * Contract test against the wire fixtures in `contracts/policy/v1/` — the
 * executable form of the policy/evaluate contract. The gateway validates
 * envelopes against these files and this SDK builds envelopes from them, so a
 * disagreement between the two shows up as a failing unit test here rather
 * than as a 422 at integration time.
 *
 * The fixtures are a vendored snapshot; see `contracts/PROVENANCE.md` for how
 * it is kept current.
 */

const CONTRACT_URL = new URL('../../../contracts/policy/v1/', import.meta.url)
// fileURLToPath, not .pathname: pathname is percent-encoded, so in a clone
// under a path with a space ('~/My Projects/haia-js') existsSync would be
// handed '%20' and answer false.
const CONTRACT_DIR = fileURLToPath(CONTRACT_URL)

function loadJson(rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(rel, CONTRACT_URL), 'utf8'))
}

interface ContractCase {
  file: string
  accepted?: boolean
  reason?: string
  note?: string
}

/** A published error code: the body, the status it comes with, and whether a retry can help. */
interface ContractError {
  file: string
  status: number
  code: string
  retry: boolean
  note?: string
}

interface ContractIndex {
  request: { path: string; headers: Record<string, string> }
  cases: ContractCase[]
  verdicts: string[]
  errors: ContractError[]
  limits: {
    clientEventId: { maxLength: number; charset: string }
    typeKey: { minLength: number; maxLength: number }
    baseType: { minLength: number; maxLength: number }
    contextId: { maxLength: number }
  }
}

const index = loadJson('index.json') as unknown as ContractIndex

const cfg: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_1' }

/** Captures the body of the outgoing request and lets a response be scripted. */
function captureRuntime(response: () => Response): {
  runtime: Runtime
  body: () => Record<string, unknown>
  headers: () => Record<string, string>
  count: () => number
} {
  let sent: Record<string, unknown> = {}
  let headers: Record<string, string> = {}
  let calls = 0
  const runtime: Runtime = {
    fetch: (async (_url: string, init: { body?: string; headers?: Record<string, string> }) => {
      calls += 1
      sent = JSON.parse(init.body ?? '{}')
      headers = init.headers ?? {}
      return response()
    }) as unknown as typeof fetch,
    storage: (() => {
      const store = new Map<string, string>()
      return {
        get: (k: string) => store.get(k) ?? null,
        set: (k: string, v: string) => {
          store.set(k, v)
        },
      }
    })(),
    now: () => 0,
  }
  return { runtime, body: () => sent, headers: () => headers, count: () => calls }
}

/** Identity on the same runtime as the client, as in HaiaClient. */
function identityOf(runtime: Runtime): Identity {
  return new Identity(runtime)
}

describe('the manifest covers every file (no undeclared fixtures)', () => {
  // The snapshot is data only. A stray file here means a re-vendor copied
  // something that is not part of the artifact — prose belongs to whoever owns
  // the directory it lives in, and prose written elsewhere carries links that
  // do not resolve here.
  it('holds the manifest and the three fixture directories, nothing else', () => {
    // Dotfiles are ignored: .DS_Store is a fact about opening the directory in
    // Finder, not about what was vendored, and failing on it would train
    // people to ignore this test.
    const entries = readdirSync(CONTRACT_DIR).filter((name) => !name.startsWith('.'))
    expect(entries.sort()).toEqual(['envelopes', 'errors', 'index.json', 'verdicts'])
  })

  it('every *.json in envelopes/, verdicts/ and errors/ is named in index.json', () => {
    const declared = new Set([
      'index.json',
      ...index.cases.map((c) => c.file),
      ...index.verdicts,
      ...index.errors.map((e) => e.file),
    ])
    for (const dir of ['envelopes', 'verdicts', 'errors']) {
      for (const name of readdirSync(new URL(`${dir}/`, CONTRACT_URL))) {
        if (name.endsWith('.json')) {
          expect(
            declared.has(`${dir}/${name}`),
            `${dir}/${name} is not declared in index.json`,
          ).toBe(true)
        }
      }
    }
  })
})

describe('the clientEventId bounds match the manifest', () => {
  const { maxLength, charset } = index.limits.clientEventId

  it(`the manifest charset is ${charset}`, () => {
    expect(charset).toBe('[A-Za-z0-9_-]')
  })

  it(`accepts an id of exactly ${maxLength} characters`, () => {
    const atLimit = 'a'.repeat(maxLength)
    expect(asClientEventId(atLimit)).toBe(atLimit)
  })

  it(`rejects an id of ${maxLength + 1} characters`, () => {
    expect(() => asClientEventId('a'.repeat(maxLength + 1))).toThrow()
  })

  it('rejects a character outside the manifest charset', () => {
    expect(() => asClientEventId('01J9$X8Y')).toThrow()
  })
})

describe('asClientEventId ↔ the fixture envelopes', () => {
  // The SDK validates the clientEventId specifically (bounds, not a schema).
  // Every envelope that has the field is run through: valid-* carry a good id
  // and invalid-*-client-event-id a bad one. The other invalid-* cases
  // (typeKey, meta) are validated by the server, and the SDK cannot construct
  // such Facts anyway (a closed typeKey enum and a branded id).
  for (const c of index.cases) {
    const envelope = loadJson(c.file) as { clientEventId?: unknown }
    const id = envelope.clientEventId
    if (typeof id !== 'string') continue // missing-client-event-id — nothing to validate

    const aboutClientEventId = c.file.includes('client-event-id')
    if (c.accepted) {
      it(`${c.file}: accepts the id`, () => {
        expect(asClientEventId(id)).toBe(id)
      })
    } else if (aboutClientEventId) {
      it(`${c.file}: rejects the id (${c.reason})`, () => {
        expect(() => asClientEventId(id)).toThrow()
      })
    }
  }
})

describe('the SDK builds an envelope of valid shape', () => {
  it('sends exactly {clientEventId, typeKey, meta} to the per-project path for a canonical action', async () => {
    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const client = new PolicyClient(
      cfg,
      cap.runtime,
      'https://api/v1/projects/proj_1/policy/evaluate',
      identityOf(cap.runtime),
    )

    await client.evaluate({
      clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7V9'),
      typeKey: 'token_approval',
      meta: { chain: 'eip155:1', isUnlimitedApproval: true },
    })

    const body = cap.body()
    // The top level ⊆ the keys the manifest allows.
    expect(Object.keys(body).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
    // The clientEventId would pass the gateway validation.
    expect(() => asClientEventId(body.clientEventId as string)).not.toThrow()
    expect(cap.headers()['idempotency-key']).toBe(body.clientEventId)
    expect((body.typeKey as string).length).toBeGreaterThanOrEqual(index.limits.typeKey.minLength)
  })
})

describe('baseType — the field the packs guard their rules on', () => {
  const baseTypeCase = index.cases.find((c) => c.file.includes('with-base-type'))

  it('the manifest declares a baseType case', () => {
    expect(baseTypeCase, 'index.json lost envelopes/valid-with-base-type.json').toBeDefined()
    expect(baseTypeCase?.accepted).toBe(true)
  })

  it('the SDK sends it verbatim, as a fourth top-level key', async () => {
    const fixture = loadJson(baseTypeCase?.file ?? '') as {
      clientEventId: string
      typeKey: string
      baseType: string
      meta: Record<string, unknown>
    }
    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

    await client.evaluate({
      clientEventId: asClientEventId(fixture.clientEventId),
      typeKey: fixture.typeKey,
      baseType: fixture.baseType,
      meta: fixture.meta,
    })

    const body = cap.body()
    expect(Object.keys(body).sort()).toEqual(['baseType', 'clientEventId', 'meta', 'typeKey'])
    // Verbatim: nothing derived from the typeKey, because which base type a
    // pack guards on is the pack's business and a guessed one matches no rule.
    expect(body.baseType).toBe(fixture.baseType)
    expect((body.baseType as string).length).toBeLessThanOrEqual(index.limits.baseType.maxLength)
  })
})

describe('contextId — the operation a decision belongs to', () => {
  const contextCase = index.cases.find((c) => c.file.includes('valid-with-context'))

  it('the manifest declares a contextId case', () => {
    expect(contextCase, 'index.json lost envelopes/valid-with-context.json').toBeDefined()
    expect(contextCase?.accepted).toBe(true)
  })

  it('the SDK sends it verbatim, as a fifth top-level key', async () => {
    const fixture = loadJson(contextCase?.file ?? '') as {
      clientEventId: string
      typeKey: string
      contextId: string
      meta: Record<string, unknown>
    }
    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

    await client.evaluate({
      clientEventId: asClientEventId(fixture.clientEventId),
      typeKey: fixture.typeKey,
      contextId: fixture.contextId,
      meta: fixture.meta,
    })

    const body = cap.body()
    expect(Object.keys(body).sort()).toEqual(['clientEventId', 'contextId', 'meta', 'typeKey'])
    // Verbatim, and never derived from clientEventId: that id names this one
    // call, and using it as the operation would file every call of an
    // operation as an operation of its own.
    expect(body.contextId).toBe(fixture.contextId)
    expect((body.contextId as string).length).toBeLessThanOrEqual(index.limits.contextId.maxLength)
  })

  it('an operation nobody named is left out of the envelope entirely', async () => {
    // Read from the fixture rather than written here: the contract's blank
    // case is whitespace, not the empty string, because that is the shape a
    // form field or a template produces. The gate trims and reads it as
    // absent, so sending it would file the decision under no operation while
    // the caller believed otherwise.
    const blankCase = index.cases.find((c) => c.file.includes('valid-blank-context'))
    expect(blankCase?.accepted, 'index.json lost envelopes/valid-blank-context.json').toBe(true)
    const fixture = loadJson(blankCase?.file ?? '') as {
      clientEventId: string
      typeKey: string
      contextId: string
    }
    expect(fixture.contextId.trim()).toBe('')

    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

    await client.evaluate({
      clientEventId: asClientEventId(fixture.clientEventId),
      typeKey: fixture.typeKey,
      contextId: fixture.contextId,
      meta: {},
    })

    expect(Object.keys(cap.body())).not.toContain('contextId')
  })

  it('never sends the length the contract publishes as a rejection', async () => {
    // The fixture is a *reject* case, so putting it on the wire would be a
    // 422 on envelope shape — which this SDK turns into the fail-mode, and a
    // money action would be blocked over an id that only decides which
    // receipt a decision appears on. The bound is read before sending, which
    // is what `contracts/README.md` asks an SDK to do.
    const longCase = index.cases.find((c) => c.file.includes('invalid-long-context-id'))
    expect(longCase?.accepted, 'index.json lost envelopes/invalid-long-context-id.json').toBe(false)
    const fixture = loadJson(longCase?.file ?? '') as { contextId: string }
    expect(fixture.contextId.length).toBeGreaterThan(index.limits.contextId.maxLength)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

    const verdict = await client.evaluate({
      clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7VA'),
      typeKey: 'transfer_intent',
      contextId: fixture.contextId,
      meta: {},
    })

    // Dropped, not sent and not thrown: the action still gets its verdict,
    // and the integrator is told what they lost.
    expect(Object.keys(cap.body())).not.toContain('contextId')
    expect(verdict.decision).toBe('approved')
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })

  it('the SDK constant and the published limit are the same number', () => {
    // The runtime bundle carries the cap as a constant rather than reading
    // the snapshot; this is what keeps the two from drifting apart.
    expect(CONTEXT_ID_MAX_LENGTH).toBe(index.limits.contextId.maxLength)
  })
})

describe('identity in meta — the key names have not drifted from the contract', () => {
  // The control plane checks its own constants against the same fixture. Were
  // the names to drift apart, no request would fail — the decision record
  // would just drop out of every funnel and out of the erasure cascade.
  const identityCase = index.cases.find((c) => c.file.includes('with-identity'))

  it('the manifest declares an identity case', () => {
    expect(identityCase, 'index.json lost envelopes/valid-with-identity.json').toBeDefined()
    expect(identityCase?.accepted).toBe(true)
  })

  it('IDENTITY_META_KEYS matches the fixture keys', () => {
    const meta = (loadJson(identityCase?.file ?? '') as { meta: Record<string, unknown> }).meta
    for (const key of IDENTITY_META_KEYS) {
      expect(meta, `the fixture does not carry ${key}`).toHaveProperty(key)
    }
  })

  it('the SDK puts both keys in the envelope of an authenticated user', async () => {
    const cap = captureRuntime(
      () =>
        new Response(JSON.stringify({ decision: 'approved', decisionId: 'd' }), { status: 200 }),
    )
    const identity = identityOf(cap.runtime)
    identity.setUserId('u_8f21c4')
    const client = new PolicyClient(cfg, cap.runtime, 'https://api', identity)

    await client.evaluate({
      clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7W2'),
      typeKey: 'transfer_intent',
      meta: { chain: 'eip155:1' },
    })

    const meta = cap.body().meta as Record<string, unknown>
    expect(meta.userId).toBe('u_8f21c4')
    expect(meta.anonymousId).toEqual(expect.any(String))
    // They do NOT become required on the wire: the contract fixes exactly two
    // required fields, and the top level of the envelope does not change.
    expect(Object.keys(cap.body()).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
  })
})

describe('the SDK parses the fixture verdicts', () => {
  for (const file of index.verdicts) {
    const verdict = loadJson(file) as { decision: string; decisionId: string; reasons?: string[] }
    it(`${file}: ${verdict.decision} passes through the client undistorted`, async () => {
      const cap = captureRuntime(() => new Response(JSON.stringify(verdict), { status: 200 }))
      const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

      const out = await client.evaluate({
        clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7V9'),
        typeKey: 'token_approval',
        meta: {},
      })

      expect(out.decision).toBe(verdict.decision)
      expect(out.decisionId).toBe(verdict.decisionId)
      if (verdict.reasons) expect(out.reasons).toEqual(verdict.reasons)
    })
  }
})

describe('the SDK answers every published error code', () => {
  // The manifest publishes the status and the retryability of each code. Both
  // are behaviour here: an error is never a verdict (nothing judged the
  // action, so the fail-mode decides and the money action fails closed), and
  // whether a retry can help is what decides if the client keeps calling.
  function respondWith(err: { file: string; status: number }): () => Response {
    const body = JSON.stringify(loadJson(err.file))
    return () =>
      new Response(body, { status: err.status, headers: { 'content-type': 'application/json' } })
  }

  for (const err of index.errors) {
    it(`${err.code}: a ${err.status} falls back by fail-mode and names the code`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const cap = captureRuntime(respondWith(err))
      const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

      const verdict = await client.evaluate({
        clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7V9'),
        typeKey: 'transfer_intent',
        meta: {},
      })

      expect(verdict.decision).toBe('rejected')
      expect(verdict.decisionId).toMatch(/^fallback:/)
      expect(verdict.reasons).toContain(err.code)
      warn.mockRestore()
    })

    it(`${err.code}: retry=${err.retry} — the client ${err.retry ? 'stops calling' : 'keeps calling'}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const cap = captureRuntime(respondWith(err))
      const client = new PolicyClient(cfg, cap.runtime, 'https://api', identityOf(cap.runtime))

      for (let i = 0; i < 8; i++) {
        await client.evaluate({
          clientEventId: asClientEventId('01J9ZQK7X8Y2N4M6P0R3S5T7V9'),
          typeKey: 'sign_message',
          meta: {},
        })
      }

      // Retryable means the engine may recover, so the client gets out of its
      // way — the breaker, or a backoff. Non-retryable means every call is
      // answered the same: backing off would hide a configuration error
      // instead of fixing it.
      if (err.retry) expect(cap.count()).toBeLessThan(8)
      else expect(cap.count()).toBe(8)
      warn.mockRestore()
    })
  }
})

// A wrong fixture path must fail as an explicit read error, not as an empty
// and silently passing test set.
if (!existsSync(CONTRACT_DIR))
  throw new Error(`haia: contract fixtures not found at ${CONTRACT_DIR}`)
