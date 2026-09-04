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
 * from a missing fixture (404) from too many requests from one IP or a spent
 * budget (429, `reason: rate` or `reason: budget`) from Blockscout being
 * unavailable (502) from a bug here (500). Only 200 carries an attestation.
 */

import { fileURLToPath } from 'node:url'

import express, { type Request, type Response } from 'express'
import { rateLimit, type RateLimitInfo } from 'express-rate-limit'

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

/*
 * ── The per-IP limit on /verify ──────────────────────────────────────────────
 *
 * The budget above is honest about what it is: "a budget, not a fence"
 * (comment above). It counts live verifies process-wide, so it stops the
 * SERVICE from overspending, but it does nothing to stop one caller from
 * being the spender: varying the address, a single caller can still exhaust
 * the whole day's budget for every other caller in about twenty minutes,
 * because the budget has no notion of "caller" at all, only a running total.
 *
 * This is the fence the budget is not: a request count per SOURCE IP, over a
 * one-minute window, so no single caller can consume more than its own slice
 * of the day no matter how many distinct addresses it asks about. It answers
 * a different question than the budget (who is asking, not how much has been
 * spent today) and neither makes the other redundant.
 *
 * KYA_VERIFY_RATE_LIMIT_PER_MIN (default 30) is read from the environment on
 * every check, same parsing pattern and same reason as dailyVerifyBudget():
 * retunable from a hosting dashboard without a redeploy. 0 is a valid
 * setting and means "no per-IP limit", the same convention as
 * KYA_DAILY_VERIFY_BUDGET=0 meaning "no live reads at all".
 *
 * It runs BEFORE the budget check in handleVerify, so a request this turns
 * away with 429 never reaches, and never charges, the daily budget: being
 * over-eager here has no cost to the budget a well-behaved caller relies on.
 *
 * Only /verify is limited; the static UI at `/` is not. And like the budget,
 * this guards the public HTTP surface only — src/gate.ts runs inside a
 * seller's own process against their own key and is deliberately left alone.
 */
const DEFAULT_VERIFY_RATE_LIMIT_PER_MIN = 30

function verifyRateLimitPerMin(): number {
  const value = Number(process.env.KYA_VERIFY_RATE_LIMIT_PER_MIN)
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_VERIFY_RATE_LIMIT_PER_MIN
}

/** How long a client should wait for its per-IP window to reopen. */
function secondsUntilRateLimitReset(resetTime: Date | undefined): number {
  if (resetTime === undefined) return 60
  return Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000))
}

/**
 * A fresh limiter with its own in-memory counters, one per `createApp()`
 * call, so two servers in the same process (as in the tests) never share a
 * bucket. `limit` and `skip` re-read the environment per request rather than
 * capturing it at creation, for the same retune-without-redeploy reason as
 * `dailyVerifyBudget()`.
 */
function verifyRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: () => verifyRateLimitPerMin(),
    skip: () => verifyRateLimitPerMin() === 0,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Same error shape as the rest of this file: a message, a machine-
    // readable `reason`, and how long until the caller can try again.
    handler: (req: Request, res: Response) => {
      const info = (req as Request & { rateLimit?: RateLimitInfo }).rateLimit
      res.setHeader('cache-control', 'no-store')
      res.status(429).json({
        error: 'too many verifications from this address in the last minute',
        reason: 'rate',
        retry_after_seconds: secondsUntilRateLimitReset(info?.resetTime),
      })
    },
  })
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

/**
 * Builds the app without listening, so tests can drive it on an ephemeral
 * port and exercise the real middleware chain (rate limiter included)
 * instead of calling handleVerify() directly.
 */
export function createApp(): express.Express {
  const app = express()
  app.disable('x-powered-by')

  // The server runs behind Railway's own proxy, so the client's real IP
  // arrives as the first hop in X-Forwarded-For, not as the TCP peer
  // address. Trusting exactly ONE hop tells Express to read that first
  // entry as req.ip: enough to key the limiter below on the actual caller,
  // and no more, so a caller cannot forge extra X-Forwarded-For entries to
  // pick whatever IP it wants counted instead of its own. Without this,
  // every request looks like it came from Railway's proxy, the limiter puts
  // every caller in one shared bucket, and the first 30 requests a minute
  // from ANYONE lock out everyone else.
  app.set('trust proxy', 1)

  app.get('/verify', verifyRateLimiter(), (req, res) => {
    void handleVerify(req, res)
  })
  // The demo UI: one static file, no build. `/` is index.html. Not rate
  // limited: it is not the metered resource /verify is.
  app.use(express.static(UI_DIR, { index: 'index.html', cacheControl: false, etag: false }))

  return app
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

  const app = createApp()
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
    const perMin = verifyRateLimitPerMin()
    console.log(
      perMin === 0
        ? '  rate      no per-IP limit (KYA_VERIFY_RATE_LIMIT_PER_MIN=0)'
        : `  rate      ${perMin} /verify per IP per minute (KYA_VERIFY_RATE_LIMIT_PER_MIN)`,
    )
    console.log(`  attester  ${attesterAccount().address}   (pin this address to verify signatures)`)
  })
}

// Only listen when this file is run directly (`npx tsx src/server.ts`), not
// when a test imports createApp() to drive the app on its own port.
const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url)
if (isEntryPoint) main()
