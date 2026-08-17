/**
 * The attestation: what KYA signs, how it is serialized, how anyone checks it.
 *
 * Wire format (snake_case, every field always present, null over undefined):
 *
 *   {
 *     address, verdict, gated, score, summary, reasons,
 *     signals: { age_days, first_seen, tx_count, tx_count_exact,
 *                distinct_counterparties, txs_24h, txs_7d, burst_ratio, funding },
 *     evidence: { chain_id, blockscout_url, window, fetched_at },
 *     attester, issued_at,
 *     signature
 *   }
 *
 * The signed message is the attestation without `signature`, serialized as
 * canonical JSON: keys sorted recursively, no whitespace, numbers and strings as
 * JSON.stringify emits them. That is RFC 8785 (JCS) for this data, so a
 * consumer in any language can rebuild the exact bytes. The API also SERVES the
 * body in canonical order, so in JavaScript the check needs no library at all:
 *
 *   const { signature, ...body } = attestation
 *   const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
 *
 * The signature is EIP-191 (personal_sign) over that string. The attester's
 * address is in the body for discovery only; a consumer must still pin the
 * address it trusts. Nothing here talks to the network.
 */

import { recoverMessageAddress, type Address, type Hex } from 'viem'
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'

import { WINDOW_MAX_TXS, chainId } from './blockscout.js'
import { ConfigError } from './config.js'
import type { FundingClass, FundingProvenance } from './funding.js'
import type { Signals } from './signals.js'
import type { Verdict, VerdictName } from './verdict.js'

export type AttestedFunding = {
  class: FundingClass
  source: string | null
  via: 'native' | 'token' | null
  first_inbound_at: string | null
  label: string | null
  /**
   * The exchange's own name for the funder, e.g. "Binance 76". Null when the
   * funder matched no named list.
   */
  funder_label: string | null
  /**
   * Where that name came from, e.g. "dune-spellbook@9f61b0d". This is the field
   * that separates a CONFIRMED identity from an INFERRED one: non-null means an
   * exact match against a named, pinned list; null on an exchange-class funder
   * means the behavioural heuristic fired and nobody has named the wallet.
   *
   * It does not change `class`, and `class` is what the score reads.
   */
  label_source: string | null
}

export type AttestedSignals = {
  age_days: number
  first_seen: string | null
  tx_count: number
  /** False when tx_count is a lower bound (the window) because /counters had no value. */
  tx_count_exact: boolean
  /** Collected and shown, weight zero: did not separate the reference set. */
  distinct_counterparties: number
  txs_24h: number
  txs_7d: number
  burst_ratio: number | null
  funding: AttestedFunding
}

export type AttestedEvidence = {
  chain_id: number
  /** Human-clickable link to the raw history the signals were read from. */
  blockscout_url: string
  /** Diversity and cadence are computed over this many of the last <= max transactions. */
  window: { size: number; max: number; capped: boolean }
  fetched_at: string
}

/** Everything that is signed. */
export type AttestationBody = {
  address: Address
  verdict: VerdictName
  /** Compliance gate fired: not "no track record", but "not allowed". */
  gated: boolean
  score: number
  summary: string
  reasons: string[]
  signals: AttestedSignals
  evidence: AttestedEvidence
  attester: Address
  issued_at: string
}

export type Attestation = AttestationBody & { signature: Hex }

const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/

/**
 * The signing account, from ATTESTER_PRIVATE_KEY. Throwaway by design: it signs
 * attestations, it never holds funds.
 */
export function attesterAccount(): PrivateKeyAccount {
  const key = process.env.ATTESTER_PRIVATE_KEY?.trim()
  if (!key || !PRIVATE_KEY_PATTERN.test(key)) {
    throw new ConfigError(
      'ATTESTER_PRIVATE_KEY is missing or not a 0x-prefixed 32-byte hex key. ' +
        'Generate a throwaway one with:\n' +
        `  node -e "import('viem/accounts').then(a => console.log(a.generatePrivateKey()))"\n` +
        'and put it in .env.',
    )
  }
  return privateKeyToAccount(key as Hex)
}

/** Recursively sort object keys. Arrays keep their order. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeysDeep(record[key])]),
    )
  }
  return value
}

/** Canonical JSON (RFC 8785): sorted keys, no whitespace. This is the signed message. */
export function canonicalize(body: AttestationBody): string {
  return JSON.stringify(sortKeysDeep(body))
}

/** signals + funding + verdict -> the body, in the wire format. Pure. */
export function buildAttestationBody(
  signals: Signals,
  funding: FundingProvenance,
  verdict: Verdict,
  attester: Address,
  issuedAt: string,
): AttestationBody {
  return {
    address: signals.address as Address,
    verdict: verdict.verdict,
    gated: verdict.gated,
    score: verdict.score,
    summary: verdict.summary,
    reasons: verdict.reasons,
    signals: {
      age_days: signals.ageDays,
      first_seen: signals.firstSeen,
      tx_count: signals.txCount,
      tx_count_exact: signals.txCountExact,
      distinct_counterparties: signals.distinctCounterparties,
      txs_24h: signals.txs24h,
      txs_7d: signals.txs7d,
      burst_ratio: signals.burstRatio,
      funding: {
        class: funding.class,
        source: funding.source,
        via: funding.via,
        first_inbound_at: funding.firstInboundAt,
        label: funding.label,
        funder_label: funding.funderLabel,
        label_source: funding.labelSource,
      },
    },
    evidence: {
      chain_id: Number(chainId()),
      blockscout_url: signals.blockscoutUrl,
      window: { size: signals.windowSize, max: WINDOW_MAX_TXS, capped: signals.windowIsCapped },
      fetched_at: signals.fetchedAt,
    },
    attester,
    issued_at: issuedAt,
  }
}

/**
 * Sign the body. The returned object is the canonical body (sorted keys) with
 * `signature` appended last, so serving it as-is keeps the verifiable order.
 */
export async function signAttestation(
  body: AttestationBody,
  account: PrivateKeyAccount,
): Promise<Attestation> {
  const message = canonicalize(body)
  const signature = await account.signMessage({ message })
  return { ...(JSON.parse(message) as AttestationBody), signature }
}

/**
 * Who signed this attestation. Same three lines as the README, so anyone can
 * see the check is real. Compare the result with the attester you trust.
 */
export async function recoverAttester(attestation: Attestation): Promise<Address> {
  const { signature, ...body } = attestation
  return recoverMessageAddress({ message: canonicalize(body), signature })
}
