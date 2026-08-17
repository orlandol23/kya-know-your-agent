/**
 * The three bounded Blockscout calls behind every verify.
 *
 *   1. txlist sort=asc offset=1                    first tx  -> AGE
 *   2. addresses/{addr}/transactions (<= 3 pages)  window    -> DIVERSITY + CADENCE
 *   3. addresses/{addr}/counters                   tx count  -> VOLUME
 *
 * Signals are read from the Blockscout Pro API, which is key-gated and has the
 * rate limit a live demo needs. Pro routes the two APIs under different
 * prefixes:
 *
 *   v2                     https://api.blockscout.com/8453/api/v2/...
 *   Etherscan-compatible   https://api.blockscout.com/v2/api?chain_id=8453&...
 *
 * The public explorer (base.blockscout.com) is never called: it only builds the
 * human-clickable evidence link that ships with the attestation.
 *
 * Cost per address is constant (3 to 5 requests) no matter how large the
 * address is. Diversity and cadence are therefore windowed over the last
 * <= 150 transactions, and that is declared in the output.
 */

import { ConfigError } from './config.js'

/** Blockscout Pro. Every signal is read from here. */
const DEFAULT_API_URL = 'https://api.blockscout.com'
/** Public explorer. Evidence links only, never an API call. */
const DEFAULT_EXPLORER_URL = 'https://base.blockscout.com'
/** Base mainnet. */
const DEFAULT_CHAIN_ID = '8453'

/** 3 pages x 50 tx. The window diversity and cadence are computed over. */
export const WINDOW_PAGES = 3
export const WINDOW_PAGE_SIZE = 50
export const WINDOW_MAX_TXS = WINDOW_PAGES * WINDOW_PAGE_SIZE

/** How far into the oldest history to look for the first INBOUND transfer. */
export const EARLIEST_LIMIT = 10

/*
 * Retry budget sized for a LIVE demo, not for a batch job. Two attempts of 8 s
 * put the worst case (Blockscout hanging on every call) at about 17 s, against
 * ~65 s with the previous 4 x 15 s. A minute of frozen screen is a sixth of a
 * ten-minute pitch; the answer to a longer outage is --offline, not patience.
 * scripts/collect.ts and scripts/capture.ts share this budget and can simply
 * be re-run.
 */
const MAX_RETRIES = 1
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000
const REQUEST_TIMEOUT_MS = 8_000

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export class BlockscoutError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BlockscoutError'
    this.status = status
  }
}

/** Etherscan-compatible transaction, every field a string. */
export type EtherscanTx = {
  hash: string
  /** Unix seconds, as a string. */
  timeStamp: string
  blockNumber: string
  from: string
  to: string
  /** Set instead of `to` when the transaction created a contract. */
  contractAddress?: string
}

/** A window transaction, normalized away from the endpoint that produced it. */
export type WindowTx = {
  hash: string
  /** Milliseconds since epoch, null when unparseable. */
  timestampMs: number | null
  from: string | null
  to: string | null
}

/** ERC-20 transfer as returned by the Etherscan-compatible tokentx action. */
export type EtherscanTokenTx = {
  hash: string
  timeStamp: string
  from: string
  to: string
  tokenSymbol?: string
  contractAddress?: string
}

type EtherscanListResponse<T> = {
  status: string
  message: string
  result: T[] | string
}

/** /counters returns every value as a STRING. Converted here, once. */
type RawCounters = {
  transactions_count?: string | null
  token_transfers_count?: string | null
  gas_usage_count?: string | null
  validations_count?: string | null
}

export type AddressCounters = {
  transactionsCount: number | null
  tokenTransfersCount: number | null
  gasUsageCount: number | null
  validationsCount: number | null
}

/** Everything one verify reads from the chain, in one shot. */
export type AddressHistory = {
  address: string
  /** Oldest transactions first. [0] dates the account. */
  earliest: EtherscanTx[]
  /** Oldest token transfers first, for wallets that never sent a transaction. */
  earliestTokenTransfers: EtherscanTokenTx[]
  window: WindowTx[]
  counters: AddressCounters
  fetchedAt: string
  blockscoutUrl: string
}

function trimTrailingSlash(value: string | undefined, fallback: string): string {
  return value?.trim().replace(/\/+$/, '') || fallback
}

export function apiUrl(): string {
  return trimTrailingSlash(process.env.BLOCKSCOUT_API_URL, DEFAULT_API_URL)
}

export function explorerUrl(): string {
  return trimTrailingSlash(process.env.BLOCKSCOUT_EXPLORER_URL, DEFAULT_EXPLORER_URL)
}

export function chainId(): string {
  return process.env.BLOCKSCOUT_CHAIN_ID?.trim() || DEFAULT_CHAIN_ID
}

/**
 * The Pro API is key-gated: without a key every call comes back 402. Fail here,
 * with an actionable message, instead of at the third confusing HTTP error.
 */
export function requireApiKey(): string {
  const key = process.env.BLOCKSCOUT_API_KEY?.trim()
  if (!key) {
    throw new ConfigError(
      'BLOCKSCOUT_API_KEY is empty. The Blockscout Pro API requires a key: ' +
        'copy .env.example to .env and fill in your key.',
    )
  }
  return key
}

/** Human-clickable evidence link. Public explorer, not the API. */
export function blockscoutUrl(address: string): string {
  return `${explorerUrl()}/address/${address}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with jitter, unless the server told us how long to wait. */
function backoffMs(attempt: number, retryAfter: string | null): number {
  const seconds = Number(retryAfter)
  if (retryAfter !== null && Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, MAX_BACKOFF_MS)
  }
  const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1)
  return Math.min(exponential, MAX_BACKOFF_MS) + Math.floor(Math.random() * 250)
}

function withParams(url: URL, params: Record<string, string | number>): URL {
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value))
  }
  return url
}

/** Pro nests the v2 API under the chain id: /8453/api/v2/... */
function v2Url(path: string, params: Record<string, string | number> = {}): URL {
  return withParams(new URL(`${apiUrl()}/${chainId()}/api/v2/${path}`), params)
}

/** Pro selects the chain of the Etherscan-compatible API by query param. */
function etherscanUrl(params: Record<string, string | number>): URL {
  return withParams(new URL(`${apiUrl()}/v2/api`), { chain_id: chainId(), ...params })
}

async function request<T>(url: URL, label: string): Promise<T> {
  // Sent as a header so the key never lands in a URL, a log line or an error.
  const apiKey = requireApiKey()
  let lastError = new BlockscoutError(`no request made for ${label}`)
  let retryAfter: string | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    if (attempt > 0) await sleep(backoffMs(attempt, retryAfter))

    let response: Response
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (cause) {
      // Network error, DNS failure or timeout: always worth another attempt.
      lastError = new BlockscoutError(`${label} failed: ${(cause as Error).message}`)
      retryAfter = null
      continue
    }

    if (response.ok) return (await response.json()) as T

    // 402 = no key reached the API, 401 = the key was rejected. Retrying either
    // just burns the demo clock.
    if (response.status === 401 || response.status === 402) {
      throw new BlockscoutError(
        `${label}: Blockscout Pro answered ${response.status}. Check BLOCKSCOUT_API_KEY.`,
        response.status,
      )
    }

    const error = new BlockscoutError(
      `${label} returned ${response.status} ${response.statusText}`,
      response.status,
    )
    if (!RETRIABLE_STATUS.has(response.status)) throw error
    lastError = error
    retryAfter = response.headers.get('retry-after')
  }

  throw lastError
}

function toNumber(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function unwrapRows<T>(body: EtherscanListResponse<T>, action: string, address: string): T[] {
  if (Array.isArray(body.result)) return body.result
  // "No transactions found" is a legitimate empty history, not a failure.
  if (/no (transactions|token transfers) found/i.test(body.message)) return []
  throw new BlockscoutError(`${action} rejected ${address}: ${body.message || body.result}`)
}

/**
 * Keep only the fields the pipeline reads. The Etherscan-compatible rows also
 * carry the full calldata (`input`), which for an airdropped spam token can be
 * 80 KB per row; that is what made one fixture weigh 1.1 MB. Pruned here, once,
 * so the cache and the committed fixtures stay small and the types stay honest.
 */
function pickTx(row: EtherscanTx): EtherscanTx {
  const tx: EtherscanTx = {
    hash: row.hash,
    timeStamp: row.timeStamp,
    blockNumber: row.blockNumber,
    from: row.from,
    to: row.to,
  }
  if (row.contractAddress) tx.contractAddress = row.contractAddress
  return tx
}

function pickTokenTx(row: EtherscanTokenTx): EtherscanTokenTx {
  const tx: EtherscanTokenTx = { hash: row.hash, timeStamp: row.timeStamp, from: row.from, to: row.to }
  if (row.tokenSymbol) tx.tokenSymbol = row.tokenSymbol
  if (row.contractAddress) tx.contractAddress = row.contractAddress
  return tx
}

/**
 * Call 1: the oldest transactions of the address, oldest first.
 *
 * result[0] dates the account (AGE). The rest are there for funding provenance:
 * the first transaction of an EOA is usually inbound and names whoever funded
 * it, but not always, so a few rows are read to find the first INBOUND one.
 */
export async function fetchEarliestTransactions(
  address: string,
  limit = EARLIEST_LIMIT,
): Promise<EtherscanTx[]> {
  const body = await request<EtherscanListResponse<EtherscanTx>>(
    etherscanUrl({ module: 'account', action: 'txlist', address, sort: 'asc', page: 1, offset: limit }),
    'txlist',
  )
  return unwrapRows(body, 'txlist', address).map(pickTx)
}

/**
 * Call 4: the oldest token transfers, oldest first.
 *
 * A wallet that pays through a relayer or a smart account can have ZERO
 * transactions and still have been funded: 13 of the 74 addresses sampled on D2
 * looked like that, one of them with 25k token transfers. The first inbound
 * transfer exists even when the transaction count does not.
 */
export async function fetchEarliestTokenTransfers(
  address: string,
  limit = EARLIEST_LIMIT,
): Promise<EtherscanTokenTx[]> {
  const body = await request<EtherscanListResponse<EtherscanTokenTx>>(
    etherscanUrl({ module: 'account', action: 'tokentx', address, sort: 'asc', page: 1, offset: limit }),
    'tokentx',
  )
  return unwrapRows(body, 'tokentx', address).map(pickTokenTx)
}

function toWindowTx(tx: EtherscanTx): WindowTx {
  const seconds = Number(tx.timeStamp)
  return {
    hash: tx.hash,
    timestampMs: Number.isFinite(seconds) ? seconds * 1_000 : null,
    from: tx.from || null,
    // Contract creations carry the new address in contractAddress, not `to`.
    to: tx.to || tx.contractAddress || null,
  }
}

/**
 * Call 2: the last <= 150 transactions, in up to 3 pages.
 *
 * Served by the Etherscan-compatible txlist rather than v2
 * /addresses/{addr}/transactions, for three measured reasons (2026-08-15):
 * v2 answered 500 for 23 of 30 addresses during the first calibration run while
 * this route stayed up; v2 takes ~20s per page against ~2s here; and v2 paginates
 * by cursor, so its pages must be walked in sequence, while numbered pages are
 * fetched in parallel. One round trip instead of three matters in a live demo.
 */
export async function fetchTransactionWindow(
  address: string,
  maxPages = WINDOW_PAGES,
): Promise<WindowTx[]> {
  const pages = await Promise.all(
    Array.from({ length: maxPages }, (_unused, index) =>
      request<EtherscanListResponse<EtherscanTx>>(
        etherscanUrl({
          module: 'account',
          action: 'txlist',
          address,
          sort: 'desc',
          page: index + 1,
          offset: WINDOW_PAGE_SIZE,
        }),
        `txlist page ${index + 1}`,
      ),
    ),
  )

  // Pages are fetched concurrently, so a transaction landing mid-fetch can shift
  // across page boundaries and appear twice. Key by hash.
  const window = new Map<string, WindowTx>()
  for (const body of pages) {
    if (!Array.isArray(body.result)) continue // "No transactions found"
    for (const tx of body.result) window.set(tx.hash, toWindowTx(tx))
  }

  return [...window.values()]
}

/** Call 3: lifetime counters. Values arrive as strings and are converted here. */
export async function fetchCounters(address: string): Promise<AddressCounters> {
  const raw = await request<RawCounters>(v2Url(`addresses/${address}/counters`), 'counters')
  return {
    transactionsCount: toNumber(raw.transactions_count),
    tokenTransfersCount: toNumber(raw.token_transfers_count),
    gasUsageCount: toNumber(raw.gas_usage_count),
    validationsCount: toNumber(raw.validations_count),
  }
}

/**
 * The three calls together: everything one verify needs.
 *
 * Blockscout computes /counters lazily: the first request for a cold address
 * can answer 0 while the real count is in the thousands, and a later request
 * answers correctly. The window is a subset of all transactions, so a count
 * BELOW the window size is proof the counter is cold. One re-read fixes it;
 * signals.ts downgrades to a window lower bound if it is still inconsistent.
 */
export async function fetchAddressHistory(address: string): Promise<AddressHistory> {
  const [earliest, earliestTokenTransfers, window, firstCounters] = await Promise.all([
    fetchEarliestTransactions(address),
    fetchEarliestTokenTransfers(address),
    fetchTransactionWindow(address),
    fetchCounters(address),
  ])

  const isCold =
    firstCounters.transactionsCount !== null && firstCounters.transactionsCount < window.length
  const counters = isCold ? await fetchCounters(address) : firstCounters

  return {
    address,
    earliest,
    earliestTokenTransfers,
    window,
    counters,
    fetchedAt: new Date().toISOString(),
    blockscoutUrl: blockscoutUrl(address),
  }
}
