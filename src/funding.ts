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
import { lookupCex } from './cex-labels.js'
import { OFAC_SANCTIONED } from './sanctions.js'

export type FundingClass = 'exchange' | 'mixer' | 'sanctioned' | 'unknown' | 'none'

/**
 * How well the funder is known, which is NOT the same question as what it is.
 *
 *   confirmed  exact match against a named, pinned, citable list
 *   inferred   matched only the behavioural heuristic below: custodial-scale,
 *              but nobody has said whose
 *
 * This never moves the class, so it never moves the score. See classifyFunder.
 */
export type FunderIdentity = 'confirmed' | 'inferred'

export type FundingProvenance = {
  class: FundingClass
  /** The funding address. Null when nothing ever came in. */
  source: string | null
  /** What matched in a list, for showing a blocked payer why. */
  label: string | null
  /** Quality of the exchange identity. Null outside the exchange path. */
  identity: FunderIdentity | null
  /** The exchange's own name for the funder, e.g. "Binance 76". Confirmed hits only. */
  funderLabel: string | null
  /** Where that name came from, e.g. "dune-spellbook@9f61b0d". Confirmed hits only. */
  labelSource: string | null
  firstInboundAt: string | null
  via: 'native' | 'token' | null
}

/**
 * Exchange-class hot wallets on Base. The FALLBACK path, now that there is a
 * named list in front of it (see cex-labels.ts).
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
 * Custodial-scale by behaviour, identity unconfirmed by construction.
 *
 * Kept after adding the Dune Spellbook list, for two reasons. It covers what the
 * list misses (0x8581... funds a wallet in the reference set and is in no list I
 * have found), and scoring the heuristic against the list is the only evidence I
 * have that it works: checked 2026-08-17, 2 of these 3 are in the pinned list,
 * as Binance 76 and Bybit 6. The third is not refuted, only unnamed.
 *
 * Counters read 2026-08-16.
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

/** What classifyFunder decides, before the timestamps get attached. */
type FunderClassification = Pick<
  FundingProvenance,
  'class' | 'label' | 'identity' | 'funderLabel' | 'labelSource'
>

const UNCLASSIFIED: FunderClassification = {
  class: 'unknown',
  label: null,
  identity: null,
  funderLabel: null,
  labelSource: null,
}

/**
 * Severity order: a sanctioned exchange wallet is sanctioned first.
 *
 * Within the exchange path, the named list is checked BEFORE the behavioural
 * heuristic, and both return the same class. That is the point: the list changes
 * what KYA can honestly SAY about a funder, never what KYA counts. The score
 * reads `class`, and `class` is 'exchange' either way, so adding the list moved
 * no score in the reference set. Measured, not assumed: see DECISIONS.md.
 */
export function classifyFunder(funder: string): FunderClassification {
  const key = funder.toLowerCase()

  const sanctioned = OFAC_SANCTIONED.get(key)
  if (sanctioned !== undefined) {
    return { ...UNCLASSIFIED, class: 'sanctioned', label: `OFAC SDN: ${sanctioned}` }
  }

  const mixer = KNOWN_MIXERS.get(key)
  if (mixer !== undefined) return { ...UNCLASSIFIED, class: 'mixer', label: mixer }

  const cex = lookupCex(key)
  if (cex !== null) {
    return {
      class: 'exchange',
      label: `${cex.cex} (${cex.name}), identity confirmed against ${cex.source}`,
      identity: cex.identity,
      funderLabel: cex.name,
      labelSource: cex.source,
    }
  }

  const exchange = EXCHANGE_CLASS.get(key)
  if (exchange !== undefined) {
    return { ...UNCLASSIFIED, class: 'exchange', label: exchange, identity: 'inferred' }
  }

  return UNCLASSIFIED
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
    return {
      ...UNCLASSIFIED,
      class: 'none',
      source: null,
      firstInboundAt: null,
      via: null,
    }
  }

  return {
    ...classifyFunder(first.from),
    source: first.from,
    firstInboundAt: new Date(first.timestampMs).toISOString(),
    via: first.via,
  }
}
