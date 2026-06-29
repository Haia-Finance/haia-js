/** UUID, если доступен (браузер/Node 18+), иначе детерминированный фолбэк. */
export function randomId(): string {
  const c = globalThis.crypto
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  return `id-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
}

/** Base64 — `btoa` есть и в браузере, и в Node 18+. */
export function toBase64(input: string): string {
  return globalThis.btoa(input)
}
