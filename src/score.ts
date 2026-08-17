/**
 * signals + funding -> score 0..1000.
 *
 *   score = 1000 · G · penalty · confidence
 *   G     = ∏ max(s_k, EPS) ^ w_k
 *
 * Geometric, not a sum, because a weak axis must not be bought back with a
 * strong one: an agent funded from nowhere cannot compensate with volume. With
 * a sum it could.
 *
 * Confidence is the honest half. A wallet with almost no history scores low
 * because there is not enough evidence to say anything, not because it was
 * judged badly. The score rises as the address earns the right to be judged.
 */

import {
  CADENCE_PENALTY,
  FUNDING_LEVEL,
  SCORE,
  THRESHOLDS,
  WEIGHTS,
} from './config.js'
import { sanctionEntryFor, type FundingProvenance } from './funding.js'

/**
 * Just the fields the score reads. `Signals` satisfies it structurally, and so
 * does a row rebuilt from data/signals.csv, which is how the calibration report
 * scores the reference set without going back to the network.
 */
export type ScoreInput = {
  address: string
  ageDays: number
  txCount: number
  windowSize: number
  burstRatio: number | null
  firstSeen: string | null
}

export type Axis = {
  /** Raw observation, in its own unit. */
  value: number
  /** 0..1 after clamping between the calibrated ZERO and FULL. */
  normalized: number
  weight: number
}

export type ScoreBreakdown = {
  score: number
  gated: boolean
  /** Why the gate fired, null when it did not. */
  gateReason: string | null
  axes: { funding: Axis; maturity: Axis; volume: Axis }
  geometricMean: number
  penalty: number
  confidence: number
  evidenceMass: number
  /** One line per thing that moved the score, for showing a human. */
  reasons: string[]
}

/** clamp((x - zero) / (full - zero), 0, 1) */
export function normalize(value: number, zero: number, full: number): number {
  if (full <= zero) return 0
  return Math.min(1, Math.max(0, (value - zero) / (full - zero)))
}

function geometricMean(axes: { normalized: number; weight: number }[]): number {
  // In log space: a product of powers is a weighted sum of logs.
  const logSum = axes.reduce(
    (total, axis) => total + axis.weight * Math.log(Math.max(axis.normalized, SCORE.eps)),
    0,
  )
  return Math.exp(logSum)
}

function cadencePenalty(burstRatio: number | null): { penalty: number; reason: string | null } {
  if (burstRatio === null || burstRatio <= CADENCE_PENALTY.burstRatioThreshold) {
    return { penalty: 1, reason: null }
  }
  return {
    penalty: CADENCE_PENALTY.burstMultiplier,
    reason:
      `bursty history: fastest 1% of gaps is ${Math.round(burstRatio)}x tighter than the ` +
      `median gap (threshold ${CADENCE_PENALTY.burstRatioThreshold}), score x${CADENCE_PENALTY.burstMultiplier}`,
  }
}

/** Everything a gated result shares. score 0, no geometric mean, no verdict. */
function gatedShell(
  axes: ScoreBreakdown['axes'],
  penalty: number,
  confidence: number,
  evidenceMass: number,
): ScoreBreakdown {
  return {
    score: 0,
    gated: true,
    gateReason: null,
    axes,
    geometricMean: 0,
    penalty,
    confidence,
    evidenceMass,
    reasons: [],
  }
}

export function scoreAddress(signals: ScoreInput, funding: FundingProvenance): ScoreBreakdown {
  const fundingLevel = FUNDING_LEVEL[funding.class]
  const axes = {
    funding: { value: fundingLevel, normalized: fundingLevel, weight: WEIGHTS.funding },
    maturity: {
      value: signals.ageDays,
      normalized: normalize(signals.ageDays, THRESHOLDS.ageDays.zero, THRESHOLDS.ageDays.full),
      weight: WEIGHTS.maturity,
    },
    volume: {
      value: signals.txCount,
      normalized: normalize(signals.txCount, THRESHOLDS.txCount.zero, THRESHOLDS.txCount.full),
      weight: WEIGHTS.volume,
    },
  }

  const evidenceMass = signals.windowSize
  const confidence = evidenceMass / (evidenceMass + SCORE.confidenceK)
  const { penalty, reason: penaltyReason } = cadencePenalty(signals.burstRatio)

  // Compliance gate: binary, separate from the score, and it wins. Not a low
  // score, a different answer entirely. Being listed beats being funded by
  // someone listed, so it is checked first.
  const listedItself = sanctionEntryFor(signals.address)
  if (listedItself !== null) {
    return {
      ...gatedShell(axes, penalty, confidence, evidenceMass),
      gateReason: `address is on the OFAC SDN list: ${listedItself}`,
      reasons: [`compliance gate: this address is itself sanctioned (${listedItself})`],
    }
  }

  if (funding.class === 'mixer' || funding.class === 'sanctioned') {
    const what = funding.class === 'mixer' ? 'a known mixer' : 'a sanctioned address'
    return {
      ...gatedShell(axes, penalty, confidence, evidenceMass),
      gateReason: `funded by ${what}: ${funding.label ?? funding.source ?? 'unknown entry'}`,
      reasons: [`compliance gate: first inbound came from ${what}`],
    }
  }

  const mean = geometricMean(Object.values(axes))
  const score = Math.round(SCORE.scale * mean * penalty * confidence)

  const reasons: string[] = []

  if (funding.class === 'exchange') {
    // Same class, same weight, same score either way. Only the claim differs.
    reasons.push(
      funding.identity === 'confirmed'
        ? `funded by ${funding.funderLabel} (${funding.source}), identity confirmed against ${funding.labelSource}`
        : `funded by an exchange-class wallet (${funding.source}), identity inferred from behaviour and not confirmed against any label set`,
    )
  } else if (funding.class === 'none') {
    reasons.push('no inbound transfer ever: nothing funded this wallet')
  } else {
    reasons.push(`funder ${funding.source} matches no known list`)
  }

  reasons.push(
    signals.firstSeen === null
      ? 'no transaction history to age'
      : `${Math.round(signals.ageDays)} days old ` +
        `(full credit at ${THRESHOLDS.ageDays.full}, none below ${THRESHOLDS.ageDays.zero})`,
  )
  reasons.push(
    `${signals.txCount} transactions ` +
      `(full credit at ${THRESHOLDS.txCount.full}, none below ${THRESHOLDS.txCount.zero})`,
  )

  if (penaltyReason !== null) reasons.push(penaltyReason)

  if (confidence < 0.5) {
    reasons.push(
      `thin evidence: ${evidenceMass} transactions observed, confidence ${confidence.toFixed(2)}. ` +
        `Scoring low for lack of data, not for bad behaviour`,
    )
  }

  return {
    score,
    gated: false,
    gateReason: null,
    axes,
    geometricMean: mean,
    penalty,
    confidence,
    evidenceMass,
    reasons,
  }
}
