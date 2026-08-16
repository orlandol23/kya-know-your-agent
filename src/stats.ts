/**
 * The one percentile definition used everywhere: linear interpolation between
 * order statistics, the numpy default. Shared so the calibration report and the
 * runtime signals cannot drift apart on what "p25" means.
 */

/** `values` is sorted ascending. `fraction` is 0..1. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return Number.NaN
  if (values.length === 1) return values[0] as number

  const rank = fraction * (values.length - 1)
  const low = Math.floor(rank)
  const high = Math.ceil(rank)
  const lowValue = values[low] as number
  if (low === high) return lowValue
  return lowValue + (rank - low) * ((values[high] as number) - lowValue)
}

export function sortedAscending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b)
}
