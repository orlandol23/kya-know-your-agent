/**
 * kyaGate: Express middleware that decides who may pay, BEFORE anything is paid.
 *
 *   app.use(kyaGate())                       // 1. who is the payer, what is their track record
 *   app.use(paymentMiddleware(payTo, ...))   // 2. verify + settle the payment (x402-express)
 *   app.get('/resource', handler)            // 3. serve
 *
 * The order is the whole point. x402-express only settles after the handler
 * responds with a 2xx, and it never runs at all if this middleware answers
 * first. So a 403 from the gate means the rejected agent paid nothing and the
 * seller risked nothing.
 *
 * What it reads: the x402 v1 `X-PAYMENT` header, base64 JSON, payer address at
 * `payload.authorization.from`. It does not check the signature over that
 * address; the payment middleware downstream does, and a forged `from` fails
 * there and never settles. So the gate can take `from` at face value: the only
 * address that can be charged is the one that signed.
 *
 * Decision, from src/verify.ts, the same pipeline as GET /verify:
 *
 *   suspicious (incl. gated)  -> 403, reason and signed attestation in the body
 *   unknown                   -> next(), header X-KYA-Verdict: unknown
 *   trusted                   -> next(), header X-KYA-Verdict: trusted
 *
 * Only `suspicious` blocks. `unknown` is "some history, not enough to vouch
 * for": passing it is the default because blocking it is the seller's policy,
 * not KYA's, and the header lets a handler apply that policy.
 *
 * Requests without a payment header pass through untouched: there is no payer
 * to check yet, and the payment middleware answers them with 402 + the payment
 * requirements, which is how an x402 client learns what to pay. Requests whose
 * header carries no decodable payer also pass through, and the payment
 * middleware rejects them as malformed. The gate never invents a verdict for a
 * payer it cannot name.
 *
 * If reputation cannot be read (Blockscout down), the gate fails CLOSED with
 * 503: an agent that cannot be checked is not served, and still pays nothing.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { getAddress, isAddress, type Address } from 'viem'

import { BlockscoutError } from './blockscout.js'
import { verify, type Verification } from './verify.js'

export const PAYMENT_HEADER = 'X-PAYMENT'
export const VERDICT_HEADER = 'X-KYA-Verdict'

export type GateOptions = {
  /** address -> verification. Defaults to verify() from src/verify.ts. */
  verify?: (address: Address) => Promise<Verification>
  /** One line per decision. Defaults to console.log; pass () => {} to silence. */
  log?: (line: string) => void
}

/**
 * The payer address inside an x402 v1 X-PAYMENT header, checksummed, or null
 * when the header is not base64 JSON with an EVM address at
 * payload.authorization.from. Pure; never throws.
 */
export function payerFromPaymentHeader(header: string): Address | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (decoded === null || typeof decoded !== 'object') return null
  const payload = (decoded as { payload?: unknown }).payload
  if (payload === null || typeof payload !== 'object') return null
  const authorization = (payload as { authorization?: unknown }).authorization
  if (authorization === null || typeof authorization !== 'object') return null
  const from = (authorization as { from?: unknown }).from
  if (typeof from !== 'string' || !isAddress(from, { strict: false })) return null
  return getAddress(from)
}

/** What the gate stores in res.locals.kya for the handler behind it. */
export type GateResult = {
  payer: Address
  verification: Verification
}

function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function kyaGate(options: GateOptions = {}): RequestHandler {
  const check = options.verify ?? verify
  const log = options.log ?? console.log

  async function gate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.header(PAYMENT_HEADER)
    if (header === undefined) {
      next()
      return
    }

    const payer = payerFromPaymentHeader(header)
    if (payer === null) {
      next()
      return
    }

    let verification: Verification
    try {
      verification = await check(payer)
    } catch (error) {
      const upstream = error instanceof BlockscoutError
      const detail = error instanceof Error ? error.message : String(error)
      log(`[kya] ${short(payer)}  ${upstream ? '503' : '500'}  cannot verify: ${detail}`)
      res.status(upstream ? 503 : 500).json({
        error: upstream
          ? 'KYA gate: reputation source unavailable, payment refused before settlement'
          : 'KYA gate: internal error, payment refused before settlement',
        payer,
        ...(upstream ? { detail } : {}),
      })
      return
    }

    const { verdict, attestation } = verification
    res.setHeader(VERDICT_HEADER, verdict.verdict)
    res.locals.kya = { payer, verification } satisfies GateResult

    if (verdict.verdict === 'suspicious') {
      log(
        `[kya] ${short(payer)}  403  ${verdict.gated ? 'GATED' : 'SUSPICIOUS'} score ${verdict.score}` +
          `  ${verdict.summary}`,
      )
      res.status(403).json({
        error: 'KYA gate: payer refused before settlement',
        verdict: verdict.verdict,
        gated: verdict.gated,
        score: verdict.score,
        reason: verdict.summary,
        reasons: verdict.reasons,
        payer,
        evidence: attestation.evidence.blockscout_url,
        attestation,
      })
      return
    }

    log(`[kya] ${short(payer)}  pass  ${verdict.verdict.toUpperCase()} score ${verdict.score}`)
    next()
  }

  return (req, res, next) => {
    void gate(req, res, next)
  }
}
