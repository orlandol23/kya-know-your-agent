/**
 * Where a verify gets its history from: the network, a fresh cache entry, or a
 * committed fixture. Everything downstream (signals, score, verdict, attestation)
 * is pure, so this is the only seam that decides "live or replay".
 *
 *   live      fetchAddressHistory() -> data/cache/<address>.json   (TTL 10 min)
 *   offline   data/fixtures/<address>.json, else data/cache/ at any age,
 *             else NoFixtureError. The network is never touched.
 *
 * The cache and the fixtures share one file format, so a fixture is just a
 * cache entry that was kept and committed. Both are DATED CAPTURES OF LIVE
 * ADDRESSES: `captured_at` says when, and the attestation built from one
 * carries that same instant as `evidence.fetched_at`, while `issued_at` says
 * when the attestation was signed. A consumer that reads both can tell a
 * replay from a fresh read without any extra field.
 *
 * Offline mode is switched on by --offline on the CLI, the server or the demo
 * endpoint (they set KYA_OFFLINE=1), or by exporting KYA_OFFLINE=1 yourself.
 * The server also honours ?offline=1 per request, so the demo UI can flip to
 * fixtures without a restart if Blockscout dies mid-pitch (PLAN.md, risk 1).
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { BlockscoutError, apiUrl, chainId, fetchAddressHistory, type AddressHistory } from './blockscout.js'

export const FIXTURES_DIR = 'data/fixtures'
export const CACHE_DIR = 'data/cache'
/** PLAN.md section 7, decision 3: ten minutes, and nothing else is stored. */
export const CACHE_TTL_MS = 10 * 60_000

export type HistorySource = 'live' | 'cache' | 'fixture'

/** The file format, shared by cache and fixtures. */
export type HistoryFile = {
  kya_history: 'v0.1'
  address: string
  /** When Blockscout was read. Same instant as history.fetchedAt. */
  captured_at: string
  chain_id: number
  api_url: string
  note: string
  history: AddressHistory
}

export type LoadedHistory = {
  history: AddressHistory
  source: HistorySource
  /** When the data was read from the chain, whichever source served it. */
  capturedAt: string
  /** The file read (cache, fixture) or written (live), null if none. */
  path: string | null
}

const NOTE =
  'Dated capture of a live address. Its on-chain history has moved on since; ' +
  'the attestation built from this file carries captured_at as evidence.fetched_at.'

/** Offline mode wanted and no fixture (or cache entry) exists for the address. */
export class NoFixtureError extends BlockscoutError {
  readonly address: string
  readonly available: string[]

  constructor(address: string, available: string[]) {
    super(
      `offline mode: no fixture for ${address} in ${FIXTURES_DIR}/ (or ${CACHE_DIR}/). ` +
        (available.length > 0
          ? `Available: ${available.join(', ')}. `
          : 'No fixtures found. ') +
        `Capture one with: npx tsx scripts/capture.ts ${address}`,
    )
    this.name = 'NoFixtureError'
    this.address = address
    this.available = available
  }
}

export function isOffline(): boolean {
  return process.env.KYA_OFFLINE === '1'
}

export function setOffline(on: boolean): void {
  if (on) process.env.KYA_OFFLINE = '1'
  else delete process.env.KYA_OFFLINE
}

function filePath(dir: string, address: string): string {
  return join(dir, `${address}.json`)
}

function readHistoryFile(path: string): HistoryFile | null {
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HistoryFile>
    if (parsed.kya_history !== 'v0.1' || !parsed.history || !parsed.captured_at) return null
    return parsed as HistoryFile
  } catch {
    return null
  }
}

function writeHistoryFile(dir: string, history: AddressHistory): string {
  mkdirSync(dir, { recursive: true })
  const path = filePath(dir, history.address)
  const file: HistoryFile = {
    kya_history: 'v0.1',
    address: history.address,
    captured_at: history.fetchedAt,
    chain_id: Number(chainId()),
    api_url: apiUrl(),
    note: NOTE,
    history,
  }
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`)
  return path
}

/** Addresses with a committed fixture, as named on disk (checksummed). */
export function listFixtures(): string[] {
  if (!existsSync(FIXTURES_DIR)) return []
  return readdirSync(FIXTURES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -'.json'.length))
    .sort()
}

/** Read Blockscout now and keep the result as a fixture. Returns the path. */
export async function captureFixture(address: string): Promise<{ path: string; history: AddressHistory }> {
  const history = await fetchAddressHistory(address)
  return { path: writeHistoryFile(FIXTURES_DIR, history), history }
}

/**
 * The history for one (checksummed) address, from wherever the mode allows.
 * Never touches the network when offline.
 */
export async function loadHistory(
  address: string,
  options: { offline?: boolean } = {},
): Promise<LoadedHistory> {
  const offline = options.offline ?? isOffline()

  if (offline) {
    const fixturePath = filePath(FIXTURES_DIR, address)
    const fixture = readHistoryFile(fixturePath)
    if (fixture !== null) {
      return { history: fixture.history, source: 'fixture', capturedAt: fixture.captured_at, path: fixturePath }
    }
    const cachePath = filePath(CACHE_DIR, address)
    const cached = readHistoryFile(cachePath)
    if (cached !== null) {
      return { history: cached.history, source: 'cache', capturedAt: cached.captured_at, path: cachePath }
    }
    throw new NoFixtureError(address, listFixtures())
  }

  const cachePath = filePath(CACHE_DIR, address)
  const cached = readHistoryFile(cachePath)
  if (cached !== null && Date.now() - Date.parse(cached.captured_at) < CACHE_TTL_MS) {
    return { history: cached.history, source: 'cache', capturedAt: cached.captured_at, path: cachePath }
  }

  const history = await fetchAddressHistory(address)
  let path: string | null = null
  try {
    path = writeHistoryFile(CACHE_DIR, history)
  } catch {
    // A read-only checkout must not break a verify. The cache is a convenience.
  }
  return { history, source: 'live', capturedAt: history.fetchedAt, path }
}
