/**
 * Blockscout history -> the 4 signals: age, volume, diversity, cadence.
 *
 * Diversity and cadence are windowed over the last <= 150 transactions
 * (see WINDOW_MAX_TXS). The window flag travels with the signals so every
 * consumer can state the limitation instead of hiding it.
 */

import {
  WINDOW_MAX_TXS,
  type AddressHistory,
  type V2Transaction,
} from './blockscout.js'

const MS_PER_DAY = 86_400_000

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

  // provenance
  windowSize: number
  /** True when the address has more history than the window could read. */
  windowIsCapped: boolean
  fetchedAt: string
  blockscoutUrl: string
}

/** The other side of a transaction, or null for a self-send. */
function counterpartyOf(tx: V2Transaction, address: string): string | null {
  const self = address.toLowerCase()
  const from = tx.from?.hash?.toLowerCase() ?? null
  const to = tx.to?.hash?.toLowerCase() ?? tx.created_contract?.hash?.toLowerCase() ?? null

  if (from !== null && from !== self) return from
  if (to !== null && to !== self) return to
  return null
}

function timestampMs(tx: V2Transaction): number | null {
  if (tx.timestamp === null || tx.timestamp === undefined) return null
  const ms = Date.parse(tx.timestamp)
  return Number.isFinite(ms) ? ms : null
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

export function deriveSignals(history: AddressHistory): Signals {
  const { address, firstTransaction, window, counters, fetchedAt, blockscoutUrl } = history
  const now = Date.parse(fetchedAt)

  const firstSeenMs =
    firstTransaction === null ? null : Number(firstTransaction.timeStamp) * 1_000
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

    const ms = timestampMs(tx)
    if (ms === null) continue
    const ageMs = now - ms
    if (ageMs <= MS_PER_DAY) txs24h += 1
    if (ageMs <= 7 * MS_PER_DAY) txs7d += 1
  }

  const txCountExact = counters.transactionsCount !== null
  const txCount = counters.transactionsCount ?? window.length

  return {
    address,
    firstSeen,
    ageDays,
    txCount,
    txCountExact,
    distinctCounterparties: counterparties.size,
    txs24h,
    txs7d,
    windowSize: window.length,
    windowIsCapped: window.length >= WINDOW_MAX_TXS,
    fetchedAt,
    blockscoutUrl,
  }
}
