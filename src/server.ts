/**
 * npx tsx src/server.ts
 *
 *   GET /verify?address=0x...             -> signed attestation (see attest.ts for the shape)
 *   GET /verify?address=0x...&explain=1   -> { attestation, breakdown }: the same signed
 *                                            attestation plus the UNSIGNED score arithmetic
 *                                            (axes, weights, penalty, confidence, cutoffs)
 *                                            so a screen can draw why the score is what it is
 *   GET /                                 -> ui/index.html, the split-screen demo
 *
 * Stateless: every request reads Blockscout and signs a fresh, point-in-time
 * attestation. Consumers decide their own freshness policy from `issued_at`.
 *
 * Status codes say what went wrong, so a caller can tell a bad address (400)
 * from Blockscout being unavailable (502) from a bug here (500). Only 200
 * carries an attestation.
 */

import { fileURLToPath } from 'node:url'

import express, { type Request, type Response } from 'express'

import { attesterAccount } from './attest.js'
import { BlockscoutError, chainId } from './blockscout.js'
import { ConfigError, SCORE, VERDICT, loadDotEnv } from './config.js'
import type { ScoreBreakdown } from './score.js'
import { InvalidAddressError, requireVerifyConfig, verify } from './verify.js'

loadDotEnv()

const DEFAULT_PORT = 3000

function port(): number {
  const value = Number(process.env.PORT)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT
}

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))

/** The score arithmetic, snake_case like the attestation. Not signed: it is derivable from it. */
function explain(breakdown: ScoreBreakdown) {
  const axis = (a: ScoreBreakdown['axes'][keyof ScoreBreakdown['axes']]) => ({
    value: a.value,
    normalized: a.normalized,
    weight: a.weight,
  })
  return {
    axes: {
      funding: axis(breakdown.axes.funding),
      maturity: axis(breakdown.axes.maturity),
      volume: axis(breakdown.axes.volume),
    },
    geometric_mean: breakdown.geometricMean,
    penalty: breakdown.penalty,
    confidence: breakdown.confidence,
    evidence_mass: breakdown.evidenceMass,
    scale: SCORE.scale,
    cutoffs: { suspicious_max: VERDICT.suspiciousMax, trusted_min: VERDICT.trustedMin },
  }
}

async function handleVerify(req: Request, res: Response): Promise<void> {
  const input = req.query.address
  const wantsExplain = req.query.explain === '1'

  try {
    const { attestation, breakdown } = await verify(input)
    // Point-in-time by design: nothing in between should cache it.
    res.setHeader('cache-control', 'no-store')
    res.status(200).json(wantsExplain ? { attestation, breakdown: explain(breakdown) } : attestation)
  } catch (error) {
    if (error instanceof InvalidAddressError) {
      res.status(400).json({ error: error.message, usage: '/verify?address=0x...' })
      return
    }
    if (error instanceof BlockscoutError) {
      console.error(`[verify] ${String(input)}: ${error.message}`)
      res.status(502).json({ error: `upstream: ${error.message}` })
      return
    }
    console.error(`[verify] ${String(input)}:`, error)
    res.status(500).json({ error: 'internal error' })
  }
}

function main(): void {
  try {
    requireVerifyConfig()
  } catch (error) {
    // Refuse to start misconfigured: better one clear line now than a 500 later.
    console.error(error instanceof ConfigError ? error.message : String(error))
    process.exitCode = 1
    return
  }

  const app = express()
  app.disable('x-powered-by')
  app.get('/verify', (req, res) => {
    void handleVerify(req, res)
  })
  // The demo UI: one static file, no build. `/` is index.html.
  app.use(express.static(UI_DIR, { index: 'index.html', cacheControl: false, etag: false }))

  const listenPort = port()
  app.listen(listenPort, () => {
    console.log(`KYA · GET http://localhost:${listenPort}/verify?address=0x...`)
    console.log(`  ui        http://localhost:${listenPort}/`)
    console.log(`  chain     ${chainId()}`)
    console.log(`  attester  ${attesterAccount().address}   (pin this address to verify signatures)`)
  })
}

main()
