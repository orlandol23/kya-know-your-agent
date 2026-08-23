/**
 * npx tsx src/server.ts [--offline]
 *
 *   GET /verify?address=0x...             -> signed attestation (see attest.ts for the shape)
 *   GET /verify?address=0x...&explain=1   -> { attestation, breakdown, source, captured_at }:
 *                                            the same signed attestation plus the UNSIGNED
 *                                            score arithmetic (axes, weights, penalty,
 *                                            confidence, cutoffs) so a screen can draw why
 *                                            the score is what it is
 *   GET /verify?address=0x...&offline=1   -> replay the committed fixture for this one request
 *   GET /                                 -> ui/index.html, the split-screen demo
 *
 * Every response carries X-KYA-Source: live | cache | fixture.
 *
 * Stateless: every request reads Blockscout (or a fixture) and signs a fresh,
 * point-in-time attestation. Consumers decide their own freshness policy from
 * `issued_at`; `evidence.fetched_at` says when the chain was actually read.
 *
 * DEGRADATION. A public deployment reads a metered API, so a live read that
 * cannot be served (because Blockscout is unavailable, or because the day's
 * budget of live verifies is spent) falls back to a committed fixture instead
 * of failing. The fallback is never silent: X-KYA-Source says `fixture` (or
 * `cache`) and X-KYA-Degraded says which of the two reasons applied. With no
 * fixture for that address the budget case answers 429 (with Retry-After until
 * the UTC day rolls over) and the upstream case keeps answering 502.
 *
 * --offline (or KYA_OFFLINE=1) makes every request replay data/fixtures/ and
 * never touches the network; no Blockscout key needed. Started live, a request
 * can still ask for ?offline=1, which is how the UI flips to fixtures without a
 * restart if Blockscout dies mid-demo.
 *
 * Status codes say what went wrong, so a caller can tell a bad address (400)
 * from a missing fixture (404) from a spent budget (429) from Blockscout being
 * unavailable (502) from a bug here (500). Only 200 carries an attestation.
 */

import { fileURLToPath } from 'node:url'

import express, { type Request, type Response } from 'express'

import { attesterAccount } from './attest.js'
import { BlockscoutError, chainId } from './blockscout.js'
import { ConfigError, SCORE, VERDICT, loadDotEnv } from './config.js'
import { NoFixtureError, isOffline, listFixtures, setOffline } from './history.js'
import type { ScoreBreakdown } from './score.js'
import { InvalidAddressError, requireVerifyConfig, verify, type Verification } from './verify.js'

loadDotEnv()
if (process.argv.includes('--offline')) setOffline(true)

const DEFAULT_PORT = 3000

function port(): number {
  const value = Number(process.env.PORT)
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PORT
}

const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))

/** Set on a reply that was served from a replay because a live read could not be. */
export const DEGRADED_HEADER = 'X-KYA-Degraded'

/** Why a reply was degraded. `budget` is self-inflicted, `upstream` is not. */
type DegradedReason = 'budget' | 'upstream'

/*
 * ── The daily budget for LIVE verifies ──────────────────────────────────────
 *
 * A public deployment reads a metered API. The Blockscout Free tier is 100,000
 * credits a day at 20 per call, and one verify costs 6 calls (7 when /counters
 * is cold): roughly 700 live verifies a day. Nothing upstream of this file
 * limits who asks, and the 10-minute cache only makes REPEATS free, so one
 * caller varying the address can spend the whole day's credits in about twenty
 * minutes and leave the service answering 502 until the quota renews.
 *
 * So the verifies that actually reach Blockscout are counted, and past the cap
 * the server stops calling it and replays the committed fixtures instead. The
 * cap is read from the environment on every check, so it can be retuned from a
 * hosting dashboard without a redeploy. KYA_DAILY_VERIFY_BUDGET=0 is a valid
 * setting: it means "never call Blockscout", fixtures only.
 *
 * Three honest limits:
 *   - A cache hit costs no credits, so it is not charged. Only `source: live`
 *     is.
 *   - Concurrent requests can both pass the check before either charges, so
 *     this is a budget, not a fence. The overshoot is bounded by how many
 *     requests are in flight, and the tier has room for it at the default.
 *   - In-process and per-instance: two instances have two budgets. That is the
 *     price of keeping the service otherwise stateless, and it is the right
 *     trade at this size.
 *
 * This guards the public HTTP surface only. src/gate.ts runs inside a seller's
 * own process, against their own key, and is deliberately left alone.
 */
const DEFAULT_DAILY_VERIFY_BUDGET = 500

function dailyVerifyBudget(): number {
  const value = Number(process.env.KYA_DAILY_VERIFY_BUDGET)
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_DAILY_VERIFY_BUDGET
}

/** The UTC day, as YYYY-MM-DD. The counter resets when this changes. */
function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

let budgetDay = utcDay()
let liveVerifiesToday = 0

function rolloverBudget(): void {
  const today = utcDay()
  if (today !== budgetDay) {
    budgetDay = today
    liveVerifiesToday = 0
  }
}

function liveBudgetRemaining(): number {
  rolloverBudget()
  return Math.max(0, dailyVerifyBudget() - liveVerifiesToday)
}

function chargeLiveBudget(): void {
  rolloverBudget()
  liveVerifiesToday += 1
  // Exactly-equals, so this says it once a day instead of once a request.
  if (liveVerifiesToday === dailyVerifyBudget()) {
    console.warn(
      `[kya] daily live-verify budget spent (${dailyVerifyBudget()} on ${budgetDay} UTC): ` +
        'replaying committed fixtures until the day rolls over',
    )
  }
}

/** How long a client should wait for the budget to renew. */
function secondsUntilUtcMidnight(): number {
  const now = new Date()
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000))
}

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

/** 200 + the attestation, saying which source answered and whether it was a fallback. */
function sendVerification(
  res: Response,
  verification: Verification,
  wantsExplain: boolean,
  degraded: DegradedReason | null,
): void {
  const { attestation, breakdown, source, capturedAt } = verification
  // Point-in-time by design: nothing in between should cache it.
  res.setHeader('cache-control', 'no-store')
  res.setHeader('X-KYA-Source', source)
  if (degraded !== null) res.setHeader(DEGRADED_HEADER, degraded)
  res
    .status(200)
    .json(
      wantsExplain
        ? { attestation, breakdown: explain(breakdown), source, captured_at: capturedAt }
        : attestation,
    )
}

/**
 * A live read could not be served. Replay a committed capture instead of
 * failing, and say so in the headers.
 *
 * `cause` is what makes the two reasons distinguishable: null means the day's
 * budget is spent, non-null means Blockscout failed and this is the error it
 * failed with.
 *
 * With no capture for the address there is nothing honest to replay, and the
 * two reasons deserve different answers. A spent budget is this service
 * rate-limiting the caller: 429, with how long until it renews. An unreachable
 * Blockscout is an upstream failure, so `cause` is rethrown and the caller's
 * handler answers 502 with the message that actually explains it: telling
 * someone who made one request that they made too many, or that a fixture is
 * missing when the real problem is upstream, would both be lies.
 */
async function degradeToReplay(
  res: Response,
  input: unknown,
  wantsExplain: boolean,
  cause: BlockscoutError | null,
): Promise<void> {
  const reason: DegradedReason = cause === null ? 'budget' : 'upstream'
  if (cause !== null) {
    console.warn(`[verify] ${String(input)}: ${cause.message}, replaying a committed capture`)
  }

  try {
    sendVerification(res, await verify(input, { offline: true }), wantsExplain, reason)
  } catch (error) {
    if (!(error instanceof NoFixtureError)) throw error
    // Nothing to replay. Report what actually went wrong, not the replay miss.
    if (cause !== null) throw cause
    res.setHeader('cache-control', 'no-store')
    res.setHeader('retry-after', String(secondsUntilUtcMidnight()))
    res.status(429).json({
      error:
        'daily budget of live verifications is spent, and no committed fixture exists for ' +
        'this address. It renews at 00:00 UTC.',
      reason,
      fixtures: error.available,
    })
  }
}

async function handleVerify(req: Request, res: Response): Promise<void> {
  const input = req.query.address
  const wantsExplain = req.query.explain === '1'
  // Server-wide --offline wins; otherwise the request may opt in.
  const offline = isOffline() || req.query.offline === '1'

  try {
    // Asked for a replay: no budget involved, and no fallback to fall back to.
    if (offline) {
      sendVerification(res, await verify(input, { offline: true }), wantsExplain, null)
      return
    }

    // Out of budget: stop before touching the network, not after.
    if (liveBudgetRemaining() === 0) {
      await degradeToReplay(res, input, wantsExplain, null)
      return
    }

    let verification: Verification
    try {
      verification = await verify(input, { offline: false })
    } catch (error) {
      // The read reached Blockscout and failed there: charge it, then replay.
      if (!(error instanceof BlockscoutError)) throw error
      chargeLiveBudget()
      await degradeToReplay(res, input, wantsExplain, error)
      return
    }

    // A cache hit spent no credits, so it is not charged.
    if (verification.source === 'live') chargeLiveBudget()
    sendVerification(res, verification, wantsExplain, null)
  } catch (error) {
    if (error instanceof InvalidAddressError) {
      res.status(400).json({ error: error.message, usage: '/verify?address=0x...' })
      return
    }
    if (error instanceof NoFixtureError) {
      res.status(404).json({ error: error.message, offline: true, fixtures: error.available })
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
    console.log(
      isOffline()
        ? `  mode      OFFLINE: replaying ${listFixtures().length} fixture(s) from data/fixtures/, no network`
        : `  mode      live (Blockscout Pro), 10-minute cache in data/cache/; ?offline=1 replays data/fixtures/`,
    )
    if (!isOffline()) {
      console.log(
        `  budget    ${dailyVerifyBudget()} live verifies/day (KYA_DAILY_VERIFY_BUDGET), ` +
          `then ${listFixtures().length} committed fixture(s)`,
      )
    }
    if (isOffline()) for (const address of listFixtures()) console.log(`              ${address}`)
    console.log(`  attester  ${attesterAccount().address}   (pin this address to verify signatures)`)
  })
}

main()
