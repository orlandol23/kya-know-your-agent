/**
 * Blockscout history -> the 4 signals: age, volume, diversity, cadence.
 *
 * Diversity and cadence are windowed over the last <= 150 transactions
 * (see WINDOW_MAX_TXS). The window flag travels with the signals so every
 * consumer can state the limitation instead of hiding it.
 */

import { WINDOW_MAX_TXS, type AddressHistory, type WindowTx } from './blockscout.js'
import { percentile, sortedAscending } from './stats.js'

const MS_PER_DAY = 86_400_000

/** Below this many transactions the gap distribution is noise, not a pattern. */
const BURST_MIN_TXS = 21
/** Same-block transactions have a zero gap. Floor it instead of dividing by 0. */
const MIN_GAP_MS = 1_000

export type Signals = {
  address: string

  // AGE
  /** ISO-8601 timestamp of the oldest transaction, null when there is none. */
  firstSeen: string | null
  ageDays: number

  // VOLUME
  txCount: number
  /** False when /counters had no value and txCount is a window lower bound. */
  txCountExact: boolean

  // DIVERSITY
  distinctCounterparties: number

  // CADENCE
  txs24h: number
  txs7d: number
  /**
   * How much tighter the fastest 1% of gaps between transactions is than the
   * median gap. High means the history arrives in bursts. Null when the window
   * holds too few transactions to say anything.
   */
  burstRatio: number | null

  // provenance
  windowSize: number
  /** True when the address has more history than the window could read. */
  windowIsCapped: boolean
  fetchedAt: string
  blockscoutUrl: string
}

/** The other side of a transaction, or null for a self-send. */
function counterpartyOf(tx: WindowTx, address: string): string | null {
  const self = address.toLowerCase()
  const from = tx.from?.toLowerCase() ?? null
  const to = tx.to?.toLowerCase() ?? null

  if (from !== null && from !== self) return from
  if (to !== null && to !== self) return to
  return null
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * median gap / fastest-1% gap, over the window.
 *
 * The plan writes burst_ratio as p99 of the RATE over the median rate. Rate is
 * the reciprocal of the gap between transactions, so the p99 rate is the p1 gap,
 * and the ratio is computed on gaps here to avoid dividing by zero twice.
 */
function burstRatioOf(window: WindowTx[]): number | null {
  const times = sortedAscending(
    window.map((tx) => tx.timestampMs).filter((ms): ms is number => ms !== null),
  )
  if (times.length < BURST_MIN_TXS) return null

  const gaps: number[] = []
  for (let i = 1; i < times.length; i += 1) {
    gaps.push((times[i] as number) - (times[i - 1] as number))
  }

  const sorted = sortedAscending(gaps)
  const median = percentile(sorted, 0.5)
  const fastest = Math.max(percentile(sorted, 0.01), MIN_GAP_MS)
  return round(median / fastest, 2)
}

export function deriveSignals(history: AddressHistory): Signals {
  const { address, earliest, window, counters, fetchedAt, blockscoutUrl } = history
  const now = Date.parse(fetchedAt)

  const firstTransaction = earliest[0] ?? null
  const firstSeenMs =
    firstTransaction === undefined || firstTransaction === null
      ? null
      : Number(firstTransaction.timeStamp) * 1_000
  const firstSeen =
    firstSeenMs === null || !Number.isFinite(firstSeenMs)
      ? null
      : new Date(firstSeenMs).toISOString()
  const ageDays =
    firstSeen === null ? 0 : round(Math.max(0, now - Date.parse(firstSeen)) / MS_PER_DAY, 2)

  const counterparties = new Set<string>()
  let txs24h = 0
  let txs7d = 0

  for (const tx of window) {
    const counterparty = counterpartyOf(tx, address)
    if (counterparty !== null) counterparties.add(counterparty)

    const ms = tx.timestampMs
    if (ms === null) continue
    const ageMs = now - ms
    if (ageMs <= MS_PER_DAY) txs24h += 1
    if (ageMs <= 7 * MS_PER_DAY) txs7d += 1
  }

  // A lifetime count below the window size is impossible: the window is a subset
  // of all transactions. It means /counters is missing or still cold, so report
  // the window as a lower bound instead of a number known to be wrong.
  const countIsUsable =
    counters.transactionsCount !== null && counters.transactionsCount >= window.length
  const txCountExact = countIsUsable
  const txCount = countIsUsable ? (counters.transactionsCount as number) : window.length

  return {
    address,
    firstSeen,
    ageDays,
    txCount,
    txCountExact,
    distinctCounterparties: counterparties.size,
    txs24h,
    txs7d,
    burstRatio: burstRatioOf(window),
    windowSize: window.length,
    windowIsCapped: window.length >= WINDOW_MAX_TXS,
    fetchedAt,
    blockscoutUrl,
  }
}
