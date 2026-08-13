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
