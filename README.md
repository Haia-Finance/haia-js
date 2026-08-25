# haia-js

JavaScript/TypeScript adapters for HAIA — a non-custodial control plane for onchain
execution. Adapters gate transactions through a policy check and stream analytics,
with minimal code on the integrator side.

🚧 Under active development.

## Packages

Монорепо: общее ядро + тонкие публикуемые пакеты-по-SDK.

| Пакет | Назначение |
|---|---|
| [`@haia/types`](./packages/types) | Wire-контракт без рантайма: `Facts`, `Verdict`, события |
| [`@haia/core`](./packages/core) | Универсальное ядро: policy `/evaluate`, ingest, identity, runtime-инъекции. Ничего не знает про EVM и провайдеров |
| [`@haia/evm`](./packages/evm) | Семейный слой EVM: перехват EIP-1193, декод calldata, нормализация в факты |
| [`@haia/wagmi`](./packages/wagmi) | Тонкий адаптер для viem / wagmi поверх `@haia/evm` |
| `tooling/*` | Общие конфиги (`@haia/tsconfig`, `@haia/biome-config`) |

## Identity в конверте

Каждый `guard()` уходит с идентичностью в `meta` — SDK подмешивает её сам, на
всех уровнях врезки (transport, коннектор, ручной `guard`). `anonymousId` есть
всегда; `userId` появляется после `identify()` и до логина не отправляется.

```ts
const haia = createHaiaClient({ projectId, publishableKey })
haia.identify(address)   // адрес кошелька как identity — этого достаточно
```

Зачем. Control plane пишет на каждый вердикт событие и поднимает эти два ключа
в собственные колонки. Без них строка принимается ровно так же и действие
гейтится как обычно — но её не видит ни одна воронка (все фильтруют по
`COALESCE(user_id, anonymous_id) IS NOT NULL`) и до неё никогда не доберётся
запрос на стирание: каскад ищет по пользователю и связанным с ним анонимным id.
Цена отсутствия — не отказ, а тихо неполные цифры и неудаляемая запись. Именно
поэтому ключи подмешивает SDK, а не помнит каждый интегратор.

Правила:

- **Явное значение партнёра выигрывает.** `meta.userId`, переданный вызывающим,
  доходит до сервера неизменным; подмешивание заполняет пустое.
- **`anonymousId` тот же, что у аналитики.** Горячий и холодный путь берут его
  из одного экземпляра `Identity` — сервер стыкует «намерение → вердикт →
  исполнение» именно по нему.
- **Отсутствие идентичности — не ошибка.** Конверт уходит как есть, без
  исключения и без блокировки; один `console.debug` за сессию.
- **Обязательными на wire ключи не становятся.** Контракт фиксирует два
  обязательных поля, и fail-closed из-за формы конверта на денежном пути
  недопустим.

`clientEventId` остаётся стабильным ключом корреляции. `decisionId` — нет:
ретрай переоценивает намерение заново, и контракт объявляет его стабильность
best-effort.

## Examples

[`examples/transfer-page`](./examples/transfer-page) — страница перевода на wagmi:
подключить кошелёк, выбрать сеть, адрес, сумма, Send. Гейт добавляется одной
обёрткой вокруг коннектора и не появляется ни в форме, ни в обработчике отправки.

```bash
cd examples/transfer-page
cp .env.example .env.local   # projectId + publishableKey
pnpm dev
```

Примеры приватные и не публикуются, но живут в воркспейсе — то есть потребляют
пакеты через тот же публичный вход, что и внешний проект.

## Tooling

pnpm (workspaces + catalog) · Turborepo · Biome · tsup · Changesets · Vitest.

```bash
pnpm install        # установка (требует corepack / pnpm 11+)
pnpm build          # сборка всех пакетов (turbo)
pnpm check-types    # tsc --noEmit по пакетам
pnpm test           # vitest
pnpm lint           # biome check
pnpm changeset      # завести changeset для релиза
```
