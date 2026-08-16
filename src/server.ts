/**
 * npx tsx src/server.ts
 *
 *   GET /verify?address=0x...   -> signed attestation (see attest.ts for the shape)
 *
 * Stateless: every request reads Blockscout and signs a fresh, point-in-time
 * attestation. Consumers decide their own freshness policy from `issued_at`.
 *
 * Status codes say what went wrong, so a caller can tell a bad address (400)
 * from Blockscout being unavailable (502) from a bug here (500). Only 200
 * carries an attestation.
 */

import express, { type Request, type Response } from 'express'

import { attesterAccount } from './attest.js'
import { BlockscoutError, chainId } from './blockscout.js'
import { ConfigError, loadDotEnv } from './config.js'
import { InvalidAddressError, requireVerifyConfig, verify } from './verify.js'

loadDotEnv()

const DEFAULT_PORT = 3000

function port(): number {
  const value = Number(process.env.PORT)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT
}

async function handleVerify(req: Request, res: Response): Promise<void> {
  const input = req.query.address

  try {
    const { attestation } = await verify(input)
    // Point-in-time by design: nothing in between should cache it.
    res.setHeader('cache-control', 'no-store')
    res.status(200).json(attestation)
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

  const listenPort = port()
  app.listen(listenPort, () => {
    console.log(`KYA · GET http://localhost:${listenPort}/verify?address=0x...`)
    console.log(`  chain     ${chainId()}`)
    console.log(`  attester  ${attesterAccount().address}   (pin this address to verify signatures)`)
  })
}

main()
