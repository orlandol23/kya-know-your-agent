# KYA — Know Your Agent

**On-chain reputation for AI agents that pay through x402.**

AI agents already buy services with stablecoins over x402 (7M+ transactions as
of Aug 2026). The seller sees a valid payment and nothing else: no history, no
way to tell an established agent from a wallet created five minutes ago. Even
x402's own explorer only indexes the seller side.

KYA answers the missing question: **who is this agent, and what has it done?**

## What it does

    GET /verify?address=0x...

Returns a signed attestation:

```jsonc
{
  "address":   "0xf7256eD518fa3A8b1dDb2bBb0Cd0071617df7bF4",
  "verdict":   "trusted",              // trusted | unknown | suspicious
  "gated":     false,                  // compliance gate (OFAC SDN, known mixers): "not allowed", not "no history"
  "score":     354,                    // 0..1000
  "summary":   "established track record: score 354 at or above 193",
  "reasons":   ["1129 days old (full credit at 532.09, none below 3.03)", "..."],
  "signals":   { "age_days": 1128.76, "tx_count": 710, "distinct_counterparties": 56,
                 "txs_24h": 0, "txs_7d": 5, "burst_ratio": 173.67,
                 "funding": { "class": "unknown", "source": "0x921e...1fef", "via": "token", "..." : "..." },
                 "...": "..." },
  "evidence":  { "chain_id": 8453,
                 "blockscout_url": "https://base.blockscout.com/address/0xf725...7bF4",
                 "window": { "size": 150, "max": 150, "capped": true },
                 "fetched_at": "2026-08-16T11:10:48.592Z" },
  "attester":  "0xCEFEDCf160e8065ce82B949A0dFc777BD2E2Cd8C",
  "issued_at": "2026-08-16T11:10:48.594Z",
  "signature": "0xb3716c5c...222b1b"   // EIP-191 over everything above
}
```

- **Deterministic.** Signals from the agent's Base history: age, volume,
  counterparty diversity, recent cadence, and funding provenance. Combined
  with a weighted geometric mean, so a weak axis cannot be compensated by a
  strong one. No LLM anywhere in the pipeline.
- **Calibrated, not invented.** Thresholds are derived from a labeled reference
  set of 30 real addresses. `scripts/calibrate.ts` reproduces every number.
  Two of the five signals (diversity, cadence) did not separate the set and
  carry weight zero; they are still reported as evidence.
- **Verifiable without trusting this API.** `evidence` links to the raw history
  on Blockscout. `signature` is EIP-191; any service checks it in 3 lines:

  ```ts
  import { recoverMessageAddress } from 'viem'

  const { signature, ...body } = await (await fetch(`${KYA}/verify?address=${agent}`)).json()
  const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
  if (signer !== KYA_ATTESTER) throw new Error('not signed by KYA')   // pin the attester you trust
  ```

  The signed message is the attestation without `signature`, as canonical JSON
  (RFC 8785: keys sorted recursively, no whitespace). The API serves it already
  in that order, which is why `JSON.stringify` of the parsed body is enough in
  JavaScript. In Python it is `json.dumps(body, sort_keys=True, separators=(',', ':'))`;
  the two produce identical bytes. The attester address is printed when the
  server starts and echoed in `attester` for discovery, but a consumer decides
  which attester to trust, not the payload.

  Attestations are point-in-time. `issued_at` says when; consumers decide their
  own freshness policy.

## The gate

`kyaGate` is x402 middleware. It reads the payer address from the payment
header and blocks `suspicious` agents with 403 **before settlement**: the
rejected agent pays nothing, the seller risks nothing. `unknown` passes with
an `X-KYA-Verdict` header; blocking it is the seller's choice.

## Try it

    cp .env.example .env    # Blockscout Pro key + throwaway attester key
    npm i
    npx tsx src/cli.ts 0xYourAddress                     # verdict, score, why, signature
    npx tsx src/server.ts                                # GET /verify
    curl "localhost:3000/verify?address=0xYourAddress"

## Deliberately not in v0.1

No LLM. No agent: this is the verification primitive, not a wallet with a
chatbot. Roadmap, in order: labelled-contract signal, a user rating layer where
only addresses that actually paid an agent can rate it, ecosystem familiarity,
an EIP-712 attestation a Solidity contract can consume, and a ZK credential
binding an agent to its principal.

Built solo in 14 days for the Borderless Web3 hackathon (Aug 2026).
