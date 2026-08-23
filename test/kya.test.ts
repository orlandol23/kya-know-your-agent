/**
 * npm test   ->   tsx --test
 *
 * The five things that would be silently wrong for a long time if they broke.
 * Everything runs OFFLINE against the committed fixtures: no Blockscout key, no
 * network, no .env. The attester key below is a fixed throwaway so a signature
 * assertion means the same thing on every machine.
 *
 * Run from the repository root: data/fixtures/ is resolved against the cwd.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import express, { type NextFunction, type Request, type Response } from 'express'
import { recoverMessageAddress, type Address } from 'viem'

import { canonicalize, recoverAttester } from '../src/attest.js'
import { PAYMENT_HEADER, VERDICT_HEADER, kyaGate, payerFromPaymentHeader } from '../src/gate.js'
import { verdictFor } from '../src/verdict.js'
import { verify, type Verification } from '../src/verify.js'

// Set before any verify() runs: attesterAccount() reads the env at call time.
process.env.ATTESTER_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

const ESTABLISHED = '0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04'
const FRESH = '0xBEabA203Ef49Ee2828b77b0B7E84839e76092787'
const ZERO_TX = '0xeB94Dd34439e017EBa695678265e44Ea12E16B97'
const SANCTIONED = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96'

const offline = (address: string): Promise<Verification> => verify(address, { offline: true })

/* ── 1 ─────────────────────────────────────────────────────────────────────
 * The attestation is only worth something if a third party can check it
 * without calling us, and the README promises that takes three lines because
 * the API already serves the body in canonical order.
 */
test('canonicalize and recover round-trip, and the API serves canonical order', async () => {
  const { attestation } = await offline(ESTABLISHED)
  const { signature, ...body } = attestation

  // The three lines from the README, verbatim.
  const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
  assert.equal(signer, attestation.attester)
  assert.equal(await recoverAttester(attestation), attestation.attester)

  // JSON.stringify is enough only because the SERVED order is already canonical.
  assert.equal(JSON.stringify(body), canonicalize(body))

  // Canonical means sorted, recursively, with signature last on the wire.
  const keys = Object.keys(body)
  assert.deepEqual(keys, [...keys].sort())
  assert.equal(Object.keys(attestation).at(-1), 'signature')
  const signals = Object.keys(body.signals)
  assert.deepEqual(signals, [...signals].sort())

  // And the signature actually binds the content: change one number, lose the signer.
  const tampered = JSON.stringify({ ...body, score: body.score + 1 })
  const otherSigner = await recoverMessageAddress({ message: tampered, signature })
  assert.notEqual(otherSigner, attestation.attester)
})

/* ── 2 ─────────────────────────────────────────────────────────────────────
 * The four numbers on the slides. If a weight or a threshold moves, this is
 * what says so before a judge does.
 */
test('the four committed fixtures score 857, 60, 0 and 0', async () => {
  const cases = [
    { address: ESTABLISHED, score: 857, verdict: 'trusted', gated: false },
    { address: FRESH, score: 60, verdict: 'suspicious', gated: false },
    { address: ZERO_TX, score: 0, verdict: 'suspicious', gated: false },
    { address: SANCTIONED, score: 0, verdict: 'suspicious', gated: true },
  ] as const

  for (const expected of cases) {
    const { verdict, source, attestation } = await offline(expected.address)
    // Guards the whole test: a fixture, not a cache entry and not a live read.
    assert.equal(source, 'fixture', `${expected.address} was served from ${source}`)
    assert.equal(verdict.score, expected.score, `score for ${expected.address}`)
    assert.equal(verdict.verdict, expected.verdict, `verdict for ${expected.address}`)
    assert.equal(verdict.gated, expected.gated, `gated for ${expected.address}`)
    // The signed copy must agree with the verdict object it was built from.
    assert.equal(attestation.score, expected.score)
    assert.equal(attestation.verdict, expected.verdict)
  }

  // Same score, different reason: one has no history, one is not allowed.
  const [zero, sanctioned] = await Promise.all([offline(ZERO_TX), offline(SANCTIONED)])
  assert.equal(zero.verdict.score, sanctioned.verdict.score)
  assert.notEqual(zero.verdict.gated, sanctioned.verdict.gated)
})

/* ── 3 ─────────────────────────────────────────────────────────────────────
 * The cutoffs are measured, so the boundary is the whole claim: 84 is the
 * highest a fresh address reached, 193 the lowest an established one did.
 */
test('verdictFor is exact at 84, 85, 192 and 193', () => {
  assert.equal(verdictFor(84), 'suspicious')
  assert.equal(verdictFor(85), 'unknown')
  assert.equal(verdictFor(192), 'unknown')
  assert.equal(verdictFor(193), 'trusted')
})

/* ── 4 ─────────────────────────────────────────────────────────────────────
 * This parses attacker-supplied bytes. It must return null, never throw, and
 * never invent a payer.
 */
test('payerFromPaymentHeader returns null on every degenerate input', () => {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64')
  const lower = '0xea258496a9311ffe29cdf920ca0e8bb4b41c9f04'

  // The one good case, and it comes back checksummed.
  assert.equal(payerFromPaymentHeader(b64({ payload: { authorization: { from: lower } } })), ESTABLISHED)

  const degenerate: [string, string][] = [
    ['empty string', ''],
    ['not base64 at all', '!!!!not-base64!!!!'],
    ['base64 of non-JSON', Buffer.from('nonsense').toString('base64')],
    ['JSON null', b64(null)],
    ['JSON string', b64('hello')],
    ['JSON number', b64(1)],
    ['JSON array', b64([1, 2, 3])],
    ['no payload', b64({})],
    ['payload null', b64({ payload: null })],
    ['payload is a string', b64({ payload: 'x' })],
    ['no authorization', b64({ payload: {} })],
    ['authorization null', b64({ payload: { authorization: null } })],
    ['authorization is an array', b64({ payload: { authorization: [] } })],
    ['no from', b64({ payload: { authorization: {} } })],
    ['from is a number', b64({ payload: { authorization: { from: 42 } } })],
    ['from is an object', b64({ payload: { authorization: { from: {} } } })],
    ['from is not hex', b64({ payload: { authorization: { from: 'not-an-address' } } })],
    ['from is too short', b64({ payload: { authorization: { from: `0x${'1'.repeat(39)}` } } })],
    ['from is too long', b64({ payload: { authorization: { from: `0x${'1'.repeat(41)}` } } })],
  ]

  for (const [name, header] of degenerate) {
    assert.equal(payerFromPaymentHeader(header), null, `expected null for ${name}`)
  }
})

/* ── 5 ─────────────────────────────────────────────────────────────────────
 * The product claim: a 403 from the gate lands BEFORE the payment middleware,
 * so a refused agent pays nothing. Proven with a counter standing in for
 * x402-express, and with a passing verdict as the control: a counter that
 * stays at zero because nothing downstream ever runs would prove nothing.
 */
test('a 403 from the gate leaves the payment middleware at zero calls', async () => {
  const suspicious = await offline(FRESH)
  const trusted = await offline(ESTABLISHED)
  assert.equal(suspicious.verdict.verdict, 'suspicious')
  assert.equal(trusted.verdict.verdict, 'trusted')

  let downstreamCalls = 0
  let current: Verification = suspicious

  const app = express()
  app.use(kyaGate({ verify: async (_address: Address) => current, log: () => {} }))
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    downstreamCalls += 1 // stands in for paymentMiddleware: verify, then settle
    next()
  })
  app.get('/chem', (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/chem`
  const paymentHeader = Buffer.from(
    JSON.stringify({ payload: { authorization: { from: FRESH } } }),
  ).toString('base64')

  try {
    // 1. Refused payer: 403, and NOTHING downstream ran.
    const refused = await fetch(url, { headers: { [PAYMENT_HEADER]: paymentHeader } })
    assert.equal(refused.status, 403)
    assert.equal(downstreamCalls, 0, 'payment middleware ran despite a 403')
    assert.equal(refused.headers.get(VERDICT_HEADER), 'suspicious')
    const body = (await refused.json()) as { payer: string; reason: string; attestation: unknown }
    assert.equal(body.payer, FRESH)
    assert.ok(body.attestation, 'the refusal must carry the signed attestation')
    assert.match(body.reason, /no track record/)

    // 2. CONTROL: an accepted payer must reach it, or assertion 1 is vacuous.
    current = trusted
    const served = await fetch(url, { headers: { [PAYMENT_HEADER]: paymentHeader } })
    assert.equal(served.status, 200)
    assert.equal(served.headers.get(VERDICT_HEADER), 'trusted')
    assert.equal(downstreamCalls, 1, 'an accepted payer must reach the payment middleware')

    // 3. No payment header: passes through, so x402 can answer 402 with the price.
    const quoted = await fetch(url)
    assert.equal(quoted.status, 200)
    assert.equal(downstreamCalls, 2)
    assert.equal(quoted.headers.get(VERDICT_HEADER), null, 'no payer means no verdict')
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
