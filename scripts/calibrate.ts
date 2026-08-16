/**
 * npx tsx scripts/calibrate.ts
 *
 * Reads data/signals.csv and prints, per signal per group: min, p25, p50, p75,
 * max, and the ZERO/FULL pair that follows from them (section 4c of PLAN.md):
 *
 *   ZERO = p75 of the fresh group           below this, indistinguishable from new
 *   FULL = p25 of the established group     from here on, typical of established
 *
 * The threshold is an output of this repository, not an input. No score here:
 * scoring is D3.
 */

import { existsSync, readFileSync } from 'node:fs'

import { parseCsv, type CsvRow } from '../src/csv.js'
import type { FundingClass, FundingProvenance } from '../src/funding.js'
import { scoreAddress } from '../src/score.js'
import { percentile as percentileOf, sortedAscending } from '../src/stats.js'

const SIGNALS_CSV = 'data/signals.csv'

/** Print order: weakest group first, so the columns read left to right. */
const GROUPS = ['fresh', 'mid', 'established'] as const
const ZERO_GROUP = 'fresh'
const FULL_GROUP = 'established'

const METRICS = [
  { column: 'age_days', title: 'age_days', signal: 'age' },
  { column: 'tx_count', title: 'tx_count', signal: 'volume' },
  { column: 'distinct_counterparties', title: 'distinct_counterparties', signal: 'diversity' },
  { column: 'txs_24h', title: 'txs_24h', signal: 'cadence' },
  { column: 'txs_7d', title: 'txs_7d', signal: 'cadence' },
] as const

type Stats = { min: number; p25: number; p50: number; p75: number; max: number; n: number }

function summarize(values: number[]): Stats {
  const sorted = sortedAscending(values)
  return {
    min: percentileOf(sorted, 0),
    p25: percentileOf(sorted, 0.25),
    p50: percentileOf(sorted, 0.5),
    p75: percentileOf(sorted, 0.75),
    max: percentileOf(sorted, 1),
    n: sorted.length,
  }
}

/** Rebuild just enough of a scored address from one CSV row. */
function scoreRow(row: CsvRow): number {
  const funding: FundingProvenance = {
    class: (row.funding_class || 'unknown') as FundingClass,
    source: row.funding_source || null,
    label: null,
    firstInboundAt: null,
    via: null,
  }
  return scoreAddress(
    {
      address: row.address ?? '',
      ageDays: Number(row.age_days ?? 0),
      txCount: Number(row.tx_count ?? 0),
      windowSize: Number(row.window_size ?? 0),
      burstRatio: row.burst_ratio ? Number(row.burst_ratio) : null,
      firstSeen: row.first_seen || null,
    },
    funding,
  ).score
}

function format(value: number): string {
  if (Number.isNaN(value)) return '-'
  const rounded = Math.round(value * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2)
}

function cell(value: number): string {
  return format(value).padStart(10)
}

function main(): void {
  if (!existsSync(SIGNALS_CSV)) {
    console.error(`${SIGNALS_CSV} not found. Run: npx tsx scripts/collect.ts`)
    process.exitCode = 1
    return
  }

  const rows = parseCsv(readFileSync(SIGNALS_CSV, 'utf8'))
  if (rows.length === 0) {
    console.error(`${SIGNALS_CSV} has no data rows.`)
    process.exitCode = 1
    return
  }

  const byGroup = new Map<string, typeof rows>()
  for (const row of rows) {
    const label = row.label ?? ''
    byGroup.set(label, [...(byGroup.get(label) ?? []), row])
  }

  const counts = GROUPS.map((group) => `${group} ${byGroup.get(group)?.length ?? 0}`).join(', ')
  const unlabeled = [...byGroup.keys()].filter(
    (label) => !GROUPS.includes(label as (typeof GROUPS)[number]),
  )

  console.log('')
  console.log(`KYA · calibration · ${SIGNALS_CSV}`)
  console.log(`n = ${rows.length}   (${counts})`)
  if (unlabeled.length > 0) {
    console.log(`ignored labels: ${unlabeled.join(', ')}`)
  }
  console.log('percentiles by linear interpolation between order statistics')

  const thresholds: { title: string; zero: number; full: number }[] = []

  for (const metric of METRICS) {
    console.log('')
    console.log(`${metric.title}   (${metric.signal})`)
    console.log(`  ${'group'.padEnd(13)}${'min'.padStart(10)}${'p25'.padStart(10)}` +
      `${'p50'.padStart(10)}${'p75'.padStart(10)}${'max'.padStart(10)}${'n'.padStart(5)}`)

    const stats = new Map<string, Stats>()
    for (const group of GROUPS) {
      const values = (byGroup.get(group) ?? [])
        .map((row) => Number(row[metric.column]))
        .filter((value) => Number.isFinite(value))
      const summary = summarize(values)
      stats.set(group, summary)
      console.log(
        `  ${group.padEnd(13)}${cell(summary.min)}${cell(summary.p25)}${cell(summary.p50)}` +
          `${cell(summary.p75)}${cell(summary.max)}${String(summary.n).padStart(5)}`,
      )
    }

    const zero = stats.get(ZERO_GROUP)?.p75 ?? Number.NaN
    const full = stats.get(FULL_GROUP)?.p25 ?? Number.NaN
    thresholds.push({ title: metric.title, zero, full })

    console.log(
      `  ZERO = p75(${ZERO_GROUP}) = ${format(zero)}` +
        `     FULL = p25(${FULL_GROUP}) = ${format(full)}`,
    )
    if (Number.isFinite(zero) && Number.isFinite(full) && full <= zero) {
      console.log(
        `  ⚠ FULL <= ZERO: the two groups overlap on this signal, ` +
          `normalization would divide by <= 0. Do not use it as-is in D3.`,
      )
    }
  }

  // ── scores and verdict cutoffs ────────────────────────────────────────────
  const scores = new Map<string, number[]>()
  const gated: string[] = []
  for (const row of rows) {
    const label = row.label ?? ''
    const score = scoreRow(row)
    scores.set(label, [...(scores.get(label) ?? []), score])
    if (row.funding_class === 'mixer' || row.funding_class === 'sanctioned') {
      gated.push(`${row.address} (${row.funding_class})`)
    }
  }

  console.log('')
  console.log('score   (weighted geometric mean x penalty x confidence, 0..1000)')
  console.log(`  ${'group'.padEnd(13)}${'min'.padStart(10)}${'p25'.padStart(10)}` +
    `${'p50'.padStart(10)}${'p75'.padStart(10)}${'max'.padStart(10)}${'n'.padStart(5)}`)
  for (const group of GROUPS) {
    const summary = summarize(scores.get(group) ?? [])
    console.log(
      `  ${group.padEnd(13)}${cell(summary.min)}${cell(summary.p25)}${cell(summary.p50)}` +
        `${cell(summary.p75)}${cell(summary.max)}${String(summary.n).padStart(5)}`,
    )
  }

  const freshScores = sortedAscending(scores.get('fresh') ?? [])
  const establishedScores = sortedAscending(scores.get('established') ?? [])
  const suspiciousMax = freshScores.at(-1) ?? 0
  const trustedMin = establishedScores[0] ?? 0

  console.log('')
  console.log(`  SUSPICIOUS_MAX = highest fresh score      = ${format(suspiciousMax)}`)
  console.log(`  TRUSTED_MIN    = lowest established score = ${format(trustedMin)}`)
  if (trustedMin > suspiciousMax) {
    console.log(`  the clusters do not touch: empty gap of ${format(trustedMin - suspiciousMax)} points`)
  } else {
    console.log(
      `  ⚠ the clusters OVERLAP by ${format(suspiciousMax - trustedMin)} points. ` +
        `No cutoff separates them cleanly; the numbers below will misclassify.`,
    )
  }

  // Separation table, with the cutoffs this run just derived.
  const verdictOf = (score: number): string =>
    score <= suspiciousMax ? 'suspicious' : score >= trustedMin ? 'trusted' : 'unknown'

  console.log('')
  console.log('separation at those cutoffs')
  console.log(`  ${'group'.padEnd(13)}${'suspicious'.padStart(12)}${'unknown'.padStart(10)}${'trusted'.padStart(10)}`)
  for (const group of GROUPS) {
    const counts = { suspicious: 0, unknown: 0, trusted: 0 }
    for (const score of scores.get(group) ?? []) {
      counts[verdictOf(score) as keyof typeof counts] += 1
    }
    console.log(
      `  ${group.padEnd(13)}${String(counts.suspicious).padStart(12)}` +
        `${String(counts.unknown).padStart(10)}${String(counts.trusted).padStart(10)}`,
    )
  }
  console.log(
    `  gated by compliance (scored 0 before any of this): ` +
      `${gated.length === 0 ? 'none in the reference set' : gated.join(', ')}`,
  )

  console.log('')
  console.log('paste into src/config.ts:')
  console.log('')
  console.log('  export const VERDICT = {')
  console.log(`    suspiciousMax: ${format(suspiciousMax)},`)
  console.log(`    trustedMin: ${format(trustedMin)},`)
  console.log('  } as const')

  console.log('')
  console.log('paste into src/config.ts as the calibration comment:')
  console.log('')
  console.log(`  // calibrated from ${SIGNALS_CSV}, n=${rows.length} (${counts})`)
  console.log(`  // signal                    ZERO (p75 ${ZERO_GROUP})   FULL (p25 ${FULL_GROUP})`)
  for (const threshold of thresholds) {
    console.log(
      `  // ${threshold.title.padEnd(24)}${format(threshold.zero).padStart(14)}` +
        `${format(threshold.full).padStart(20)}`,
    )
  }

  console.log('')
  console.log('  n=30 is a reference set, not statistics')
  console.log('  diversity and cadence are windowed over the last <= 150 transactions')
  console.log('  labels describe the observable, not intent')
  console.log('')
}

main()
