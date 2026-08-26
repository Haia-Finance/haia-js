import { useEffect, useState } from 'react'

/**
 * Имя инжектированного кошелька для подписи кнопки.
 *
 * Коннектор у нас один — `injected()`, он работает с `window.ethereum`, и его
 * `name` так и остаётся «Injected». Для подписи это плохо: человек видит
 * «Injected», не находит MetaMask и решает, что его кошелёк не поддержан, хотя
 * это ровно он и есть.
 *
 * Спрашиваем имя по EIP-6963 — тому же стандарту, автопоиск по которому мы в
 * `wagmi.ts` осознанно выключили. Противоречия нет: там речь про то, кто
 * СОЗДАЁТ коннекторы (только мы, иначе появится негейченный вход), здесь — про
 * подпись к уже созданному. Объявления только читаются.
 *
 * Сниффинг флагов (`ethereum.isMetaMask` и родня) не годится: кошельки ставят
 * чужие флаги, чтобы их принимали за MetaMask, — подпись врала бы. EIP-6963
 * имя приходит от самого кошелька.
 */

interface Eip6963Detail {
  info: { name: string; rdns: string }
  provider: unknown
}

export function useInjectedWalletName(): string | undefined {
  const [name, setName] = useState<string>()

  useEffect(() => {
    const found: Eip6963Detail[] = []
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<Eip6963Detail>).detail
      if (detail?.info?.name) found.push(detail)
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))

    // Объявления приходят синхронно на requestProvider, но кошелёк может
    // ответить и позже (медленная инициализация расширения) — поэтому читаем
    // результат в макротаске, а не сразу.
    const timer = setTimeout(() => {
      const injected = (globalThis as { ethereum?: unknown }).ethereum
      // Матчим по идентичности провайдера: подписать нужно именно тот кошелёк,
      // с которым будет работать коннектор. Если объявившийся ровно один —
      // берём его: он и занял window.ethereum.
      const match =
        found.find((d) => d.provider === injected) ?? (found.length === 1 ? found[0] : undefined)
      setName(match?.info.name)
    }, 300)

    return () => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      clearTimeout(timer)
    }
  }, [])

  return name
}
