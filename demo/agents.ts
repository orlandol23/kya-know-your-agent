/**
 * npx tsx demo/agents.ts [--real] [--offline]
 *
 * The buyer side of the demo: two agents, one paid endpoint, same request.
 *
 *   established   0xeA258496…9F04   657 days, 49k tx, exchange-funded    -> expects 200
 *   fresh         generated now, zero history by construction           -> expects 403
 *
 * The 403 arrives BEFORE settlement: the fresh agent signs a payment, the gate
 * refuses it, and no USDC moves. The reason is in the response body.
 *
 * How each agent pays. An agent WITH a private key is a real x402-fetch client:
 * it gets the 402, signs the EIP-3009 authorization and retries with the
 * X-PAYMENT header. Signing is offline, so a wallet with zero funds can do it,
 * which is exactly what a fresh wallet is. An agent WITHOUT a key sends a
 * synthetic X-PAYMENT header: same wire format, real address, placeholder
 * signature. Only the simulated facilitator accepts that; it exists because
 * the established address is a third party's and its key is not ours.
 *
 * So by default: fresh = real x402-fetch client, established = synthetic
 * header, endpoint in simulated-settlement mode. Either way the gate reads the
 * same header field and runs the same code.
 *
 * --real   both agents must be real clients and the endpoint must run --real.
 *          DEMO_ESTABLISHED_PRIVATE_KEY: a wallet with Base mainnet history
 *          (score above 84) holding USDC on Base Sepolia. Without it, only the
 *          fresh agent runs.
 *
 * --offline  pairs with `paid-endpoint.ts --offline`: the gate replays committed
 *            fixtures, so the fresh agent must be an address that HAS one. It
 *            becomes 0xeB94Dd…6B97 (generated on D2, key discarded, zero
 *            transactions by construction), sent as a synthetic header.
 *
 * Env: DEMO_URL (http://localhost:4021/chem), DEMO_ESTABLISHED_PRIVATE_KEY,
 * DEMO_FRESH_PRIVATE_KEY (generated when absent).
 */

import { randomBytes } from 'node:crypto'

import type { Address, Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createSigner, decodeXPaymentResponse, wrapFetchWithPayment } from 'x402-fetch'

import { loadDotEnv } from '../src/config.js'
import { PAYMENT_HEADER, VERDICT_HEADER } from '../src/gate.js'

loadDotEnv()

const REAL = process.argv.includes('--real')
const OFFLINE = process.argv.includes('--offline')
const NETWORK = 'base-sepolia'

/**
 * From the calibration set: funded by Binance 76, sustained use since 2024.
 * Same funder as the fresh demo address, which is the point of the pairing.
 */
const ESTABLISHED_ADDRESS: Address = '0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04'
/** From the calibration set: generated locally, key discarded, zero history. Has a fixture. */
const FRESH_FIXTURE_ADDRESS: Address = '0xeB94Dd34439e017EBa695678265e44Ea12E16B97'

type Agent = {
  name: string
  address: Address
  /** Present -> real x402-fetch client. Absent -> synthetic header. */
  key: Hex | undefined
  expect: 200 | 403
}

type Outcome = {
  status: number
  verdict: string | null
  reason: string | null
  settlement: string | null
  body: unknown
}

function endpointUrl(): string {
  const base = process.env.DEMO_URL?.trim() || `http://localhost:${process.env.DEMO_PORT?.trim() || 4021}/chem`
  const url = new URL(base)
  url.searchParams.set('q', 'synthesis route for compound X')
  return url.toString()
}

function keyFromEnv(name: string): Hex | undefined {
  const value = process.env[name]?.trim()
  return value ? (value as Hex) : undefined
}

function agents(): Agent[] {
  const establishedKey = keyFromEnv('DEMO_ESTABLISHED_PRIVATE_KEY')
  const freshKey = keyFromEnv('DEMO_FRESH_PRIVATE_KEY') ?? generatePrivateKey()

  const list: Agent[] = []
  if (establishedKey !== undefined) {
    list.push({ name: 'established', address: privateKeyToAccount(establishedKey).address, key: establishedKey, expect: 200 })
  } else if (!REAL) {
    list.push({ name: 'established', address: ESTABLISHED_ADDRESS, key: undefined, expect: 200 })
  } else {
    console.log('  established  skipped: --real needs DEMO_ESTABLISHED_PRIVATE_KEY (a wallet with history, holding Sepolia USDC)')
  }
  if (OFFLINE) {
    list.push({ name: 'fresh', address: FRESH_FIXTURE_ADDRESS, key: undefined, expect: 403 })
  } else {
    list.push({ name: 'fresh', address: privateKeyToAccount(freshKey).address, key: freshKey, expect: 403 })
  }
  return list
}

/** Log every hop, so the 402 -> pay -> retry sequence is visible on screen. */
function loggingFetch(indent: string): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init)
    const paying = init?.headers !== undefined && PAYMENT_HEADER in (init.headers as Record<string, string>)
    if (response.status === 402 && !paying) {
      const body = (await response.clone().json()) as { accepts?: Array<{ maxAmountRequired: string; network: string }> }
      const req = body.accepts?.[0]
      const price = req ? `${Number(req.maxAmountRequired) / 1e6} USDC on ${req.network}` : 'unknown price'
      console.log(`${indent}402  payment required: ${price}`)
      console.log(`${indent}     signing payment, retrying with X-PAYMENT...`)
    }
    return response
  }
}

/**
 * The synthetic client: what x402-fetch does, minus the signature. Same
 * header name, same base64 JSON, same `payload.authorization.from`.
 */
async function syntheticFetchWithPayment(url: string, from: Address, indent: string): Promise<Response> {
  const first = await fetch(url)
  if (first.status !== 402) return first
  const { accepts } = (await first.json()) as {
    accepts: Array<{ scheme: string; network: string; maxAmountRequired: string; payTo: string; maxTimeoutSeconds: number }>
  }
  const req = accepts.find((a) => a.scheme === 'exact')
  if (req === undefined) throw new Error('no exact-scheme payment requirement offered')
  console.log(`${indent}402  payment required: ${Number(req.maxAmountRequired) / 1e6} USDC on ${req.network}`)
  console.log(`${indent}     building synthetic X-PAYMENT (address only, no key), retrying...`)

  const now = Math.floor(Date.now() / 1000)
  const payload = {
    x402Version: 1,
    scheme: 'exact',
    network: req.network,
    payload: {
      signature: `0x${'00'.repeat(65)}`,
      authorization: {
        from,
        to: req.payTo,
        value: req.maxAmountRequired,
        validAfter: String(now - 600),
        validBefore: String(now + req.maxTimeoutSeconds),
        nonce: `0x${randomBytes(32).toString('hex')}`,
      },
    },
  }
  const header = Buffer.from(JSON.stringify(payload)).toString('base64')
  return fetch(url, { headers: { [PAYMENT_HEADER]: header } })
}

async function run(agent: Agent, url: string): Promise<Outcome> {
  const indent = '    '
  let response: Response
  if (agent.key !== undefined) {
    const signer = await createSigner(NETWORK, agent.key)
    const fetchWithPayment = wrapFetchWithPayment(loggingFetch(indent), signer)
    response = await fetchWithPayment(url)
  } else {
    response = await syntheticFetchWithPayment(url, agent.address, indent)
  }

  const text = await response.text()
  let body: unknown = text
  try {
    body = JSON.parse(text)
  } catch {
    // not JSON, keep the text
  }
  const record = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {}

  const settleHeader = response.headers.get('X-PAYMENT-RESPONSE')
  let settlement: string | null = null
  if (settleHeader !== null) {
    const settled = decodeXPaymentResponse(settleHeader) as { success: boolean; transaction?: string; simulated?: boolean }
    settlement = settled.simulated
      ? 'SIMULATED (no funds moved)'
      : settled.success
        ? `tx ${settled.transaction ?? '?'}`
        : 'settlement failed'
  }

  return {
    status: response.status,
    verdict: response.headers.get(VERDICT_HEADER),
    reason: typeof record.reason === 'string' ? record.reason : typeof record.error === 'string' ? record.error : null,
    settlement,
    body,
  }
}

function report(agent: Agent, outcome: Outcome): boolean {
  const indent = '    '
  const ok = outcome.status === agent.expect
  const record = outcome.body !== null && typeof outcome.body === 'object' ? (outcome.body as Record<string, unknown>) : {}

  if (outcome.status === 200) {
    console.log(`${indent}200  OK · served${outcome.verdict ? `   X-KYA-Verdict: ${outcome.verdict}` : ''}${outcome.settlement ? `   settlement: ${outcome.settlement}` : ''}`)
    if (typeof record.answer === 'string') console.log(`${indent}     ${record.answer}`)
  } else if (outcome.status === 403) {
    console.log(`${indent}403  REFUSED before settlement · paid nothing   X-KYA-Verdict: ${outcome.verdict ?? '?'}`)
    console.log(`${indent}     reason: ${outcome.reason ?? '(none given)'}`)
    if (record.gated === true) console.log(`${indent}     compliance gate: not scored, blocked`)
    if (typeof record.evidence === 'string') console.log(`${indent}     evidence: ${record.evidence}`)
  } else {
    console.log(`${indent}${outcome.status}  ${outcome.reason ?? JSON.stringify(outcome.body).slice(0, 200)}`)
  }
  console.log(`${indent}${ok ? '✔' : '✘'} expected ${agent.expect}`)
  console.log('')
  return ok
}

async function main(): Promise<void> {
  const url = endpointUrl()
  console.log('')
  console.log(`KYA demo · two agents, one paid endpoint   (${REAL ? 'REAL settlement' : 'simulated settlement'}${OFFLINE ? ', offline fixtures' : ''})`)
  console.log(`  endpoint  ${url}`)
  console.log('')

  const list = agents()
  let allOk = true
  for (const agent of list) {
    const how = agent.key !== undefined ? 'x402-fetch client' : 'synthetic header, no key'
    const origin = agent.name === 'fresh'
      ? OFFLINE ? 'fixture: generated on D2, zero history' : 'generated now, zero history'
      : 'calibration set, 648 days, exchange-funded'
    console.log(`  ${agent.name.padEnd(12)} ${agent.address}   ${origin}   [${how}]`)
    try {
      const outcome = await run(agent, url)
      allOk = report(agent, outcome) && allOk
    } catch (error) {
      console.log(`    ✘ ${error instanceof Error ? error.message : String(error)}`)
      console.log('')
      allOk = false
    }
  }

  const ranBoth = list.length === 2
  console.log(
    !allOk
      ? '  outcome differs from expected, see above'
      : ranBoth
        ? '  fresh wallet blocked, established wallet served. Nothing was paid for the refusal.'
        : '  fresh wallet blocked, nothing paid. Set DEMO_ESTABLISHED_PRIVATE_KEY to run the established agent for real.',
  )
  process.exitCode = allOk ? 0 : 1
}

await main()
