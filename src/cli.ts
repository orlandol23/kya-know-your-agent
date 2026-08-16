/**
 * npx tsx src/cli.ts 0x...
 *
 * The whole pipeline in one screen: signals, funding, score, verdict, and why.
 */

import { existsSync } from 'node:fs'
import { getAddress, isAddress } from 'viem'

import {
  BlockscoutError,
  ConfigError,
  WINDOW_MAX_TXS,
  chainId,
  fetchAddressHistory,
  requireApiKey,
} from './blockscout.js'
import { SCORE, VERDICT, WEIGHTS } from './config.js'
import { deriveFunding, type FundingProvenance } from './funding.js'
import { scoreAddress, type ScoreBreakdown } from './score.js'
import { deriveSignals, type Signals } from './signals.js'
import { decide, type Verdict } from './verdict.js'

if (existsSync('.env')) process.loadEnvFile('.env')

const LABEL_WIDTH = 15

function line(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`
}

const BADGE: Record<string, string> = {
  trusted: 'TRUSTED',
  unknown: 'UNKNOWN',
  suspicious: 'SUSPICIOUS',
}

function print(
  signals: Signals,
  funding: FundingProvenance,
  breakdown: ScoreBreakdown,
  verdict: Verdict,
): void {
  const badge = verdict.gated ? `${BADGE[verdict.verdict]} · GATED` : BADGE[verdict.verdict]

  console.log('')
  console.log(`KYA · Blockscout Pro · chain ${chainId()}`)
  console.log(signals.address)
  console.log('')
  console.log(`  ${badge}   score ${breakdown.score} / ${SCORE.scale}`)
  console.log(`  ${verdict.summary}`)
  console.log('')

  console.log('  why')
  for (const reason of verdict.reasons) console.log(`    - ${reason}`)
  console.log('')

  console.log('  scored axes')
  for (const [name, axis] of Object.entries(breakdown.axes)) {
    const bar = '#'.repeat(Math.round(axis.normalized * 20)).padEnd(20, '.')
    console.log(
      `    ${name.padEnd(10)}w ${axis.weight.toFixed(2)}  ${bar}  ${axis.normalized.toFixed(3)}`,
    )
  }
  console.log(
    `    ${'='.padEnd(10)}          geometric mean ${breakdown.geometricMean.toFixed(3)}` +
      ` x penalty ${breakdown.penalty.toFixed(2)}` +
      ` x confidence ${breakdown.confidence.toFixed(2)}`,
  )
  console.log('')

  console.log('  signals')
  console.log(
    line(
      '    age',
      signals.firstSeen === null
        ? 'no transactions yet'
        : `${signals.ageDays} days   first seen ${signals.firstSeen}`,
    ),
  )
  console.log(
    line(
      '    volume',
      signals.txCountExact
        ? `${signals.txCount} transactions`
        : `>= ${signals.txCount} transactions (counter unavailable)`,
    ),
  )
  console.log(
    line(
      '    funding',
      funding.source === null
        ? 'no inbound transfer'
        : `${funding.class}   ${funding.source}` +
          (funding.via === null ? '' : `   via ${funding.via}, ${funding.firstInboundAt}`),
    ),
  )
  if (funding.label !== null) console.log(line('    ', funding.label))
  console.log('')

  console.log('  collected, not scored')
  console.log(line('    diversity', `${signals.distinctCounterparties} distinct counterparties`))
  console.log(
    line('    cadence', `${signals.txs24h} tx / 24h   ·   ${signals.txs7d} tx / 7d`),
  )
  console.log(
    line(
      '    burst',
      signals.burstRatio === null ? 'not enough transactions to measure' : `${signals.burstRatio}x`,
    ),
  )
  console.log('    (diversity and cadence did not separate the reference set: weight 0)')
  console.log('')

  console.log('  evidence')
  console.log(line('    window', `last ${signals.windowSize} of <= ${WINDOW_MAX_TXS} transactions`))
  console.log(line('    link', signals.blockscoutUrl))
  console.log(line('    at', signals.fetchedAt))
  console.log('')
  console.log(
    `  cutoffs: suspicious <= ${VERDICT.suspiciousMax} < unknown < ${VERDICT.trustedMin} <= trusted` +
      `   ·   weights funding ${WEIGHTS.funding} / maturity ${WEIGHTS.maturity} / volume ${WEIGHTS.volume}`,
  )
  console.log('  measures history, not intent')
  console.log('')
}

async function main(): Promise<void> {
  const input = process.argv[2]

  if (input === undefined) {
    console.error('usage: npx tsx src/cli.ts 0xAddress')
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
    requireApiKey()
    const history = await fetchAddressHistory(address)
    const signals = deriveSignals(history)
    const funding = deriveFunding(history)
    const breakdown = scoreAddress(signals, funding)
    print(signals, funding, breakdown, decide(breakdown))
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
    } else {
      const detail = error instanceof BlockscoutError ? error.message : String(error)
      console.error(`verify failed for ${address}: ${detail}`)
    }
    process.exitCode = 1
  }
}

await main()
