/**
 * The list of intercepted EIP-1193 methods — a constant of the family layer.
 *
 * The property that defines the list: it exhausts the **money surface of the
 * protocol**, that is, the points where an action can still be prevented. That
 * is a fact about the protocol, not a guess about the integrator: gating
 * something non-standard is done server-side through the registry, not by
 * editing this list. The client does not decide whether an action is gated —
 * everything intercepted goes to the server.
 *
 * | Method | Decision | Why |
 * | -- | -- | -- |
 * | `eth_sendTransaction` | gated | sending a transaction is the primary point |
 * | `eth_signTransaction` | gated | signing without broadcast: the same parameter envelope, and this is where the money is signed |
 * | `wallet_sendCalls` | gated | an EIP-5792 batch, evaluated per call |
 * | `eth_signTypedData`, `_v3`, `_v4` | gated | permit / Permit2 — an approval with no transaction |
 * | `eth_sendRawTransaction` | **not gated** | see below |
 * | `personal_sign`, `eth_sign` | not gated | not a money surface of the protocol: an arbitrary byte string, most often a SIWE login. An integrator with signed off-chain orders has manual `guard()` |
 *
 * **`eth_sendRawTransaction` — the verdict is: not included.** By this point
 * the transaction is already signed, so a gate here prevents only the
 * broadcast — and a signed transaction can be sent to any public RPC without
 * us. That is not a chokepoint but a cooperative check with a weak guarantee;
 * a bypass at that level is closed by journal reconciliation or by a
 * server-side evaluate, not by interception in the browser. An application that
 * signs locally is an embedded wallet, and for it the gate goes in at the
 * action level BEFORE the signature, where a verdict can still prevent the
 * action. On top of that, meaningful facts would require an RLP decoder for a
 * signed transaction: an error in it would distort the facts and therefore the
 * decision — a higher price than the value of a gate that is bypassable by
 * construction.
 */
export const GATED_METHODS: ReadonlySet<string> = new Set([
  'eth_sendTransaction',
  'eth_signTransaction',
  'wallet_sendCalls',
  'eth_signTypedData',
  'eth_signTypedData_v3',
  'eth_signTypedData_v4',
])
