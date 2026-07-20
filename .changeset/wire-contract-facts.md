---
'@haia/types': minor
'@haia/core': minor
'@haia/wagmi': minor
---

Переход на принятый wire-контракт haia-js ↔ haia-cp (HAD-331).

**Breaking (до первой публикации в npm):**

- `TransactionContext` → `Facts {clientEventId, typeKey, meta}`: конверт плоский, `typeKey` — строка вместо закрытого `EventType`-enum, все домменные поля уезжают в плоскую `meta` по словарю конвенций.
- `Verdict.ttlMs` удалён вместе с кэшем вердиктов: каждый гейт — реальный вызов, каждое намерение журналируется на сервере.
- Конфиг: `serverApiKey` + `ingestToken` → единый `publishableKey`; `failMode` теперь `{default?, byTypeKey?}`.
- Policy-эндпоинт per-project: `POST /v1/projects/{projectId}/policy/evaluate`; ingest → `POST /v1/batch` с идентичностью на каждом элементе батча.
- `PolicyEngine` → `PolicyClient` (имя `Engine` зарезервировано за серверным Policy Engine).

**Новое:**

- `HaiaPolicyError` + хуки `onBlocked` / `onFlagged`; `guard()` бросает на `rejected`, `flagged` — proceed.
- Бюджет латентности по умолчанию 400 мс — реалистично для межрегионального браузерного RTT (было 80 мс).
- Дедупликация аналитики по `clientEventId`, ретраи с backoff.
