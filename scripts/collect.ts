/**
 * npx tsx scripts/collect.ts 0x...
 *
 * Reads one Base address from Blockscout and prints its 4 signals.
 */

import { existsSync } from 'node:fs'
import { getAddress, isAddress } from 'viem'

import {
  BlockscoutError,
  ConfigError,
  chainId,
  fetchAddressHistory,
  requireApiKey,
} from '../src/blockscout.js'
import { deriveSignals, type Signals } from '../src/signals.js'

if (existsSync('.env')) process.loadEnvFile('.env')

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

async function main(): Promise<void> {
  const input = process.argv[2]

  if (input === undefined) {
    console.error('usage: npx tsx scripts/collect.ts 0xAddress')
    process.exitCode = 1
    return
  }

  if (!isAddress(input, { strict: false })) {
    console.error(`not a valid address: ${input}`)
    process.exitCode = 1
    return
  }

  const address = getAddress(input)

  try {
    requireApiKey() // fail here, not at the first 402
    const history = await fetchAddressHistory(address)
    print(deriveSignals(history))
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
    } else {
      const detail = error instanceof BlockscoutError ? error.message : String(error)
      console.error(`blockscout lookup failed for ${address}: ${detail}`)
    }
    process.exitCode = 1
  }
}

await main()
