/**
 * npx tsx demo/paid-endpoint.ts [--real]
 *
 * The seller side of the demo: a paid inference endpoint behind the KYA gate.
 * The story is a hosted chemistry model, priced per call over x402, whose
 * operator cares who is calling because the output can be misused.
 *
 *   GET /chem?q=...      $0.001 USDC on Base Sepolia
 *
 * Middleware order is the product:
 *
 *   app.use(kyaGate())               reads the payer from X-PAYMENT, 403 if suspicious
 *   app.use(paymentMiddleware(...))  x402-express: verify, then settle after the handler
 *   app.get('/chem', ...)            the resource
 *
 * A 403 from the gate happens before x402-express ever runs, so the rejected
 * agent pays nothing. Reputation is read from Base MAINNET (the agent's real
 * history); the payment runs on Base SEPOLIA with the same address.
 *
 * Two modes, same gate, same x402-express middleware, same routes:
 *
 *   default   settlement SIMULATED. x402-express is pointed at a stub
 *             facilitator served by this same process: /verify says valid,
 *             /settle says success and moves nothing. No testnet funds needed.
 *             The X-PAYMENT-RESPONSE header carries `simulated: true`.
 *   --real    settlement REAL through https://x402.org/facilitator on Base
 *             Sepolia. The paying wallet needs Sepolia USDC and DEMO_PAY_TO
 *             should be an address you control.
 *
 * Env: DEMO_PORT (4021), DEMO_PAY_TO (defaults to the attester address, which
 * is fine for simulated mode and wrong for real mode).
 */

import express, { type Request, type Response } from 'express'
import type { Address } from 'viem'
import { paymentMiddleware, type Network } from 'x402-express'

import { attesterAccount } from '../src/attest.js'
import { chainId } from '../src/blockscout.js'
import { ConfigError, loadDotEnv } from '../src/config.js'
import { kyaGate, type GateResult } from '../src/gate.js'
import { requireVerifyConfig } from '../src/verify.js'

loadDotEnv()

const REAL = process.argv.includes('--real')
const DEFAULT_PORT = 4021
const NETWORK: Network = 'base-sepolia'
const PRICE = '$0.001'
const REAL_FACILITATOR = 'https://x402.org/facilitator'

function port(): number {
  const value = Number(process.env.DEMO_PORT)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT
}

function payTo(): Address {
  const value = process.env.DEMO_PAY_TO?.trim()
  return value ? (value as Address) : attesterAccount().address
}

/**
 * The stub facilitator: the two calls x402-express makes, answered locally.
 * It moves no funds and checks no signature; the gate in front of it is the
 * only thing being demonstrated, and it runs the same either way.
 */
function stubFacilitator(app: express.Express, mountPath: string): void {
  app.use(mountPath, express.json())
  app.post(`${mountPath}/verify`, (req: Request, res: Response) => {
    const payer = req.body?.paymentPayload?.payload?.authorization?.from
    res.json({ isValid: true, payer })
  })
  app.post(`${mountPath}/settle`, (req: Request, res: Response) => {
    const payer = req.body?.paymentPayload?.payload?.authorization?.from
    const network = req.body?.paymentPayload?.network
    console.log(`[x402] ${String(payer).slice(0, 6)}…${String(payer).slice(-4)}  settled (SIMULATED, no funds moved)`)
    res.json({ success: true, simulated: true, transaction: '', network, payer })
  })
}

function answer(question: string): string {
  // A stand-in for the model. The point of the demo is who gets to ask.
  return `[chem-model] "${question}" -> this is a demo answer; the real model would reply here.`
}

function main(): void {
  try {
    requireVerifyConfig()
  } catch (error) {
    console.error(error instanceof ConfigError ? error.message : String(error))
    process.exitCode = 1
    return
  }

  const listenPort = port()
  const receiver = payTo()
  const facilitatorUrl = REAL ? REAL_FACILITATOR : `http://localhost:${listenPort}/facilitator`

  const app = express()
  app.disable('x-powered-by')

  if (!REAL) stubFacilitator(app, '/facilitator')

  // 1. Who is paying, and what have they done. 403 here costs the agent nothing.
  app.use(kyaGate())

  // 2. x402: 402 with requirements when there is no payment; verify, then
  //    settle once the handler has answered 2xx.
  app.use(
    paymentMiddleware(
      receiver,
      {
        'GET /chem': {
          price: PRICE,
          network: NETWORK,
          config: {
            description: 'Chemistry model inference (demo)',
            mimeType: 'application/json',
          },
        },
      },
      { url: facilitatorUrl as `${string}://${string}` },
    ),
  )

  // 3. The resource. Only reached by a payer the gate let through, with a
  //    payment x402-express verified.
  app.get('/chem', (req: Request, res: Response) => {
    const question = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : 'hello'
    const kya = res.locals.kya as GateResult | undefined
    res.json({
      answer: answer(question),
      served_to: kya?.payer ?? null,
      kya_verdict: kya?.verification.verdict.verdict ?? null,
      kya_score: kya?.verification.verdict.score ?? null,
    })
  })

  app.listen(listenPort, () => {
    console.log(`KYA demo · paid endpoint  GET http://localhost:${listenPort}/chem?q=...`)
    console.log(`  price        ${PRICE} USDC on ${NETWORK}   pay to ${receiver}`)
    console.log(`  settlement   ${REAL ? `REAL via ${REAL_FACILITATOR}` : 'SIMULATED (stub facilitator, no funds move; run with --real for x402.org)'}`)
    console.log(`  reputation   Base mainnet, chain ${chainId()}, via KYA gate before payment`)
    console.log('')
    console.log('  waiting for agents...')
    console.log('')
  })
}

main()
