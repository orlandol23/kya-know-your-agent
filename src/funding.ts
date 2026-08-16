/**
 * Funding provenance: who paid for this wallet's first inbound transfer.
 *
 * The most expensive signal to forge in v0.1. Age is forged by waiting, volume
 * by self-sends, but the first inbound names a real counterparty, and if that
 * counterparty is a custodial exchange there is a KYC record behind it.
 *
 * Two honest limits, both worth saying out loud before someone asks:
 *   - Anyone can send an unsolicited transfer to a wallet, so a first inbound
 *     from an exchange is evidence, not proof, that the OWNER holds the account.
 *   - Reading it needs a labelled address list, and the label quality is the
 *     signal's ceiling. See the provenance on each list below.
 */

import type { AddressHistory } from './blockscout.js'
import { OFAC_SANCTIONED } from './sanctions.js'

export type FundingClass = 'exchange' | 'mixer' | 'sanctioned' | 'unknown' | 'none'

export type FundingProvenance = {
  class: FundingClass
  /** The funding address. Null when nothing ever came in. */
  source: string | null
  /** What matched in a list, for showing a blocked payer why. */
  label: string | null
  firstInboundAt: string | null
  via: 'native' | 'token' | null
}

/**
 * Exchange-class hot wallets on Base.
 *
 * NOT a labelled exchange list, and the difference matters. Blockscout exposes
 * no exchange labels for Base: checked on 2026-08-15 against chain 8453 and
 * chain 1 (both return name null, public_tags []), and against the Blockscout
 * metadata service, which returns an empty result set for "coinbase" on 8453.
 * The eth-labels project ships a Basescan scraper, not a dataset.
 *
 * So these were derived behaviourally from the D2 harvest, by a rule fixed
 * before looking at the result: an EOA with more than 1M transactions on Base
 * that was the first inbound source for at least 3 of the 74 sampled wallets.
 * Custodial-scale by behaviour. IDENTITY UNCONFIRMED: none of them is proven to
 * belong to a named exchange, and the score treats the class, not the name.
 *
 * Counters read 2026-08-16. Naming them needs an external label set, which is
 * the same dependency the plan already parks in the roadmap.
 */
const EXCHANGE_CLASS: ReadonlyMap<string, string> = new Map([
  [
    '0x3304e22ddaa22bcdc5fca2269b418046ae7b566a',
    'exchange-class hot wallet: 7.81M transactions on Base, first inbound source for 7 of 74 sampled wallets',
  ],
  [
    '0x8581784d3e598cca3482375cff2409ac9dd8c402',
    'exchange-class hot wallet: 2.98M transactions on Base, first inbound source for 4 of 74 sampled wallets',
  ],
  [
    '0xbaed383ede0e5d9d72430661f3285daa77e9439f',
    'exchange-class hot wallet: 2.80M transactions on Base, first inbound source for 3 of 74 sampled wallets',
  ],
])

/**
 * Known mixer contracts.
 *
 * Verified rather than recalled: each address was read from Blockscout on chain
 * 1 on 2026-08-16 and reports a verified contract under the name given below.
 *
 * Two caveats that change how much this branch is worth:
 *   - None of them is deployed at the same address on Base (is_contract is false
 *     on 8453), so on Base this branch does not fire today. A wallet funded by
 *     an L1 mixer withdrawal that was then bridged is NOT caught: that needs
 *     cross-chain tracing, which v0.1 does not do.
 *   - They are NOT on the current OFAC SDN list, checked against the 2026-08-07
 *     publication. Tornado Cash was delisted; its co-founder is still listed.
 *     "Mixer" and "sanctioned" are different questions and are kept apart.
 */
const KNOWN_MIXERS: ReadonlyMap<string, string> = new Map([
  ['0x722122df12d4e14e13ac3b6895a86e84145b6967', 'Tornado Cash: TornadoProxy (verified contract on chain 1)'],
  ['0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', 'Tornado Cash: TornadoRouter (verified contract on chain 1)'],
  ['0x910cbd523d972eb0a6f4cae4618ad62622b39dbf', 'Tornado Cash: TornadoCash_eth (verified contract on chain 1)'],
])

/**
 * The SDN entry naming this address itself, if any.
 *
 * The payer being listed is a more direct hit than its funder being listed, and
 * 15 of the 100 listed addresses have activity on Base, so this is reachable.
 */
export function sanctionEntryFor(address: string): string | null {
  return OFAC_SANCTIONED.get(address.toLowerCase()) ?? null
}

/** Severity order: a sanctioned exchange wallet is sanctioned first. */
export function classifyFunder(funder: string): { class: FundingClass; label: string | null } {
  const key = funder.toLowerCase()

  const sanctioned = OFAC_SANCTIONED.get(key)
  if (sanctioned !== undefined) return { class: 'sanctioned', label: `OFAC SDN: ${sanctioned}` }

  const mixer = KNOWN_MIXERS.get(key)
  if (mixer !== undefined) return { class: 'mixer', label: mixer }

  const exchange = EXCHANGE_CLASS.get(key)
  if (exchange !== undefined) return { class: 'exchange', label: exchange }

  return { class: 'unknown', label: null }
}

type Inbound = { from: string; timestampMs: number; via: 'native' | 'token' }

function earliestInbound(
  rows: { from: string; to: string; timeStamp: string }[],
  address: string,
  via: 'native' | 'token',
): Inbound | null {
  const self = address.toLowerCase()
  let best: Inbound | null = null

  for (const row of rows) {
    if (row.to?.toLowerCase() !== self) continue
    const from = row.from?.toLowerCase()
    // A self-send funds nothing.
    if (!from || from === self) continue
    const seconds = Number(row.timeStamp)
    if (!Number.isFinite(seconds)) continue
    const timestampMs = seconds * 1_000
    if (best === null || timestampMs < best.timestampMs) best = { from, timestampMs, via }
  }

  return best
}

/**
 * Pure: everything it reads was already fetched by fetchAddressHistory.
 *
 * Native transfers win over token transfers even when a token transfer is
 * older, because they answer different questions. The first inbound ETH names
 * whoever paid for this wallet to exist. The first inbound token often names a
 * contract instead: 0xeA25...9F04 has WETH (0x4200...0006) as the sender of its
 * earliest transfer, which says nothing about funding. Token transfers are the
 * fallback for the wallets that never sent a transaction at all, where they are
 * the only inbound evidence there is.
 */
export function deriveFunding(history: AddressHistory): FundingProvenance {
  const native = earliestInbound(history.earliest, history.address, 'native')
  const token = earliestInbound(history.earliestTokenTransfers, history.address, 'token')
  const first = native ?? token

  if (first === null) {
    return { class: 'none', source: null, label: null, firstInboundAt: null, via: null }
  }

  const { class: fundingClass, label } = classifyFunder(first.from)
  return {
    class: fundingClass,
    source: first.from,
    label,
    firstInboundAt: new Date(first.timestampMs).toISOString(),
    via: first.via,
  }
}
