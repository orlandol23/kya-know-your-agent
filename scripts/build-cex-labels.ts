/**
 * Rebuilds data/cex-addresses-evm.json from the Dune Spellbook, at a pinned commit.
 *
 *   npx tsx scripts/build-cex-labels.ts        (run from the repo root)
 *
 * Committed so the label set is reproducible rather than trusted. The output is
 * deterministic for the pinned commit, byte for byte, except `built_on`. So the
 * check that this file really produced the committed data is:
 *
 *   npx tsx scripts/build-cex-labels.ts && git diff --stat data/cex-addresses-evm.json
 *
 * which should report only the `built_on` line.
 *
 * Zero dependencies: Node 18+ fetch. The upstream file is ~1 MB of SQL.
 *
 * LICENCE: the data is Business Source License 1.1 (licensor Dune Analytics AS,
 * Change Date 2027-03-03, then GPLv3+). Read it before any production use.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const COMMIT = '9f61b0dd2bba5a8314d0f36eca1419da5d25ac97' // 2026-01-28
const COMMIT_DATE = '2026-01-28'
const FILE =
  'dbt_subprojects/hourly_spellbook/models/_sector/cex/addresses/chains/cex_evms_addresses.sql'
const RAW = `https://raw.githubusercontent.com/duneanalytics/spellbook/${COMMIT}/${FILE}`
const OUT = 'data/cex-addresses-evm.json'

// Rows look like: (0xabc..., 'Coinbase', 'Coinbase 21', 'hildobby', date '2023-11-19')
const ROW =
  /\((0x[0-9a-fA-F]{40}),\s*'([^']*)',\s*'([^']*)',\s*'([^']*)',\s*date\s*'([^']*)'\)/g

type Entry = { cex: string; name: string; added: string }

/**
 * One field per line, no indentation: a 5k-entry file that stays greppable and
 * diffs one address at a time, without paying for 4 MB of leading spaces.
 * Emitted by hand because no JSON.stringify indent setting produces it.
 */
function serialize(meta: Record<string, string | number>, addresses: Record<string, Entry>): string {
  const fields = (record: Record<string, string | number>): string =>
    Object.entries(record)
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(',\n')

  const rows = Object.entries(addresses)
    .map(([address, entry]) => `${JSON.stringify(address)}:{\n${fields({ ...entry })}\n}`)
    .join(',\n')

  return `{\n"meta":{\n${fields(meta)}\n},\n"addresses":{\n${rows}\n}\n}`
}

async function main(): Promise<void> {
  const response = await fetch(RAW)
  if (!response.ok) throw new Error(`fetch failed: ${response.status} ${RAW}`)
  const sql = await response.text()

  // Insertion order is the upstream file's order, which is what makes the
  // output stable across runs.
  const addresses: Record<string, Entry> = {}
  for (const match of sql.matchAll(ROW)) {
    const [, address, cex, name, , added] = match
    if (address === undefined || cex === undefined || name === undefined || added === undefined) {
      continue
    }
    addresses[address.toLowerCase()] = { cex, name, added }
  }

  const entries = Object.values(addresses)
  if (entries.length === 0) throw new Error(`no rows matched in ${FILE}: the upstream format changed`)

  const meta = {
    source: 'Dune Spellbook, model cex_evms.addresses (community-curated CEX addresses, EVM-wide)',
    repo: 'https://github.com/duneanalytics/spellbook',
    file: FILE,
    commit: COMMIT,
    commit_date: COMMIT_DATE,
    raw_url: RAW,
    sha256_of_source_file: createHash('sha256').update(sql).digest('hex'),
    license:
      'Business Source License 1.1 (Licensor: Dune Analytics AS; Change Date 2027-03-03 -> GPLv3+). Read LICENSE before production use.',
    count: entries.length,
    exchanges: new Set(entries.map((entry) => entry.cex)).size,
    latest_added_date: entries.map((entry) => entry.added).sort().at(-1) ?? '',
    note:
      'EOA ownership is chain-invariant on EVM (same key, same address). Presence here = address controlled by that exchange, not proof it is an active hot wallet on Base.',
    built_on: new Date().toISOString().slice(0, 10),
  }

  mkdirSync('data', { recursive: true })
  writeFileSync(OUT, serialize(meta, addresses))
  console.log(
    `wrote ${OUT}: ${meta.count} addresses, ${meta.exchanges} exchanges @ ${COMMIT.slice(0, 7)}`,
  )
  console.log(`sha256 of source: ${meta.sha256_of_source_file}`)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
