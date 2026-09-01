import { useEffect, useState } from 'react'

/**
 * The name of the injected wallet, for the button label.
 *
 * There is one connector — `injected()` — it talks to `window.ethereum`, and
 * its `name` stays "Injected". That is a poor label: a person sees "Injected",
 * fails to find MetaMask and concludes their wallet is unsupported, when it is
 * in fact exactly the one being used.
 *
 * The name is asked for over EIP-6963 — the same standard whose discovery is
 * deliberately turned off in `wagmi.ts`. There is no contradiction: that is
 * about who CREATES connectors (only we do, or an ungated entry appears), this
 * is about labelling one that already exists. The announcements are only read.
 *
 * Sniffing flags (`ethereum.isMetaMask` and relatives) is no good: wallets set
 * each other's flags to be taken for MetaMask, so the label would lie. Over
 * EIP-6963 the name comes from the wallet itself.
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

    // Announcements arrive synchronously on requestProvider, but a wallet may
    // also answer later (slow extension startup), so the result is read in a
    // macrotask rather than immediately.
    const timer = setTimeout(() => {
      const injected = (globalThis as { ethereum?: unknown }).ethereum
      // Match on provider identity: the label must name the wallet the connector
      // will actually work with. If exactly one announced itself, take it — that
      // is the one occupying window.ethereum.
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
