/**
 * npx tsx src/cli.ts 0x...
 * npx tsx src/cli.ts --offline 0x...     replay the committed fixture, no network
 *
 * The whole pipeline in one screen: signals, funding, score, verdict, and why.
 */

import { BlockscoutError, WINDOW_MAX_TXS, chainId } from './blockscout.js'
import { ConfigError, SCORE, VERDICT, WEIGHTS, loadDotEnv } from './config.js'
import { isOffline, setOffline } from './history.js'
import { InvalidAddressError, requireVerifyConfig, verify, type Verification } from './verify.js'

loadDotEnv()
if (process.argv.includes('--offline')) setOffline(true)

const LABEL_WIDTH = 15

function line(label: string, value: string): string {
  return `  ${label.padEnd(LABEL_WIDTH)}${value}`
}

const BADGE: Record<string, string> = {
  trusted: 'TRUSTED',
  unknown: 'UNKNOWN',
  suspicious: 'SUSPICIOUS',
}

function print({ signals, funding, breakdown, verdict, attestation, source, capturedAt }: Verification): void {
  const badge = verdict.gated ? `${BADGE[verdict.verdict]} · GATED` : BADGE[verdict.verdict]
  const origin =
    source === 'live'
      ? `Blockscout Pro · chain ${chainId()}`
      : source === 'cache'
        ? `cache (read ${capturedAt}) · chain ${chainId()}`
        : `OFFLINE · fixture captured ${capturedAt} · chain ${chainId()}`

  console.log('')
  console.log(`KYA · ${origin}`)
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

  console.log('  attestation')
  console.log(line('    attester', attestation.attester))
  console.log(line('    issued', attestation.issued_at))
  console.log(line('    signature', attestation.signature))
  console.log('')
  console.log(
    `  cutoffs: suspicious <= ${VERDICT.suspiciousMax} < unknown < ${VERDICT.trustedMin} <= trusted` +
      `   ·   weights funding ${WEIGHTS.funding} / maturity ${WEIGHTS.maturity} / volume ${WEIGHTS.volume}`,
  )
  console.log('  measures history, not intent')
  console.log('')
}

async function main(): Promise<void> {
  const input = process.argv.slice(2).find((arg) => !arg.startsWith('--'))

  if (input === undefined) {
    console.error('usage: npx tsx src/cli.ts [--offline] 0xAddress')
    process.exitCode = 1
    return
  }

  try {
    requireVerifyConfig()
    print(await verify(input))
  } catch (error) {
    if (error instanceof ConfigError || error instanceof InvalidAddressError) {
      console.error(error.message)
    } else {
      const detail = error instanceof BlockscoutError ? error.message : String(error)
      console.error(`verify failed for ${input}${isOffline() ? ' (offline)' : ''}: ${detail}`)
    }
    process.exitCode = 1
  }
}

await main()
