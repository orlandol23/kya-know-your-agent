/**
 * address -> signed attestation. The one pipeline the CLI, the server and the
 * x402 gate all call, so there is exactly one place where "verify" is defined.
 *
 *   parse -> load history -> signals + funding -> score -> verdict -> attest
 *
 * Only the load touches the network, and in offline mode not even that: it
 * replays a committed fixture (see history.ts). Everything after it is pure
 * and deterministic: same history in, same attestation body out (modulo
 * issued_at).
 */

import { getAddress, isAddress, type Address } from 'viem'

import {
  buildAttestationBody,
  signAttestation,
  attesterAccount,
  type Attestation,
} from './attest.js'
import { requireApiKey } from './blockscout.js'
import { deriveFunding, type FundingProvenance } from './funding.js'
import { isOffline, loadHistory, type HistorySource } from './history.js'
import { scoreAddress, type ScoreBreakdown } from './score.js'
import { deriveSignals, type Signals } from './signals.js'
import { decide, type Verdict } from './verdict.js'

/** The input was not an address. A 400, not a 500. */
export class InvalidAddressError extends Error {
  readonly input: string

  constructor(input: string) {
    super(input === '' ? 'address is required' : `not a valid address: ${input}`)
    this.name = 'InvalidAddressError'
    this.input = input
  }
}

/** The attestation plus every intermediate the CLI shows and the gate reads. */
export type Verification = {
  address: Address
  /** live = read from Blockscout now, cache = read < 10 min ago, fixture = committed dated capture. */
  source: HistorySource
  /** When the chain was read. Equals attestation.evidence.fetched_at. */
  capturedAt: string
  signals: Signals
  funding: FundingProvenance
  breakdown: ScoreBreakdown
  verdict: Verdict
  attestation: Attestation
}

/** Checksummed address or InvalidAddressError. Case-insensitive on the way in. */
export function parseAddress(input: unknown): Address {
  const text = typeof input === 'string' ? input.trim() : ''
  if (!isAddress(text, { strict: false })) throw new InvalidAddressError(text)
  return getAddress(text)
}

/**
 * Fail on configuration before the first request, with the actionable message,
 * instead of on the first request with a confusing one. Entry points call it
 * once at startup.
 */
export function requireVerifyConfig(): void {
  // Offline mode never calls Blockscout, so a clone without a key can still replay.
  if (!isOffline()) requireApiKey()
  attesterAccount()
}

export type VerifyOptions = {
  /** Replay a committed fixture instead of reading Blockscout. Defaults to KYA_OFFLINE=1. */
  offline?: boolean
}

export async function verify(input: unknown, options: VerifyOptions = {}): Promise<Verification> {
  const address = parseAddress(input)
  const account = attesterAccount()

  const { history, source, capturedAt } = await loadHistory(address, options)
  const signals = deriveSignals(history)
  const funding = deriveFunding(history)
  const breakdown = scoreAddress(signals, funding)
  const verdict = decide(breakdown)

  const body = buildAttestationBody(signals, funding, verdict, account.address, new Date().toISOString())
  const attestation = await signAttestation(body, account)

  return { address, source, capturedAt, signals, funding, breakdown, verdict, attestation }
}
