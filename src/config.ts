/**
 * Calibrated thresholds and the shape of the reputation function.
 *
 * Two kinds of number live here and they are NOT the same kind of claim:
 *
 *   MEASURED   ZERO/FULL and the verdict cutoffs. Output of
 *              `npx tsx scripts/calibrate.ts` over the committed
 *              data/signals.csv. Anyone can reproduce them.
 *   CHOSEN     weights, EPS, the confidence constant, the funding levels and
 *              the burst penalty. Design decisions, argued but not measured.
 *              There is no labelled reference set that could measure them.
 *
 * Saying which is which is the whole point of the calibration story.
 */

import { existsSync } from 'node:fs'

import type { FundingClass } from './funding.js'

/** Missing or unusable configuration. Distinct from a failed request. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

/** Entry points call this once. Library modules read process.env and never load. */
export function loadDotEnv(path = '.env'): void {
  if (existsSync(path)) process.loadEnvFile(path)
}

/*
 * ── MEASURED, 2026-08-16, n=30 (fresh 10, mid 10, established 10) ────────────
 * Reproduce with: npx tsx scripts/calibrate.ts
 *
 * age_days                     min       p25       p50       p75       max
 *   fresh                        0      0.06      1.25      3.03      4.79
 *   mid                      12.21     22.24     36.32     49.53   1103.25
 *   established             404.18    532.09    652.52   1084.11   1128.44
 *
 * tx_count                     min       p25       p50       p75       max
 *   fresh                        0      1.25        47     54.75       319
 *   mid                          3     18.75   8848.50     33481    670788
 *   established                 90   2236.25  29752.50 106590.25    630990
 *
 * distinct_counterparties      min       p25       p50       p75       max
 *   fresh                        0      0.25      3.50      5.75         9
 *   mid                          1         1      1.50      2.75         8
 *   established                  1      6.25        36        48        58
 *
 * txs_24h                      min       p25       p50       p75       max
 *   fresh                        0         1        26     30.25       150
 *   mid                          0      0.25         2       150       150
 *   established                  0      7.50       150       150       150
 *
 * txs_7d                       min       p25       p50       p75       max
 *   fresh                        0      1.25        47     54.75       150
 *   mid                          0      2.75     81.50       150       150
 *   established                  0     41.25       150       150       150
 *
 * signal                    ZERO (p75 fresh)   FULL (p25 established)   verdict
 * age_days                              3.03                   532.09   176x, use
 * tx_count                             54.75                  2236.25    41x, use
 * distinct_counterparties               5.75                     6.25   0.09x, drop
 * txs_24h                              30.25                     7.50   inverted, drop
 * txs_7d                               54.75                    41.25   inverted, drop
 *
 * Cadence inverted because fresh bot wallets fire 150 transactions in a day
 * while established addresses go quiet: it measures current activity, not track
 * record. Diversity failed because the established stratum contains old
 * single-counterparty bots. The stratum was NOT recomposed to fix either
 * number, because picking the established set by diversity would guarantee that
 * diversity separates. Both are still collected and shown, at weight zero.
 */

/** norm(x) = clamp((x - zero) / (full - zero), 0, 1) */
export const THRESHOLDS = {
  ageDays: { zero: 3.03, full: 532.09 },
  txCount: { zero: 54.75, full: 2236.25 },
} as const

/**
 * CHOSEN. Weighted by cost to forge: funding names a counterparty and, when
 * that counterparty is custodial, a KYC record behind it; age is forged by
 * waiting; volume is forged cheaply with self-sends.
 */
export const WEIGHTS = {
  funding: 0.4,
  maturity: 0.35,
  volume: 0.25,
} as const

/**
 * CHOSEN. The fallback if funding provenance is ever switched off: the plan's
 * renormalisation of the two remaining axes. Kept here so the alternative is
 * visible instead of hypothetical.
 */
export const WEIGHTS_WITHOUT_FUNDING = {
  maturity: 0.58,
  volume: 0.42,
} as const

/**
 * CHOSEN. What each funding class is worth on the 0..1 funding axis.
 *
 * `unknown` is deliberately not zero: most Base wallets are funded by an
 * address no list knows, and that is absence of evidence, not evidence of bad
 * behaviour. It sits below `exchange` because an exchange withdrawal carries an
 * identity record behind it and an unknown EOA carries nothing.
 *
 * `mixer` and `sanctioned` never reach the geometric mean, the compliance gate
 * takes them first, and are listed at 0 only so the map is total.
 */
export const FUNDING_LEVEL: Readonly<Record<FundingClass, number>> = {
  exchange: 1,
  unknown: 0.35,
  none: 0.05,
  mixer: 0,
  sanctioned: 0,
}

/** CHOSEN. score = SCALE · G · penalty · confidence */
export const SCORE = {
  scale: 1000,
  /** Floor under each axis, so one weak axis dampens instead of annihilating. */
  eps: 0.02,
  /** confidence = evidence_mass / (evidence_mass + k), evidence_mass = window size. */
  confidenceK: 25,
} as const

/**
 * CHOSEN. Cadence enters as a multiplicative penalty, never as a positive axis.
 * Only burst_ratio is computable from what a verify already fetches; the plan's
 * regime_change and cotiming_corr stay roadmap.
 */
export const CADENCE_PENALTY = {
  burstRatioThreshold: 50,
  burstMultiplier: 0.85,
} as const

/*
 * ── MEASURED, verdict cutoffs, 2026-08-16 ───────────────────────────────────
 * Output of `npx tsx scripts/calibrate.ts` over the committed data/signals.csv.
 *
 * The two clusters do not touch. The highest-scoring fresh address reaches 84,
 * the lowest-scoring established address starts at 193, and the 109 points
 * between them are empty. The cutoffs sit on the edges of that gap, so the
 * answer to "why 193 and not 150" is that nothing in the reference set lives
 * there.
 *
 *   group          suspicious   unknown   trusted
 *   fresh                  10         0         0
 *   mid                     4         2         4
 *   established             0         0        10
 *
 * fresh and established separate 10 out of 10. mid spreads across all three,
 * which is what a boundary-stress group is supposed to do.
 */
export const VERDICT = {
  suspiciousMax: 84,
  trustedMin: 193,
} as const
