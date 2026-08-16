/**
 * score -> trusted | unknown | suspicious.
 *
 * The cutoffs are not opinions. They sit in the empty gap between the clusters
 * of the reference set: SUSPICIOUS_MAX is the highest score any fresh address
 * reached, TRUSTED_MIN the lowest any established address reached. Both come
 * out of `npx tsx scripts/calibrate.ts`, which anyone can rerun over the
 * committed data/signals.csv.
 *
 * `gated` is not a verdict, it is a different axis: a gated address is reported
 * suspicious AND gated, so a consumer that only reads the verdict still blocks
 * it, and one that reads both can tell "no track record" from "not allowed".
 */

import { VERDICT } from './config.js'
import type { ScoreBreakdown } from './score.js'

export type VerdictName = 'trusted' | 'unknown' | 'suspicious'

export type Verdict = {
  verdict: VerdictName
  gated: boolean
  score: number
  /** The single sentence to show a human. */
  summary: string
  reasons: string[]
}

export function verdictFor(score: number): VerdictName {
  if (score <= VERDICT.suspiciousMax) return 'suspicious'
  if (score >= VERDICT.trustedMin) return 'trusted'
  return 'unknown'
}

export function decide(breakdown: ScoreBreakdown): Verdict {
  const verdict = breakdown.gated ? 'suspicious' : verdictFor(breakdown.score)

  const summary = breakdown.gated
    ? `blocked: ${breakdown.gateReason}`
    : verdict === 'trusted'
      ? `established track record: score ${breakdown.score} at or above ${VERDICT.trustedMin}`
      : verdict === 'suspicious'
        ? `no track record to speak of: score ${breakdown.score} at or below ${VERDICT.suspiciousMax}`
        : `some history, not enough to vouch for: score ${breakdown.score} between ` +
          `${VERDICT.suspiciousMax} and ${VERDICT.trustedMin}`

  return {
    verdict,
    gated: breakdown.gated,
    score: breakdown.score,
    summary,
    reasons: breakdown.reasons,
  }
}
