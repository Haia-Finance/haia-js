---
'@haia/types': minor
'@haia/core': minor
'@haia/evm': minor
'@haia/wagmi': minor
---

Находки ревью HAD-333: формат id, `meta.amount`, инварианты на стыке пакетов.

**`clientEventId` — настоящий ULID вместо UUID.** SDK слал `crypto.randomUUID()`, тогда как контракт §3.1 специфицирует ULID, а §5.1 обязывает gateway валидировать форму — на интеграции с HAD-332 это дало бы 4xx на каждом запросе и, через трактовку 4xx как конфиг-ошибки, fail-closed на всём денежном пути. Своя реализация (~30 строк, без зависимостей): 48 бит времени + 80 бит случайности, Crockford base32. Временной префикс делает журнал сортируемым по ключу.

- `ClientEventId` — брендированный тип в `@haia/types`: голая строка в конверт не попадёт.
- `newClientEventId()` — генерация; `asClientEventId(value)` — впуск чужих id (manual guard, серверные источники) по границам 1–64 и `[A-Za-z0-9_-]`, тем же правилам, что у gateway. Строгий ULID на приёме запрещён планом.
- `randomId` (UUID) удалён; `anonymousId` аналитики тоже на ULID — формат id в SDK один.

**`meta.amount`.** Факты несли только `amountRaw`, хотя словарь конвенций и пример §3.1 содержат обе формы: правило пака на `meta.amount` молча не срабатывало бы никогда. Для нативного перевода decimals известны (18) — форма заполняется; для ERC-20 остаётся только `amountRaw`, пока нет декодера `transfer()`.

**Одна копия `@haia/core`.** Переведён в `peerDependencies` у `@haia/evm` и `@haia/wagmi`: две копии ядра означали бы два разных класса `HaiaPolicyError`, и `asHaiaPolicyError` возвращал бы `undefined` — ровно тот отказ, ради которого хелпер и добавлен.

**Инварианты на стыке пакетов закреплены тестами.** `TYPE_KEYS ⊆ DEFAULT_FAIL_MODE_BY_TYPE_KEY` (промах = тихий fail-open на деньгах) и `GATED_METHODS ⊆ ветки buildFacts` — вместо молчаливого catch-all, выдававшего чужие params за `transfer_intent`, теперь явная ошибка.
