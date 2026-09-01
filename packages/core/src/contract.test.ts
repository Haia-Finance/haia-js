import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { HaiaConfig } from './config'
import { asClientEventId } from './id'
import { IDENTITY_META_KEYS, Identity } from './identity/identity'
import { PolicyClient } from './policy/client'
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

interface ContractIndex {
  request: { path: string; headers: Record<string, string> }
  cases: ContractCase[]
  verdicts: string[]
  limits: {
    clientEventId: { maxLength: number; charset: string }
    typeKey: { minLength: number; maxLength: number }
  }
}

const index = loadJson('index.json') as unknown as ContractIndex

const cfg: HaiaConfig = { projectId: 'proj_1', publishableKey: 'pk_1' }

/** Captures the body of the outgoing request and lets a response be scripted. */
function captureRuntime(response: () => Response): {
  runtime: Runtime
  body: () => Record<string, unknown>
  headers: () => Record<string, string>
} {
  let sent: Record<string, unknown> = {}
  let headers: Record<string, string> = {}
  const runtime: Runtime = {
    fetch: (async (_url: string, init: { body?: string; headers?: Record<string, string> }) => {
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
  return { runtime, body: () => sent, headers: () => headers }
}

/** Identity on the same runtime as the client, as in HaiaClient. */
function identityOf(runtime: Runtime): Identity {
  return new Identity(runtime)
}

describe('the manifest covers every file (no undeclared fixtures)', () => {
  it('every *.json in envelopes/ and verdicts/ is named in index.json', () => {
    const declared = new Set(['index.json', ...index.cases.map((c) => c.file), ...index.verdicts])
    for (const dir of ['envelopes', 'verdicts']) {
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

// A wrong fixture path must fail as an explicit read error, not as an empty
// and silently passing test set.
if (!existsSync(CONTRACT_DIR))
  throw new Error(`haia: contract fixtures not found at ${CONTRACT_DIR}`)
