# Transfer page

Страница перевода на wagmi: подключить кошелёк → выбрать сеть → адрес → сумма →
Send. Ровно то, что уже написано в любом кошельке или dApp. Смысл примера в том,
чего в нём **не** пришлось написать: гейт политики не появляется ни в форме, ни в
обработчике Send.

```sh
pnpm install                 # из корня монорепо
cp .env.example .env.local   # projectId + publishableKey
pnpm --filter @haia/example-transfer-page dev
```

## Интеграция

Три строки, все в [`src/wagmi.ts`](./src/wagmi.ts) и [`src/haia.ts`](./src/haia.ts):

```ts
const haia = createHaiaClient({ projectId, publishableKey })

createConfig({
  connectors: [haiaConnector(injected(), haia)],
  multiInjectedProviderDiscovery: false,
})
```

`haiaConnector` подменяет у коннектора один метод — `getProvider`. Наружу уходит
тот же EIP-1193 провайдер, но методы из `GATED_METHODS` (`eth_sendTransaction`,
`wallet_sendCalls`, `eth_signTypedData*`, …) сперва идут в
`POST /v1/projects/{projectId}/policy/evaluate`, и только одобренные — в кошелёк.
Поэтому [`App.tsx`](./src/App.tsx) не знает о политике ничего: `useSendTransaction`
остаётся обычным wagmi-хуком, а снять гейт со всего приложения можно, убрав ровно
эту обёртку.

`multiInjectedProviderDiscovery: false` — не косметика. По умолчанию wagmi сам
добавляет в конфиг коннекторы, найденные через EIP-6963: их создаёт wagmi, а не
наш код, то есть мимо обёртки. Один необёрнутый коннектор в списке делает гейт
необязательным — пользователь просто выбирает второй пункт в меню подключения.

Кошелёк при этом никуда не девается: `injected()` работает с `window.ethereum`,
а его занимает установленное расширение — в примере кнопка так и подписана
именем найденного кошелька. Теряется не кошелёк, а выбор между несколькими
установленными сразу. Нужен выбор — перечислите цели явно, каждую в своей
обёртке, оставив автопоиск выключенным:

```ts
connectors: [
  haiaConnector(injected({ target: 'metaMask' }), haia),
  haiaConnector(injected({ target: 'coinbaseWallet' }), haia),
]
```

Единственное место, где приложение всё-таки знает про haia, — обработка исхода:

```ts
try {
  await sendTransactionAsync({ to, value })
} catch (err) {
  const blocked = asHaiaPolicyError(err)   // не instanceof: viem кладёт блок в cause
  if (blocked) showReasons(blocked.reasons)
}
```

## Что смотреть

Панель **Wire** внизу страницы показывает запрос и ответ каждого вызова к control
plane — тем же телом, каким его отправил SDK. Она к интеграции не относится
(подключена через `runtime.fetch`, см. [`src/wire-log.ts`](./src/wire-log.ts)) и
нужна затем, чтобы контракт был виден глазами:

```json
{
  "clientEventId": "01KZWDXC5WG7ZHBFBZ4PDDVPYV",
  "typeKey": "transfer_intent",
  "meta": {
    "chain": "eip155:11155111",
    "from": "0x1111…",
    "to": "0x2222…",
    "amount": "0.01",
    "amountRaw": "10000000000000000"
  }
}
```

→

```json
{ "decision": "approved", "decisionId": "dec_019ff8dd…", "reasons": ["policy_not_configured"] }
```

Здесь видно и то, чего в UI нет:

- **`clientEventId` — ULID**, он же `Idempotency-Key` заголовка и `messageId`
  события холодного пути. По нему намерение, решение и исполнение сшиваются в
  серверном журнале, а повтор того же намерения реплеит уже вынесенное решение,
  а не выносит второе.
- **Сумма едет двумя формами** — `amount` и `amountRaw`, обе строками. Float на
  денежном пути запрещён.
- **`/v1/batch` приходит позже** горячего пути и пачкой: аналитика
  fire-and-forget, её сбой не виден приложению.
- **Незнакомый control plane ключ не гейтит молча**: `reasons` объясняет, почему
  вердикт такой. `policy_not_configured` — локальная инсталляция без движка
  политик, `not_gated` — тип действия не заведён в реестре.

### Fail-closed

Остановите control plane и нажмите Send. Отправка будет **заблокирована**, окно
кошелька не откроется:

```
reasons=[fallback_closed, unavailable]  decisionId=fallback:01KZWDXC…
```

Так и задумано: `transfer_intent` — денежное действие, и при недоступности
политики SDK применяет fail-closed. Для `sign_message` или `wallet_connected` в
той же ситуации действие прошло бы (fail-open). Класс действия знает клиент —
поэтому решение принимает он, а не сервер.

## Против локального control plane

Нужен запущенный haia-cp ([`~/haia-cp`](https://github.com/Haia-Finance)):

```sh
docker compose up -d postgres redis     # в корне haia-cp
cd backend && make install && make migrate
make bootstrap                          # печатает projectId и pit_-ключ
make ingest-api                         # :8000 — на нём и policy-гейт, и ingest
```

`make bootstrap` идемпотентен и печатает ключ только когда создаёт его. Если
проект уже существует, ключ достаётся из БД — он публичный и хранится как есть:

```sh
docker compose exec postgres psql -U postgres -d haia_cp -At -F'|' \
  -c "SELECT project_id, token, scopes FROM public_ingest_tokens WHERE revoked_at IS NULL;"
```

Годится строка, у которой в `scopes` есть **`policy:evaluate`** — без него гейт
ответит 403, и SDK уйдёт в fail-mode.

Дальше — в `.env.local`:

```sh
VITE_HAIA_PROJECT_ID=<uuid проекта>
VITE_HAIA_PUBLISHABLE_KEY=pit_…
VITE_HAIA_BASE_URL=http://localhost:8000
```

Два места, где локальный прогон обычно спотыкается:

- **CORS.** Ingest-сервис пускает только origin-ы из своего allowlist; 5173 в нём
  есть по умолчанию, поэтому dev-сервер примера прибит к этому порту
  (`strictPort`). Другой порт — preflight, а не политика.
- **Занятый 8000.** Если порт уже кем-то держится, поднимайте сервис явно
  (`HTTP_PORT=8010 uv run python -m run.http.ingest_api`) и поправьте
  `VITE_HAIA_BASE_URL` — иначе запросы уедут в чужое приложение, а SDK честно
  отчитается «сервис недоступен».

Проверить, что долетело, можно в самой базе:

```sh
docker compose exec postgres psql -U postgres -d haia_cp \
  -c "SELECT client_event_id, type_key FROM policy_intents ORDER BY created_at DESC LIMIT 5;" \
  -c "SELECT decision_id, decision, reasons FROM policy_decisions ORDER BY created_at DESC LIMIT 5;"
```

## Что здесь настоящее

Настоящее: SDK, кошелёк, сеть, транзакция и вызовы к control plane. Пример ничего
не мокает — если Send прошёл, транзакция ушла в сеть на самом деле.

Поэтому сети — **тестовые** (Sepolia, Base Sepolia, Arbitrum Sepolia): пример
публичный и открывается человеком с настоящим кошельком. Механика гейта от сети
не зависит; чтобы посмотреть на mainnet, поменяйте `chains` и `transports` в
[`src/wagmi.ts`](./src/wagmi.ts).

Вердикты локально почти всегда `approved` с причиной `policy_not_configured`:
движок политик (Swiftward) в дефолтный `docker compose up` не входит, а гейт без
армированного пака не выдумывает решение, а пропускает действие и говорит, почему.
Чтобы увидеть настоящий `rejected`, поднимите профиль `swiftward` в haia-cp и
заармируйте пак на проекте.
