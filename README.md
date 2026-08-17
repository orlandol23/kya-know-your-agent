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

```ts
import { paymentMiddleware } from 'x402-express'
import { kyaGate } from './src/gate.js'

app.use(kyaGate())                                          // 1. who is paying, what have they done
app.use(paymentMiddleware(payTo, { 'GET /chem': { price: '$0.001', network: 'base-sepolia' } }))
app.get('/chem', handler)                                   // 3. served only past both
```

The order is the mechanism: x402-express settles only after the handler answers
2xx, and it never runs if the gate answered first. The gate reads
`payload.authorization.from` from the `X-PAYMENT` header and does not check
the signature over it; the payment middleware does, so a forged `from` fails
there and never settles. Requests without a payment header pass through so the
client can receive the 402 with the payment requirements.

A refusal carries the reason and the signed attestation, so the refused agent
can verify the claim against Blockscout itself:

```jsonc
HTTP/1.1 403 Forbidden
X-KYA-Verdict: suspicious

{ "error": "KYA gate: payer refused before settlement",
  "verdict": "suspicious", "gated": false, "score": 0,
  "reason": "no track record to speak of: score 0 at or below 84",
  "reasons": ["no inbound transfer ever: nothing funded this wallet", "..."],
  "payer": "0x8b00...C54f",
  "evidence": "https://base.blockscout.com/address/0x8b00...C54f",
  "attestation": { "...": "the signed attestation above" } }
```

`gated: true` means the compliance gate fired (OFAC SDN, known mixers): the
address was not scored, it was blocked. If reputation cannot be read the gate
fails closed with 503, still before settlement.

## Try it

    cp .env.example .env    # Blockscout Pro key + throwaway attester key
    npm i
    npx tsx src/cli.ts 0xYourAddress                     # verdict, score, why, signature
    npx tsx src/cli.ts --offline 0x2CfF890f0378a11913B6129B2E97417a2c302680   # no network, no key (see Offline mode)
    npx tsx src/server.ts                                # GET /verify + the demo UI at /
    curl "localhost:3000/verify?address=0xYourAddress"
    open http://localhost:3000/                          # two agents side by side

The UI is one static file (`ui/index.html`, no build, no dependency): two
panels, each with an address field and one-click demo agents. Per panel it
shows the verdict, **the reason in text**, the score against the calibrated
cutoffs, the three weighted axes, the collected-but-unscored signals, and the
Blockscout evidence link. It calls `/verify?address=…&explain=1`, which returns
`{ attestation, breakdown }`: the same signed attestation plus the unsigned
score arithmetic (axes, weights, penalty, confidence, cutoffs) so the screen
can draw why the score is what it is. Bookmark `/?a=0x…&b=0x…` to preload both.

The demo, two terminals. Reputation is read from Base mainnet; the payment
runs on Base Sepolia with the same address:

    npx tsx demo/paid-endpoint.ts                        # seller: paid endpoint behind the gate
    npx tsx demo/agents.ts                               # buyers: established wallet 200, fresh wallet 403

By default settlement is **simulated**: x402-express runs for real but is
pointed at a stub facilitator inside the endpoint process, so no testnet funds
are needed. The fresh agent is a real `x402-fetch` client (a zero-balance
wallet can still sign); the established agent sends a synthetic `X-PAYMENT`
header because its key is not ours. Add `--real` to both commands to settle
through `x402.org/facilitator`; then set `DEMO_ESTABLISHED_PRIVATE_KEY` to a
wallet with history holding Sepolia USDC, and `DEMO_PAY_TO` to your address.

## Offline mode: fixtures are dated captures of live addresses

Blockscout answered 500 for 23 of 30 addresses seven days before the pitch, so
the demo does not depend on it being up:

    npx tsx scripts/capture.ts                 # reads Blockscout NOW, writes data/fixtures/<address>.json
    npx tsx src/cli.ts --offline 0x2CfF...     # replays the fixture, no network, no Blockscout key
    npx tsx src/server.ts --offline            # every request replays data/fixtures/
    npx tsx demo/paid-endpoint.ts --offline    # the gate replays too (pair with demo/agents.ts --offline)

`data/fixtures/` holds four committed captures: the three demo cases (established
`0x2CfF…2680`, fresh exchange-funded `0xBEab…2787`, OFAC-listed `0x098b…2f96`)
and one address with zero transactions (`0xeB94…6B97`, generated locally, key
discarded). **They are not synthetic cases.** Each file is what Blockscout
returned for a live address at the instant in its `captured_at`; the addresses
have kept living since, so a live read can differ. An attestation replayed from
a fixture has the same format and signature as a live one and carries the
capture instant as `evidence.fetched_at`, next to a fresh `issued_at`, so any
consumer can tell a replay from a fresh read. Responses also say
`X-KYA-Source: live | cache | fixture`.

The same file format is the live mode's 10-minute cache (`data/cache/`,
gitignored): a fixture is a cache entry that was kept. A live server also
honours `?offline=1` per request, and the UI has an *offline* toggle, so the
demo flips to fixtures without a restart. In offline mode an address without a
fixture is a 404 (a 503 at the gate), never a silent fallback to stale data.

Failure modes checked: zero-transaction address (suspicious, score 0), invalid
address (400), Blockscout answering 500 (502 after one retry, ~1 s), Blockscout
hanging (each call times out at 8 s; 2 attempts, so ~17 s before the 502). The
retry budget is sized for a live demo; a longer outage is what `--offline` is for.

## Deliberately not in v0.1

No LLM. No agent: this is the verification primitive, not a wallet with a
chatbot. Roadmap, in order: labelled-contract signal, a user rating layer where
only addresses that actually paid an agent can rate it, ecosystem familiarity,
an EIP-712 attestation a Solidity contract can consume, and a ZK credential
binding an agent to its principal.

Built solo in 14 days for the Borderless Web3 hackathon (Aug 2026).
