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

/** Ловит тело исходящего запроса и позволяет вернуть заданный ответ. */
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

/** Identity на том же runtime, что и клиент — как в HaiaClient. */
function identityOf(runtime: Runtime): Identity {
  return new Identity(runtime)
}

describe('манифест покрывает все файлы (никаких незадекларированных фикстур)', () => {
  it('каждый *.json в envelopes/ и verdicts/ назван в index.json', () => {
    const declared = new Set(['index.json', ...index.cases.map((c) => c.file), ...index.verdicts])
    for (const dir of ['envelopes', 'verdicts']) {
      for (const name of readdirSync(new URL(`${dir}/`, CONTRACT_URL))) {
        if (name.endsWith('.json')) {
          expect(declared.has(`${dir}/${name}`), `${dir}/${name} не объявлен в index.json`).toBe(
            true,
          )
        }
      }
    }
  })
})

describe('границы clientEventId совпадают с манифестом', () => {
  const { maxLength, charset } = index.limits.clientEventId

  it(`charset манифеста — ${charset}`, () => {
    expect(charset).toBe('[A-Za-z0-9_-]')
  })

  it(`принимает id длиной ровно ${maxLength}`, () => {
    const atLimit = 'a'.repeat(maxLength)
    expect(asClientEventId(atLimit)).toBe(atLimit)
  })

  it(`отвергает id длиной ${maxLength + 1}`, () => {
    expect(() => asClientEventId('a'.repeat(maxLength + 1))).toThrow()
  })

  it('отвергает символ вне charset манифеста', () => {
    expect(() => asClientEventId('01J9$X8Y')).toThrow()
  })
})

describe('asClientEventId ↔ конверты фикстур', () => {
  // SDK валидирует именно clientEventId (границы, не схема). Прогоняем каждый
  // конверт, у которого поле есть: valid-* несут годный id, а invalid-*-client-
  // event-id — негодный. Прочие invalid-* (typeKey, meta) валидируются сервером,
  // SDK такие Facts не конструирует (закрытый enum typeKey, брендированный id).
  for (const c of index.cases) {
    const envelope = loadJson(c.file) as { clientEventId?: unknown }
    const id = envelope.clientEventId
    if (typeof id !== 'string') continue // missing-client-event-id — нечего валидировать

    const aboutClientEventId = c.file.includes('client-event-id')
    if (c.accepted) {
      it(`${c.file}: принимает id`, () => {
        expect(asClientEventId(id)).toBe(id)
      })
    } else if (aboutClientEventId) {
      it(`${c.file}: отвергает id (${c.reason})`, () => {
        expect(() => asClientEventId(id)).toThrow()
      })
    }
  }
})

describe('SDK строит конверт валидной формы', () => {
  it('для канонического действия шлёт ровно {clientEventId, typeKey, meta} на per-project путь', async () => {
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
    // Верхний уровень ⊆ разрешённых ключей манифеста.
    expect(Object.keys(body).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
    // clientEventId прошёл бы валидацию gateway.
    expect(() => asClientEventId(body.clientEventId as string)).not.toThrow()
    expect(cap.headers()['idempotency-key']).toBe(body.clientEventId)
    expect((body.typeKey as string).length).toBeGreaterThanOrEqual(index.limits.typeKey.minLength)
  })
})

describe('identity в meta — имена ключей не разъехались с контрактом', () => {
  // The control plane checks its own constants against the same fixture. Were
  // the names to drift apart, no request would fail — the decision record
  // would just drop out of every funnel and out of the erasure cascade.
  const identityCase = index.cases.find((c) => c.file.includes('with-identity'))

  it('манифест объявляет кейс с идентичностью', () => {
    expect(identityCase, 'index.json потерял envelopes/valid-with-identity.json').toBeDefined()
    expect(identityCase?.accepted).toBe(true)
  })

  it('IDENTITY_META_KEYS совпадает с ключами фикстуры', () => {
    const meta = (loadJson(identityCase?.file ?? '') as { meta: Record<string, unknown> }).meta
    for (const key of IDENTITY_META_KEYS) {
      expect(meta, `фикстура не несёт ${key}`).toHaveProperty(key)
    }
  })

  it('SDK кладёт оба ключа в конверт авторизованного пользователя', async () => {
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
    // Обязательными на wire они НЕ становятся: §3.1 п.1 фиксирует ровно два
    // обязательных поля, и верхний уровень конверта не меняется.
    expect(Object.keys(cap.body()).sort()).toEqual(['clientEventId', 'meta', 'typeKey'])
  })
})

describe('SDK разбирает вердикты фикстур', () => {
  for (const file of index.verdicts) {
    const verdict = loadJson(file) as { decision: string; decisionId: string; reasons?: string[] }
    it(`${file}: ${verdict.decision} проходит через клиента без искажений`, async () => {
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
