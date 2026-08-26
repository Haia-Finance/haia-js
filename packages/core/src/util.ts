/** Base64 — `btoa` есть и в браузере, и в Node 18+. */
export function toBase64(input: string): string {
  return globalThis.btoa(input)
}

/**
 * Снимает удержание event-loop с таймера в Node (no-op в браузере, где
 * setTimeout возвращает number). Чтобы pending-таймер не держал процесс.
 */
export function unref(timer: unknown): void {
  const t = timer as { unref?: () => void }
  t.unref?.()
}
