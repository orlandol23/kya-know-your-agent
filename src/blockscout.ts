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

/** Blockscout Pro. Every signal is read from here. */
const DEFAULT_API_URL = 'https://api.blockscout.com'
/** Public explorer. Evidence links only, never an API call. */
const DEFAULT_EXPLORER_URL = 'https://base.blockscout.com'
/** Base mainnet. */
const DEFAULT_CHAIN_ID = '8453'

/** 3 pages x 50 tx. The window diversity and cadence are computed over. */
export const WINDOW_PAGES = 3
export const WINDOW_MAX_TXS = 150

const MAX_RETRIES = 3
const BASE_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 8_000
const REQUEST_TIMEOUT_MS = 15_000

const RETRIABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

export class BlockscoutError extends Error {
  readonly status: number | undefined

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'BlockscoutError'
    this.status = status
  }
}

/** Missing or unusable configuration. Distinct from a failed request. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
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
}

type EtherscanTxListResponse = {
  status: string
  message: string
  result: EtherscanTx[] | string
}

type V2AddressRef = { hash: string } | null

/** Transaction as returned by the v2 API. */
export type V2Transaction = {
  hash: string
  /** ISO-8601, null while the transaction is still pending. */
  timestamp: string | null
  from: V2AddressRef
  to: V2AddressRef
  created_contract?: V2AddressRef
}

type V2TransactionsPage = {
  items?: V2Transaction[]
  next_page_params?: Record<string, string | number> | null
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
  firstTransaction: EtherscanTx | null
  window: V2Transaction[]
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

/** Call 1: oldest transaction of the address. Null when it has none. */
export async function fetchFirstTransaction(address: string): Promise<EtherscanTx | null> {
  const body = await request<EtherscanTxListResponse>(
    etherscanUrl({
      module: 'account',
      action: 'txlist',
      address,
      sort: 'asc',
      page: 1,
      offset: 1,
    }),
    'txlist',
  )

  if (!Array.isArray(body.result)) {
    // "No transactions found" is a legitimate empty history, not a failure.
    if (/no transactions found/i.test(body.message)) return null
    throw new BlockscoutError(`txlist rejected ${address}: ${body.message || body.result}`)
  }

  return body.result[0] ?? null
}

/** Call 2: the last <= 150 transactions, in up to 3 pages. */
export async function fetchTransactionWindow(
  address: string,
  maxPages = WINDOW_PAGES,
): Promise<V2Transaction[]> {
  const items: V2Transaction[] = []
  let params: Record<string, string | number> | null = {}

  for (let page = 0; page < maxPages && params !== null; page += 1) {
    const body: V2TransactionsPage = await request<V2TransactionsPage>(
      v2Url(`addresses/${address}/transactions`, params),
      'transactions',
    )
    items.push(...(body.items ?? []))
    params = body.next_page_params ?? null
  }

  return items
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

/** The three calls together: everything one verify needs. */
export async function fetchAddressHistory(address: string): Promise<AddressHistory> {
  const [firstTransaction, window, counters] = await Promise.all([
    fetchFirstTransaction(address),
    fetchTransactionWindow(address),
    fetchCounters(address),
  ])

  return {
    address,
    firstTransaction,
    window,
    counters,
    fetchedAt: new Date().toISOString(),
    blockscoutUrl: blockscoutUrl(address),
  }
}
