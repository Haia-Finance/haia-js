# haia-js

JavaScript/TypeScript adapters for HAIA — a non-custodial control plane for onchain
execution. Adapters gate transactions through a policy check and stream analytics,
with minimal code on the integrator side.

🚧 Under active development.

## Packages

Монорепо: общее ядро + тонкие публикуемые пакеты-по-SDK.

| Пакет | Назначение |
|---|---|
| [`@haia/types`](./packages/types) | Контракт без рантайма: `TransactionContext`, `Verdict`, события |
| [`@haia/core`](./packages/core) | Клиент policy `/evaluate`, ingest-клиент, нормализация, EIP-1193 guard-kernel |
| [`@haia/wagmi`](./packages/wagmi) | Референс-адаптер для viem / wagmi |
| `tooling/*` | Общие конфиги (`@haia/tsconfig`, `@haia/biome-config`) |

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
