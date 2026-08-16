/**
 * npx tsx scripts/capture.ts                 captures the demo addresses below
 * npx tsx scripts/capture.ts 0x... 0x...     captures the given addresses
 *
 * Reads Blockscout NOW and writes data/fixtures/<address>.json, the same file
 * format the 10-minute cache uses (src/history.ts). Fixtures are committed and
 * replayed by --offline, so the demo survives Blockscout being down (PLAN.md,
 * risk 1: it answered 500 for 23 of 30 addresses seven days before the pitch).
 *
 * A fixture is a DATED CAPTURE OF A LIVE ADDRESS, not a synthetic case. Each
 * file says when it was read (`captured_at`) and the attestation replayed from
 * it carries that instant as `evidence.fetched_at`. Re-run this script to
 * refresh; the verdicts can move as the addresses live on.
 */

import { getAddress, isAddress } from 'viem'

import { BlockscoutError, chainId, requireApiKey } from '../src/blockscout.js'
import { ConfigError, loadDotEnv } from '../src/config.js'
import { deriveFunding } from '../src/funding.js'
import { captureFixture } from '../src/history.js'
import { scoreAddress } from '../src/score.js'
import { deriveSignals } from '../src/signals.js'
import { decide } from '../src/verdict.js'

loadDotEnv()

/** The three cases of the pitch plus the zero-history edge case. */
const DEMO_ADDRESSES = [
  '0x2CfF890f0378a11913B6129B2E97417a2c302680', // established, exchange-funded, TRUSTED
  '0xBEabA203Ef49Ee2828b77b0B7E84839e76092787', // fresh, exchange-funded, days old, SUSPICIOUS
  '0x098b716b8aaf21512996dc57eb0615e2383e2f96', // OFAC SDN (Lazarus Group), GATED
  '0xeB94Dd34439e017EBa695678265e44Ea12E16B97', // generated locally, zero transactions, SUSPICIOUS 0
]

async function main(): Promise<void> {
  const inputs = process.argv.slice(2)
  const targets = inputs.length > 0 ? inputs : DEMO_ADDRESSES

  const bad = targets.filter((a) => !isAddress(a, { strict: false }))
  if (bad.length > 0) {
    console.error(`not an address: ${bad.join(', ')}`)
    process.exitCode = 1
    return
  }

  try {
    requireApiKey()
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error))
    process.exitCode = 1
    return
  }

  console.log(`KYA · capturing ${targets.length} fixture(s) from Blockscout Pro, chain ${chainId()}`)
  let failures = 0
  for (const input of targets) {
    const address = getAddress(input)
    try {
      const { path, history } = await captureFixture(address)
      const signals = deriveSignals(history)
      const verdict = decide(scoreAddress(signals, deriveFunding(history)))
      const badge = verdict.gated ? 'GATED' : verdict.verdict.toUpperCase()
      console.log(`  ${address}  ${badge.padEnd(10)} score ${String(verdict.score).padStart(4)}  ${history.window.length} tx in window  -> ${path}`)
    } catch (error) {
      failures += 1
      const detail = error instanceof BlockscoutError ? error.message : String(error)
      console.error(`  ${address}  FAILED  ${detail}`)
    }
  }
  console.log(failures === 0 ? '  done. Commit data/fixtures/ so --offline can replay them.' : `  ${failures} failed; the others were written.`)
  process.exitCode = failures === 0 ? 0 : 1
}

await main()
