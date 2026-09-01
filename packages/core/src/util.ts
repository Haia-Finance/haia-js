/** Base64 — `btoa` exists both in the browser and in Node 18+. */
export function toBase64(input: string): string {
  return globalThis.btoa(input)
}

/**
 * Releases the event loop from a timer in Node (a no-op in the browser, where
 * setTimeout returns a number), so a pending timer does not hold the process.
 */
export function unref(timer: unknown): void {
  const t = timer as { unref?: () => void }
  t.unref?.()
}
