/**
 * Is this address controlled by a named exchange? Answered from a committed,
 * pinned label set instead of from behaviour.
 *
 * Source      Dune Spellbook, model cex_evms.addresses
 * Commit      9f61b0dd2bba5a8314d0f36eca1419da5d25ac97 (2026-01-28)
 * Contents    4,957 addresses, 328 exchanges, latest entry added 2026-01-02
 * Rebuild     npx tsx scripts/build-cex-labels.ts
 *
 * The full provenance, including the sha256 of the upstream SQL file and the
 * licence, lives in the `meta` block of data/cex-addresses-evm.json and is
 * committed with it. Do not edit that file by hand: regenerate it.
 *
 * LICENCE: Business Source License 1.1, licensor Dune Analytics AS, Change Date
 * 2027-03-03 (then GPLv3+). Fine for a demo and for evaluation; read the licence
 * before shipping this to production.
 *
 * What a hit proves, and what it does not:
 *   - EOA ownership is chain-invariant on EVM, so an address Dune labels as
 *     "Binance 76" on any EVM chain is the same key on Base. The identity of the
 *     ADDRESS carries across chains.
 *   - It does NOT prove the wallet is an active hot wallet on Base, and it does
 *     not prove the payer owns the exchange account behind it. Anyone can be
 *     sent an unsolicited transfer. This upgrades the funder's IDENTITY from
 *     inferred to confirmed. It does not upgrade the inference drawn from it.
 *   - The list is community-curated. It is the best available source, not an
 *     oracle: it can be stale (see the commit date) and it can be wrong.
 */

import { readFileSync } from 'node:fs'

type Entry = { cex: string; name: string; added: string }

type Dataset = {
  meta: { commit: string; source: string; count: number }
  addresses: Record<string, Entry>
}

// Resolved against this module, not the process cwd, so the CLI, the server and
// the scripts all read the same file no matter where they are started from.
const DATASET_PATH = new URL('../data/cex-addresses-evm.json', import.meta.url)

const dataset: Dataset = JSON.parse(readFileSync(DATASET_PATH, 'utf8')) as Dataset

/** Short, citable provenance for anything this module confirms. */
export const CEX_LABEL_SOURCE = `dune-spellbook@${dataset.meta.commit.slice(0, 7)}`

export type CexMatch = {
  /** The exchange. "Binance" */
  cex: string
  /** The exchange's own name for this wallet. "Binance 76" */
  name: string
  /** Where the name came from, for citing in an attestation. */
  source: string
  /** Always confirmed: this path is an exact match against a named list. */
  identity: 'confirmed'
}

/** Exact match against the pinned label set, or null. Case-insensitive. */
export function lookupCex(address: string): CexMatch | null {
  const entry = dataset.addresses[address.toLowerCase()]
  if (entry === undefined) return null
  return { cex: entry.cex, name: entry.name, source: CEX_LABEL_SOURCE, identity: 'confirmed' }
}

/** How many addresses are behind a miss, for saying so honestly in a report. */
export function cexLabelCount(): number {
  return dataset.meta.count
}
