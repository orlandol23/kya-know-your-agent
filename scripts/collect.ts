/**
 * npx tsx scripts/collect.ts            reads data/addresses.csv -> data/signals.csv
 * npx tsx scripts/collect.ts 0x...      prints the 4 signals for one address
 *
 * signals.csv is committed: it is the evidence behind every calibrated number.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { getAddress, isAddress } from 'viem'

import {
  BlockscoutError,
  ConfigError,
  chainId,
  fetchAddressHistory,
  requireApiKey,
} from '../src/blockscout.js'
import { parseCsv, toCsv, type CsvRow } from '../src/csv.js'
import { deriveSignals, type Signals } from '../src/signals.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const ADDRESSES_CSV = 'data/addresses.csv'
const SIGNALS_CSV = 'data/signals.csv'

/** Section 4b of PLAN.md. */
const SIGNALS_COLUMNS = [
  'address',
  'label',
  'first_seen',
  'age_days',
  'tx_count',
  'distinct_counterparties',
  'txs_24h',
  'txs_7d',
  'fetched_at',
  'blockscout_url',
]

const LABEL_WIDTH = 13

function line(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`
}

function print(signals: Signals): void {
  const age =
    signals.firstSeen === null
      ? 'no transactions yet'
      : `${signals.ageDays} days   first seen ${signals.firstSeen}`

  const volume = signals.txCountExact
    ? `${signals.txCount} transactions   (lifetime, /counters)`
    : `>= ${signals.txCount} transactions   (/counters unavailable, window lower bound)`

  const window = signals.windowIsCapped
    ? `last ${signals.windowSize} transactions (capped)`
    : `last ${signals.windowSize} transactions (full history)`

  console.log('')
  console.log(`KYA · signals · Blockscout Pro · chain ${chainId()}`)
  console.log(`${signals.address}`)
  console.log('')
  console.log(line('age', age))
  console.log(line('volume', volume))
  console.log(line('diversity', `${signals.distinctCounterparties} distinct counterparties`))
  console.log(line('cadence', `${signals.txs24h} tx / 24h   ·   ${signals.txs7d} tx / 7d`))
  console.log('')
  console.log(line('window', window))
  console.log(line('evidence', signals.blockscoutUrl))
  console.log(line('fetched at', signals.fetchedAt))
  console.log('')
  console.log('  diversity and cadence are windowed over the transactions above')
  console.log('')
}

function toSignalsRow(signals: Signals, label: string): CsvRow {
  return {
    address: signals.address,
    label,
    first_seen: signals.firstSeen ?? '',
    age_days: String(signals.ageDays),
    tx_count: String(signals.txCount),
    distinct_counterparties: String(signals.distinctCounterparties),
    txs_24h: String(signals.txs24h),
    txs_7d: String(signals.txs7d),
    fetched_at: signals.fetchedAt,
    blockscout_url: signals.blockscoutUrl,
  }
}

async function collectOne(input: string): Promise<void> {
  const address = getAddress(input)
  const history = await fetchAddressHistory(address)
  print(deriveSignals(history))
}

async function collectSet(): Promise<void> {
  if (!existsSync(ADDRESSES_CSV)) {
    throw new ConfigError(`${ADDRESSES_CSV} not found. It is the input of the calibration.`)
  }

  const entries = parseCsv(readFileSync(ADDRESSES_CSV, 'utf8'))
  console.log(`collecting ${entries.length} addresses from ${ADDRESSES_CSV}`)

  const rows: CsvRow[] = []
  const failures: string[] = []
  let pending = entries

  // Blockscout answered 500 for 23 of 30 addresses on 2026-08-15. One extra
  // sweep at the end turns a degraded window into a complete file.
  for (const attempt of [1, 2]) {
    if (pending.length === 0) break
    if (attempt === 2) console.log(`\nsecond pass over ${pending.length} address(es) that failed`)

    const stillFailing: typeof entries = []

    for (const [index, entry] of pending.entries()) {
      const position = `${String(index + 1).padStart(2)}/${pending.length}`
      const input = entry.address ?? ''

      if (!isAddress(input, { strict: false })) {
        failures.push(`${input || '(empty)'}: not a valid address`)
        console.log(`${position}  ${input || '(empty)'}  SKIPPED, not a valid address`)
        continue
      }

      const address = getAddress(input)
      const label = entry.label ?? ''

      try {
        const signals = deriveSignals(await fetchAddressHistory(address))
        rows.push(toSignalsRow(signals, label))
        console.log(
          `${position}  ${address}  ${label.padEnd(13)}` +
            `age ${String(signals.ageDays).padStart(8)}d  ` +
            `tx ${String(signals.txCount).padStart(6)}  ` +
            `cp ${String(signals.distinctCounterparties).padStart(3)}  ` +
            `7d ${String(signals.txs7d).padStart(3)}`,
        )
      } catch (error) {
        const detail = error instanceof BlockscoutError ? error.message : String(error)
        console.log(`${position}  ${address}  FAILED, ${detail}`)
        if (attempt === 1) stillFailing.push(entry)
        else failures.push(`${address}: ${detail}`)
      }
    }

    pending = stillFailing
  }

  writeFileSync(SIGNALS_CSV, toCsv(rows, SIGNALS_COLUMNS))
  console.log(`\nwrote ${rows.length} rows to ${SIGNALS_CSV}`)

  const byLabel = new Map<string, number>()
  for (const row of rows) byLabel.set(row.label ?? '', (byLabel.get(row.label ?? '') ?? 0) + 1)
  console.log(`groups: ${[...byLabel].map(([l, n]) => `${l} ${n}`).join(', ')}`)

  if (failures.length > 0) {
    console.log(`\n${failures.length} address(es) not collected:`)
    for (const failure of failures) console.log(`  ${failure}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  const input = process.argv[2]

  if (input !== undefined && !isAddress(input, { strict: false })) {
    console.error(`not a valid address: ${input}`)
    console.error('usage: npx tsx scripts/collect.ts [0xAddress]')
    process.exitCode = 1
    return
  }

  try {
    requireApiKey() // fail here, not at the first 402
    if (input === undefined) await collectSet()
    else await collectOne(input)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
    } else {
      const detail = error instanceof BlockscoutError ? error.message : String(error)
      console.error(`blockscout lookup failed: ${detail}`)
    }
    process.exitCode = 1
  }
}

await main()
