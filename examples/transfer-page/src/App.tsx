import { asHaiaPolicyError } from '@haia/core'
import { type ReactNode, useEffect, useState } from 'react'
import { type Address, isAddress, parseEther } from 'viem'
import {
  useAccount,
  useChainId,
  useConnect,
  useDisconnect,
  useSendTransaction,
  useSwitchChain,
} from 'wagmi'
import { baseUrl, haia, isConfigured, projectId } from './haia'
import { useInjectedWalletName } from './injected-wallet'
import { PolicyNotices, WireLog } from './panels'
import { chains } from './wagmi'

/** The outcome of pressing Send. A policy block is its own case, not an "error". */
type SendResult =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'sent'; hash: string }
  | { kind: 'blocked'; reasons: string[]; decisionId: string }
  | { kind: 'failed'; message: string }

export function App() {
  const { address, isConnected } = useAccount()
  const { connect, connectors, isPending: isConnecting, error: connectError } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const { switchChain, isPending: isSwitching } = useSwitchChain()
  const { sendTransactionAsync } = useSendTransaction()
  const walletName = useInjectedWalletName()

  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [result, setResult] = useState<SendResult>({ kind: 'idle' })

  // The wallet address as identity: it links the page's anonymous session to
  // a user, and later cold-path events carry the userId.
  useEffect(() => {
    if (address) haia.identify(address)
  }, [address])

  const value = parseAmount(amount)
  const recipientOk = isAddress(to)
  const canSend = isConnected && recipientOk && value !== null && result.kind !== 'pending'

  async function send() {
    if (value === null || !isAddress(to)) return
    setResult({ kind: 'pending' })
    try {
      // An ordinary wagmi call. The gate sits below it, in the connector
      // provider, and adds exactly one outcome — HaiaPolicyError instead of a
      // transaction.
      const hash = await sendTransactionAsync({ to: to as Address, value })
      setResult({ kind: 'sent', hash })
    } catch (err) {
      // A bare `instanceof` is no good: viem wraps the provider error in one of
      // its own, leaving the block in the `cause` chain.
      const blocked = asHaiaPolicyError(err)
      if (blocked) {
        setResult({ kind: 'blocked', reasons: blocked.reasons, decisionId: blocked.decisionId })
      } else {
        setResult({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
      }
    }
  }

  return (
    <main className="page">
      <header className="head">
        <h1>Transfer</h1>
        <p className="sub">
          An ordinary wagmi transfer page. The only difference is that the connector is wrapped in{' '}
          <code>haiaConnector</code>, so every send goes through policy first.
        </p>
        <Target />
      </header>

      <ol className="steps">
        <Step n={1} title="Connect a wallet" done={isConnected}>
          {isConnected ? (
            <div className="row">
              <code className="mono">{address}</code>
              <button type="button" className="ghost" onClick={() => disconnect()}>
                Disconnect
              </button>
            </div>
          ) : (
            <div className="row">
              {connectors.map((connector) => (
                <button
                  key={connector.uid}
                  type="button"
                  onClick={() => connect({ connector })}
                  disabled={isConnecting}
                >
                  {walletName ?? connector.name}
                </button>
              ))}
              {connectors.length === 0 && <p className="hint">No injected wallet found.</p>}
            </div>
          )}
          {connectError && <p className="err">{connectError.message}</p>}
        </Step>

        <Step n={2} title="Pick a network" done={isConnected}>
          <div className="row">
            {chains.map((chain) => (
              <button
                key={chain.id}
                type="button"
                // Before connecting, wagmi reports the first network in the config
                // rather than the user's choice — highlighting it would show a
                // decision they never made.
                className={isConnected && chain.id === chainId ? 'pill on' : 'pill'}
                disabled={!isConnected || isSwitching}
                onClick={() => switchChain({ chainId: chain.id })}
              >
                {chain.name}
              </button>
            ))}
          </div>
          <p className="hint">
            The network goes into the facts as CAIP-2 — <code>eip155:{chainId}</code>. Rules are
            written against that, not against the network name.
          </p>
        </Step>

        <Step n={3} title="Recipient address" done={recipientOk}>
          <input
            id="recipient"
            className={to === '' || recipientOk ? 'input mono' : 'input mono bad'}
            placeholder="0x…"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          {to !== '' && !recipientOk && (
            <p className="err">That does not look like an EVM address.</p>
          )}
        </Step>

        <Step n={4} title="Amount" done={value !== null}>
          <div className="row">
            <input
              id="amount"
              className={amount === '' || value !== null ? 'input mono' : 'input mono bad'}
              placeholder="0.01"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            <span className="unit">{nativeSymbol(chainId)}</span>
          </div>
          <p className="hint">
            The facts carry the amount in two forms: the human-readable <code>amount</code> and
            minor units <code>amountRaw</code>. Both as strings — floats are forbidden on the money
            path.
          </p>
        </Step>

        <Step n={5} title="Send" done={result.kind === 'sent'}>
          <button
            type="button"
            className="primary"
            disabled={!canSend}
            onClick={() => {
              void send()
            }}
          >
            {result.kind === 'pending' ? 'Checking policy…' : 'Send'}
          </button>
          <Outcome result={result} />
        </Step>
      </ol>

      <PolicyNotices />
      <WireLog />
    </main>
  )
}

function Target() {
  if (!isConfigured) {
    return (
      <p className="err">
        <code>VITE_HAIA_PROJECT_ID</code> / <code>VITE_HAIA_PUBLISHABLE_KEY</code> are not set. Copy
        <code>.env.example</code> to <code>.env.local</code> — without keys the control plane
        answers 401 and the SDK applies its fail-mode.
      </p>
    )
  }
  return (
    <p className="hint">
      control plane: <code>{baseUrl ?? 'https://api.haia.finance'}</code> · project{' '}
      <code>{projectId}</code>
    </p>
  )
}

function Outcome({ result }: { result: SendResult }) {
  if (result.kind === 'sent') {
    return (
      <p className="ok">
        Sent: <code className="mono">{result.hash}</code>
      </p>
    )
  }
  if (result.kind === 'blocked') {
    return (
      <div className="blocked">
        <strong>Blocked by policy</strong>
        <p>
          Reasons: {result.reasons.length > 0 ? result.reasons.join(', ') : '—'} · decision{' '}
          <code className="mono">{result.decisionId}</code>
        </p>
        <p className="hint">
          The transaction never reached the wallet: the gate sits before the signature, so the
          confirmation window never even opened.
        </p>
      </div>
    )
  }
  if (result.kind === 'failed') return <p className="err">{result.message}</p>
  return null
}

function Step({
  n,
  title,
  done,
  children,
}: {
  n: number
  title: string
  done: boolean
  children: ReactNode
}) {
  return (
    <li className={done ? 'step done' : 'step'}>
      <div className="step-head">
        <span className="num">{n}</span>
        <h2>{title}</h2>
      </div>
      <div className="step-body">{children}</div>
    </li>
  )
}

/** An empty string or junk is not zero but "no amount yet": Send stays disabled. */
function parseAmount(input: string): bigint | null {
  const trimmed = input.trim()
  if (trimmed === '') return null
  try {
    const wei = parseEther(trimmed)
    return wei > 0n ? wei : null
  } catch {
    return null
  }
}

function nativeSymbol(id: number): string {
  return chains.find((chain) => chain.id === id)?.nativeCurrency.symbol ?? 'ETH'
}
