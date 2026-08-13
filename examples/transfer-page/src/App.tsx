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

/** Исход нажатия Send. Блокировка политикой — отдельный случай, не «ошибка». */
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

  // Адрес кошелька как identity: связывает анонимную сессию страницы с
  // пользователем, и последующие события холодного пути едут уже с userId.
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
      // Обычный wagmi-вызов. Гейт стоит ниже, в провайдере коннектора, и
      // добавляет к нему ровно один исход — HaiaPolicyError вместо транзакции.
      const hash = await sendTransactionAsync({ to: to as Address, value })
      setResult({ kind: 'sent', hash })
    } catch (err) {
      // Голый `instanceof` не годится: viem заворачивает ошибку провайдера в
      // свою, и блок оказывается в цепочке `cause`.
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
          Обычная страница перевода на wagmi. Единственное отличие — коннектор обёрнут в{' '}
          <code>haiaConnector</code>, поэтому каждая отправка сперва проходит через policy.
        </p>
        <Target />
      </header>

      <ol className="steps">
        <Step n={1} title="Подключить кошелёк" done={isConnected}>
          {isConnected ? (
            <div className="row">
              <code className="mono">{address}</code>
              <button type="button" className="ghost" onClick={() => disconnect()}>
                Отключить
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
              {connectors.length === 0 && (
                <p className="hint">Инжектированный кошелёк не найден.</p>
              )}
            </div>
          )}
          {connectError && <p className="err">{connectError.message}</p>}
        </Step>

        <Step n={2} title="Выбрать сеть" done={isConnected}>
          <div className="row">
            {chains.map((chain) => (
              <button
                key={chain.id}
                type="button"
                // До подключения wagmi отдаёт первую сеть конфига, а не выбор
                // пользователя — подсвечивать её значило бы показать решение,
                // которого он не принимал.
                className={isConnected && chain.id === chainId ? 'pill on' : 'pill'}
                disabled={!isConnected || isSwitching}
                onClick={() => switchChain({ chainId: chain.id })}
              >
                {chain.name}
              </button>
            ))}
          </div>
          <p className="hint">
            Сеть уезжает в факты как CAIP-2 — <code>eip155:{chainId}</code>. Правила пишутся на неё,
            а не на имя сети.
          </p>
        </Step>

        <Step n={3} title="Адрес получателя" done={recipientOk}>
          <input
            id="recipient"
            className={to === '' || recipientOk ? 'input mono' : 'input mono bad'}
            placeholder="0x…"
            spellCheck={false}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
          {to !== '' && !recipientOk && <p className="err">Не похоже на адрес EVM.</p>}
        </Step>

        <Step n={4} title="Сумма" done={value !== null}>
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
            В фактах сумма едет двумя формами: человекочитаемой <code>amount</code> и minor units{' '}
            <code>amountRaw</code>. Обе — строками, float на денежном пути запрещён.
          </p>
        </Step>

        <Step n={5} title="Отправить" done={result.kind === 'sent'}>
          <button
            type="button"
            className="primary"
            disabled={!canSend}
            onClick={() => {
              void send()
            }}
          >
            {result.kind === 'pending' ? 'Проверяем политику…' : 'Send'}
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
        Не заданы <code>VITE_HAIA_PROJECT_ID</code> / <code>VITE_HAIA_PUBLISHABLE_KEY</code>.
        Скопируйте <code>.env.example</code> в <code>.env.local</code> — без ключей control plane
        ответит 401, и SDK применит fail-mode.
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
        Отправлено: <code className="mono">{result.hash}</code>
      </p>
    )
  }
  if (result.kind === 'blocked') {
    return (
      <div className="blocked">
        <strong>Заблокировано политикой</strong>
        <p>
          Причины: {result.reasons.length > 0 ? result.reasons.join(', ') : '—'} · decision{' '}
          <code className="mono">{result.decisionId}</code>
        </p>
        <p className="hint">
          Транзакция в кошелёк не ушла: гейт стоит до подписи, поэтому окно на подтверждение даже не
          открылось.
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

/** Пустая строка и мусор — не ноль, а «суммы ещё нет»: Send остаётся выключен. */
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
