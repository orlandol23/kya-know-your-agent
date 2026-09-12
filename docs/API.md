# KYA · API

The public surface is one endpoint and one static page:

    GET /verify?address=0x…     a signed attestation, or a structured error
    GET /                       the split-screen demo UI

Base URL for the hosted deployment:
`https://kya-know-your-agent-production.up.railway.app` — no key, no account.
Run locally with `npm run start:offline` and `http://localhost:3000`.

This document is the contract as of the code on this branch. Where it and
[`src/server.ts`](../src/server.ts) disagree, the code holds.

## GET /verify

### Parameters

| Parameter | Required | Meaning |
|---|---|---|
| `address` | yes | the address to verify, `0x`-prefixed. An invalid address answers `400` before any network call. |
| `explain` | no | `explain=1` returns the same signed attestation plus the unsigned score arithmetic (`breakdown`). |
| `offline` | no | `offline=1` replays the committed fixture for this one request and never touches the network, whatever mode the server runs in. This is how the demo UI flips to fixtures without a restart. |

### Response headers

Every `200` carries:

| Header | Meaning |
|---|---|
| `X-KYA-Source` | which source answered: `live`, `cache` or `fixture`. Three different things — see [Sources](#sources). |
| `Cache-Control: no-store` | every answer is point-in-time; nothing in between should cache it. |

A `200` served from a replay also carries one of:

| Header | Meaning |
|---|---|
| `X-KYA-Degraded: budget` | the day's budget of live reads is spent; a committed capture or cache entry stood in. |
| `X-KYA-Degraded: upstream` | the data provider failed; a committed capture or cache entry stood in. |

A `429` from the per-IP limit carries `RateLimit`, `RateLimit-Policy` and
`Retry-After` (seconds until that IP's one-minute window reopens). A `429` for
the spent budget carries `Retry-After`, counting down to 00:00 UTC.

### 200 · the attestation

snake_case, every field always present (`null` over `undefined`), keys in
canonical order (RFC 8785: sorted recursively, no whitespace), `signature`
last. The values below are from the committed fixture for `0xeA25…9F04`,
captured 2026-08-21; `…` marks where a real response carries longer values:

```jsonc
{
  "address":   "0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04",
  "attester":  "0x…",                                  // discovery only; YOU pin whose signature you trust
  "evidence":  {
    "chain_id": 8453,
    "blockscout_url": "https://base.blockscout.com/address/0xeA25…9F04",
    "window":  { "size": 150, "max": 150, "capped": true },
    "fetched_at": "2026-08-21T12:23:39.247Z"           // when the chain was actually read
  },
  "gated":     false,                                  // true: the compliance gate fired; blocked, not scored low
  "issued_at": "2026-08-21T12:23:45.118Z",             // when this attestation was signed
  "reasons":   [
    "funded by Binance 76 (0x3304e22d…7b566a), identity confirmed against dune-spellbook@9f61b0d",
    "…"
  ],
  "score":     857,                                    // 0–1000
  "signals":   {
    "age_days": 662.73,
    "first_seen": "…",
    "tx_count": 51666,
    "tx_count_exact": true,                            // false: the counter came back cold; the window size is a floor
    "distinct_counterparties": 2,                      // collected and shown, weight zero: did not separate the reference set
    "txs_24h": 150,
    "txs_7d": 150,
    "burst_ratio": 4.5,                                // enters the score only as a burst penalty
    "funding": {
      "class": "exchange",                             // exchange | unknown | none | mixer | sanctioned
      "source": "0x3304e22d…7b566a",                   // the first inbound funder, or null
      "via": "native",                                 // native | token | null
      "first_inbound_at": "…",
      "label": "…",
      "funder_label": "Binance 76",                    // the exchange's own name for the funder, or null
      "label_source": "dune-spellbook@9f61b0d"         // non-null: confirmed against a named, pinned list; null on an exchange-class funder: inferred, unnamed
    }
  },
  "summary":   "established track record: score 857 at or above 193",
  "verdict":   "trusted",                              // trusted | unknown | suspicious
  "signature": "0x80b15b6b…b1d82c1c"                   // EIP-191 over everything above
}
```

**What the score means, and what it does not.** The score summarizes the
address's observed Base history. It does not prove identity, intent, solvency
or compliance. `gated: true` is a sanctions/mixer block, not a low score; a
score of 0 can mean "nothing to read" as easily as "read and refused". The
attestation is point-in-time: `issued_at` says when it was signed,
`evidence.fetched_at` when the chain was read. There is no expiry field; the
consumer sets its own freshness policy.

**Verifying it, without calling KYA again:**

```ts
const { signature, ...body } = attestation
const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
if (signer !== ATTESTER_YOU_PIN) throw new Error('not signed by the attester you trust')
```

The body is served in canonical order, so `JSON.stringify` of the parsed body
reproduces the signed bytes. In Python:
`json.dumps(body, sort_keys=True, separators=(',', ':'))`.

### 200 · `explain=1`

```jsonc
{
  "attestation": { "…": "the signed attestation above" },
  "breakdown": {
    "axes": {
      "funding":  { "value": …, "normalized": …, "weight": 0.40 },
      "maturity": { "value": …, "normalized": …, "weight": 0.35 },
      "volume":   { "value": …, "normalized": …, "weight": 0.25 }
    },
    "geometric_mean": …,
    "penalty": …,
    "confidence": …,
    "evidence_mass": …,
    "scale": 1000,
    "cutoffs": { "suspicious_max": 84, "trusted_min": 193 }
  },
  "source": "fixture",               // same value the X-KYA-Source header carries
  "captured_at": "2026-08-21T12:23:39.247Z"
}
```

`breakdown` is **unsigned and derivable**: it is the arithmetic behind
`score = scale · geometric_mean · penalty · confidence`, with enough detail to
recompute the score by hand. Verify the attestation first; the breakdown
explains it.

### Status codes

Only a `200` carries an attestation.

| Status | When | Body |
|---|---|---|
| `200` | answered, from whichever source | the attestation, or the `explain` envelope |
| `400` | `address` missing or not a valid EVM address | `{ "error": "…", "usage": "/verify?address=0x..." }` — refused before any network call |
| `404` | a replay was asked for (offline mode or `?offline=1`) and no fixture or cache entry exists for the address | `{ "error": "…", "offline": true, "fixtures": [ …the addresses that do have fixtures ] }` |
| `429` | per-IP limit (`"reason": "rate"`) or the day's budget spent with nothing to replay (`"reason": "budget"`) | rate: `{ "error": "too many verifications from this address in the last minute", "reason": "rate", "retry_after_seconds": 60 }`; budget: `{ "error": "…", "reason": "budget", "fixtures": [ … ] }` plus `Retry-After` |
| `502` | the data provider failed and there is nothing to replay | `{ "error": "upstream: …" }`, carrying the provider's real message |
| `500` | an unexpected error | `{ "error": "internal error" }` |

## Sources

Three sources can answer a request, and the response always names the one that
did (`X-KYA-Source`). They are **not** the same kind of answer:

- **`live`** — read from the data provider (Blockscout Pro, Base mainnet,
  chain 8453) during this request, behind a 10-minute per-address cache.
- **`cache`** — a previous live read, replayed from the cache file. On the live
  path a cache entry is at most 10 minutes old; on the replay path (a degraded
  answer, or `?offline=1`) an entry of **any age** can answer rather than fail.
- **`fixture`** — a committed, dated capture in `data/fixtures/`. What the
  service replays when a live read is impossible (provider outage, budget
  spent) or when running offline.

Interpretation rules a consumer can rely on:

1. A replay is never silent: `X-KYA-Source` says which source answered, and
   `X-KYA-Degraded` says why a live read did not.
2. `evidence.fetched_at` carries the instant the chain was actually read. A
   replay cannot pass itself off as a fresh read even if a caller ignores both
   headers.
3. Freshness is the consumer's policy. A consumer that needs data younger than
   some threshold should read `evidence.fetched_at` and refuse anything older;
   the API will not decide that for it.

## Limits

For the hosted deployment as currently configured (a self-hosted deployment
sets its own values; see `.env.example`):

- **`KYA_DAILY_VERIFY_BUDGET` (default 500)** — how many verifications a day
  may actually reach the data provider. Only reads that reach it are charged; a
  cache hit costs nothing. Past the budget the service keeps answering from
  fixtures or cache and says so in the headers, or answers `429` when nothing
  is available to replay. `0` means never read live.
- **`KYA_VERIFY_RATE_LIMIT_PER_MIN` (default 30)** — `GET /verify` requests per
  source IP per minute. It runs before the budget check, so a rate-limited
  request is never charged against the budget. `0` disables the per-IP limit.

## For sellers embedding the gate

`kyaGate()` is the same verification as Express middleware inside a seller's
own process: `403` with the signed attestation in the body for `suspicious`,
`X-KYA-Verdict: trusted | unknown` on pass, `503` (fail-closed) when the data
source is unavailable. It does not degrade: it refuses before settlement rather
than answer from older evidence. The full flow, including what each step
trusts, is in [`ARCHITECTURE.md`](ARCHITECTURE.md).

