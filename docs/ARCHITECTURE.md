# KYA — System design

> Written for the question asked in the Q&A: *"I felt a little bit hard to
> understand the internal workflow of the application. If you have a high ground
> vision of the architecture, like a simple system design."*
>
> Clarity over completeness. Every number and path below is read from the
> committed code, not recalled. This document is the map; the code is the
> territory, and each section names the file it is describing.

**Contents**

1. [One paragraph](#1-one-paragraph)
2. [End to end: agent → gate → payment → handler → settlement](#2-end-to-end-agent--gate--payment--handler--settlement)
3. [Inside the gate](#3-inside-the-gate)
4. [Where each piece of data comes from](#4-where-each-piece-of-data-comes-from)
5. [On-chain versus off-chain](#5-on-chain-versus-off-chain)
6. [Stateless, and what happens when it falls over](#6-stateless-and-what-happens-when-it-falls-over)
7. [Glossary](#7-glossary)

---

## 1. One paragraph

KYA is one Express middleware, `kyaGate()`, that a seller mounts **in front of**
the x402 payment middleware they already run. When a paying agent arrives, the
gate reads the payer address out of the payment envelope, reads that address's
history on Base, scores it, and either refuses the request with `403` or lets it
through to the payment middleware. Because it sits in front, a refusal happens
**before settlement**: the refused agent pays nothing and the seller risks
nothing. The same pipeline is exposed as `GET /verify?address=0x…`, which returns
a signed attestation anyone can check without calling KYA again.

---

## 2. End to end: agent → gate → payment → handler → settlement

There are two round trips, because that is how x402 works: the first request
learns the price, the second one carries the payment.

### The eight steps, in order

Time order, not middleware order. The diagram below numbers the middlewares in
the order they are *mounted*; this is the order things actually happen in.

1. **The agent asks for the resource and offers no payment.** `GET /chem`, no
   `X-PAYMENT` header.
2. **The gate lets it through.** There is no payer named yet, so there is nothing
   to check and nothing to refuse. `src/gate.ts` calls `next()`.
3. **The payment middleware quotes a price.** `402 Payment Required`, saying what
   to pay, in what token, on what network. This is how an x402 client discovers
   the price; it is not an error.
4. **The agent signs a payment and asks again.** It signs an EIP-3009
   authorization offline — no gas, no funds moved, so even a zero-balance wallet
   can do it — and repeats `GET /chem` with the signed payload in `X-PAYMENT`.
5. **The gate names the payer and checks it.** It decodes the header, takes
   `payload.authorization.from`, and runs the full verification on that address:
   read the Base history, derive the signals, apply the compliance gate, score,
   decide, sign an attestation. Six HTTP calls to Blockscout, a second or two.
6. **If the verdict is `suspicious`, the gate answers `403` here and stops.**
   The reason and the signed attestation go in the body. The payment middleware
   never runs, so **nothing settles and the agent pays nothing** — it signed a
   payment that was never taken.
7. **Otherwise the request continues.** The payment middleware now verifies the
   payment signature itself (which is why the gate did not have to), and the
   handler runs and produces the response body.
8. **Settlement happens last.** Only after the handler answers `2xx` does the
   payment middleware ask the facilitator to submit the transfer on-chain. The
   `200` goes back with `X-PAYMENT-RESPONSE`.

The whole design is step 6 landing before step 8.

### Where each piece runs

Six files. Four of them are processes you start; the other two are a static
file and a middleware that runs inside somebody else's process:

| Piece | File | What it is | Port | Hosted? |
|---|---|---|---|---|
| Verification API | `src/server.ts` | `GET /verify`, plus it serves the UI | `PORT`, 3000 locally; Railway injects its own | **Hosted on Railway** |
| Demo UI | `ui/index.html` | one static file, no build, no dependency; served at `/` by `src/server.ts` | same process | **Hosted on Railway** |
| The gate | `src/gate.ts` | **not a process** — Express middleware a seller mounts inside their own app | none of its own | ships as code, runs wherever the seller runs |
| Demo seller | `demo/paid-endpoint.ts` | the paid endpoint: `kyaGate()` → `paymentMiddleware()` → `GET /chem`, plus a stub facilitator in the same process | `DEMO_PORT`, 4021 | **local only** |
| Demo buyers | `demo/agents.ts` | two x402 clients — established and fresh — against that endpoint | client, no port | **local only** |
| Terminal verify | `src/cli.ts` | one address in, the whole pipeline printed | none | **local only** |

**Why the demo is not hosted.** It is two processes plus a payment facilitator,
and it settles on Base Sepolia. Hosting it would mean hosting a wallet with
testnet funds and a seller nobody sells anything to. The hosted URL is the
read-only half — `GET /verify` and the UI — which is the half a reviewer can
actually poke at. The gate is the interesting half, and it is 152 lines of
`src/gate.ts` plus the two demo files, meant to be run locally in two terminals.

### The same path as a diagram

```
  AGENT (buyer)                SELLER'S PROCESS                          CHAIN / OFF-CHAIN
                    ┌────────────────────────────────────────────┐
   GET /chem   ─────┼──► [1] kyaGate()                           │
   (no payment)     │         no X-PAYMENT header → next()        │
                    │             │                              │
                    │             ▼                              │
                    │     [2] paymentMiddleware (x402-express)    │
   402  ◄───────────┼─────────────┘  "$0.001 USDC on base-sepolia"│
                    │                                            │
   ── signs an EIP-3009 authorization offline, retries ──         │
                    │                                            │
   GET /chem   ─────┼──► [1] kyaGate()                           │
   X-PAYMENT: …     │         payer = payload.authorization.from  │
                    │         verify(payer) ─────────────────────┼──► Blockscout Pro
                    │             │                              │    (Base mainnet, 8453)
                    │             │                              │
                    │      suspicious │ unknown / trusted        │
                    │        (or gated)│                         │
   403 ◄────────────┼─────────────┘   │  X-KYA-Verdict: <verdict>│
   + reason         │                 │  next()                  │
   + attestation    │                 ▼                          │
                    │     [2] paymentMiddleware: VERIFY payment   │
                    │                 ▼                          │
                    │     [3] handler → 200 body                  │
                    │                 ▼                          │
                    │     [2'] paymentMiddleware: SETTLE ────────┼──► USDC transfer
   200 ◄────────────┼──── + X-PAYMENT-RESPONSE                   │    (x402 facilitator)
                    └────────────────────────────────────────────┘

   ══ the 403 exits here ══════════════════════════════════════► NOTHING SETTLES
```

**Why the 403 lands before settlement.** It is middleware ordering, not a
promise:

```ts
app.use(kyaGate())                          // 1. who is paying, and what have they done
app.use(paymentMiddleware(payTo, { … }))    // 2. verify the payment, settle AFTER the handler
app.get('/chem', handler)                   // 3. served only past both
```

`x402-express` settles only after the handler answers `2xx`, and it never runs
at all if the gate answered first. So a gate `403` means no settle call is ever
made. The demo shows exactly this: the fresh wallet signs a real payment (signing
is offline, a zero-balance wallet can do it) and is refused before any USDC
moves.

**Three things the gate deliberately does not do:**

| Situation | What the gate does | Why |
|---|---|---|
| No `X-PAYMENT` header | `next()` | There is no payer to check yet. The payment middleware must be allowed to answer `402` with the price, which is how the client learns what to pay. |
| Header present, no decodable payer | `next()` | The gate never invents a verdict for a payer it cannot name. The payment middleware rejects it as malformed. |
| Payer present | Reads `payload.authorization.from` **without checking the signature over it** | The payment middleware behind it does check. A forged `from` fails there and never settles, so the only address that can be charged is the one that signed. Duplicating the check buys no security and costs a crypto dependency in the hot path. |

**Verdict handling:** only `suspicious` blocks. `trusted` and `unknown` both pass
through with an `X-KYA-Verdict` header, and the gate stores the full verification
on `res.locals.kya` for the handler. Blocking `unknown` is the seller's policy
call, not KYA's — the header hands that decision to whoever has to make it.

---

## 3. Inside the gate

Everything below happens inside one call to `verify()` (`src/verify.ts`), which
is also what `GET /verify` and the CLI call. There is exactly one definition of
"verify" in the codebase.

```
   X-PAYMENT header (base64 JSON)
        │  payerFromPaymentHeader()                              gate.ts
        ▼
   payer 0x…
        │
   ┌────┴──── verify(payer) ───────────────────────────────────  verify.ts ──┐
   │                                                                         │
   │  loadHistory()                    the ONLY seam that touches I/O   history.ts
   │     live    ─► 6 HTTP requests to Blockscout Pro  ──────────────  blockscout.ts
   │     cache   ─► data/cache/<addr>.json, if < 10 min old                  │
   │     fixture ─► data/fixtures/<addr>.json  (offline mode, no network)    │
   │        │                                                                │
   │        ▼  ═══════ everything below is PURE and DETERMINISTIC ═══════    │
   │                                                                         │
   │  deriveSignals()  ── the 4 signals ───────────────────────────  signals.ts
   │        age · volume · diversity · cadence (+ burst_ratio)               │
   │                                                                         │
   │  deriveFunding()  ── who paid for this wallet to exist ───────  funding.ts
   │        first inbound → OFAC → mixer → CEX label list → heuristic        │
   │        │                                                                │
   │        ▼                                                                │
   │  scoreAddress()                                                 score.ts │
   │     ┌── COMPLIANCE GATE (binary, runs first, wins) ──┐                  │
   │     │  address itself on OFAC SDN?                   │ → score 0        │
   │     │  funder is a mixer or sanctioned?              │   gated: true    │
   │     └────────────────────────────────────────────────┘                  │
   │     else:  score = 1000 · G · penalty · confidence                      │
   │        │                                                                │
   │        ▼                                                                │
   │  decide()                                                     verdict.ts │
   │        ≤ 84 suspicious  ·  85–192 unknown  ·  ≥ 193 trusted             │
   │        │                                                                │
   │        ▼                                                                │
   │  buildAttestationBody() → signAttestation()                    attest.ts │
   │        canonical JSON (RFC 8785) → EIP-191 signature                    │
   └─────────────────────────────────────────────────────────────────────────┘
        │
        ├─► suspicious (incl. gated) → 403 + reason + signed attestation
        └─► unknown / trusted        → next() + X-KYA-Verdict
```

### 3.1 The 6 calls

One verify costs a **constant 6 HTTP requests** to Blockscout Pro, no matter how
large the address is (7 when the counter comes back cold, see below). All six are
issued together inside `fetchAddressHistory()`:

| # | Call | Route | Requests | Feeds |
|---|---|---|---|---|
| 1 | `fetchEarliestTransactions` | `…&action=txlist&sort=asc&page=1&offset=10` | 1 | **age** (the oldest tx dates the account) + funding |
| 2 | `fetchTransactionWindow` | `…&action=txlist&sort=desc&page=1..3&offset=50` | **3** | the ≤ 150-tx window → **diversity** + **cadence** |
| 3 | `fetchCounters` | `/8453/api/v2/addresses/{addr}/counters` | 1 | **volume** (lifetime transaction count) |
| 4 | `fetchEarliestTokenTransfers` | `…&action=tokentx&sort=asc&page=1&offset=10` | 1 | **funding** fallback, for wallets with zero transactions |

Two details that matter in practice:

- **Pacing.** Every request passes through a process-wide slot queue capped at
  4 starts per rolling second, one under the free tier's 5/s. So a live verify is
  really *4 requests, a ~1 s pause, then 2*. Two UI panels verifying at once queue
  for ~3 s instead of tripping a `429`.
- **The cold counter.** Blockscout computes `/counters` lazily: a cold address can
  answer `0` while the true count is in the thousands. The window is a subset of
  all transactions, so a count *below* the window size is proof the counter is
  cold → one re-read (the 7th request). If it is still inconsistent, `signals.ts`
  reports the window as a lower bound and sets `tx_count_exact: false` rather than
  publishing a number known to be wrong.

The public explorer `base.blockscout.com` is **never called**. It appears only as
a string, `evidence.blockscout_url`, so a human can click through to the raw
history.

### 3.2 The 4 signals

| Signal | What it measures | Read from | Weight |
|---|---|---|---|
| **age** (`age_days`) | days since the oldest transaction | call 1 | 0.35 (as *maturity*) |
| **volume** (`tx_count`) | lifetime transaction count | call 3 | 0.25 |
| **diversity** (`distinct_counterparties`) | distinct counterparties in the window | call 2 | **0** |
| **cadence** (`txs_24h`, `txs_7d`, `burst_ratio`) | recent activity and how bursty it is | call 2 | **0**, except as a penalty |

Diversity and cadence carry weight zero because the calibration measured that
they **do not separate** the reference set: diversity because the established
stratum contains old single-counterparty bots, cadence because it *inverts* —
fresh bot wallets fire 150 transactions in a day while established addresses go
quiet, so it measures current activity, not track record. The stratum was not
recomposed to fix either number; that would have been picking the sample by the
result. Both are still collected and shown in the attestation, at declared weight
zero. Cadence re-enters only as a multiplicative penalty.

The scored axes are three: **funding, maturity, volume**. Funding is not a
"signal" read from a counter — it is a *classification* of who sent the first
inbound transfer.

### 3.3 The compliance gate

Binary, separate from the score, and it runs **before** any arithmetic:

```
   1. is this address itself on the OFAC SDN list?      → gated
   2. is the funder a known mixer, or OFAC-listed?      → gated
   ─────────────────────────────────────────────────────────────
   gated  ⇒  score 0, gated: true, verdict "suspicious",
             gateReason names the matching entry
```

Being listed beats being funded by someone listed, so the address itself is
checked first. A gated address is reported `suspicious` **and** `gated`, so a
consumer that reads only the verdict still blocks it, while one that reads both
can tell *"no track record"* from *"not allowed"* — two different refusals that
would be indistinguishable if the gate were just a low score.

The two lists behind it are not the same kind of obligation, and the code says
so: the OFAC SDN list is a legal requirement; the mixer denylist is this
project's own policy choice, since Tornado Cash left the SDN list in March 2025
and no sanctions regime obliges it.

### 3.4 The score

```
   score = 1000 · G · penalty · confidence

   G          = ∏ max(sₖ, EPS) ^ wₖ         weighted geometric mean, computed in log space
   sₖ         = clamp((x − ZERO) / (FULL − ZERO), 0, 1)      per axis
   EPS        = 0.02                        floor, so a weak axis dampens instead of annihilating
   penalty    = 0.85 if burst_ratio > 50, else 1
   confidence = window_size / (window_size + 25)
```

| Axis | Weight | ZERO → FULL | Why that weight |
|---|---|---|---|
| funding | 0.40 | not normalized — `FUNDING_LEVEL` is already 0..1: exchange 1.0, unknown 0.35, none 0.05 | most expensive signal to forge: the first inbound names a real counterparty, and a custodial one has a KYC record behind it |
| maturity | 0.35 | 3.03 → 532.09 days | forged only by waiting |
| volume | 0.25 | 54.75 → 2236.25 transactions | forged cheaply with self-sends |

**Geometric, not a sum**, so a weak axis cannot be bought back with a strong one:
an agent funded from nowhere cannot compensate with volume. With a sum it could.

**Confidence is the honest half.** A wallet with almost no history scores low
because there is not enough evidence to say anything, not because it was judged
badly — and when confidence drops below 0.5 the attestation says exactly that in
its `reasons`: *"Scoring low for lack of data, not for bad behaviour."*

The thresholds and cutoffs are **MEASURED** — output of `scripts/calibrate.ts`
over the committed 30-address reference set in `data/signals.csv`. The weights,
`EPS`, the confidence constant, the funding levels and the burst penalty are
**CHOSEN** — argued, not measured. `src/config.ts` labels every constant as one
or the other in the file itself.

### 3.5 The verdict, and the two demo cases side by side

```
   suspicious ≤ 84   <   unknown   <   193 ≤ trusted
                     └── 109 points of empty gap ──┘
```

84 is the highest score any *fresh* address in the reference set reached; 193 the
lowest any *established* address reached. Nothing in the set lives in between,
which is the answer to "why 193 and not 150".

Both demo wallets are funded by the **same** confirmed exchange wallet, so the
funding axis is maxed for both. The entire difference is age and volume:

| | `0xeA25…9F04` | `0xBEab…2787` |
|---|---|---|
| funding | Binance 76, confirmed | Binance 76, confirmed |
| age | 662.73 days | 6.99 days |
| lifetime transactions | 51,666 | 42 |
| s_funding · s_maturity · s_volume | 1.000 · 1.000 · 1.000 | 1.000 · 0.007 · 0.000 |
| after the EPS floor | 1.000 · 1.000 · 1.000 | 1.000 · **0.02** · **0.02** |
| G | 1.000 | 0.02^0.6 ≈ 0.0956 |
| confidence | 0.86 | 42/(42+25) ≈ 0.627 |
| **score** | **857 → TRUSTED** | **60 → SUSPICIOUS** |

(Both from the committed fixtures captured 2026-08-21 12:23 UTC.)

### 3.6 The attestation

The body is snake_case, every field always present, `null` over `undefined`. It
is serialized as **canonical JSON — RFC 8785: keys sorted recursively, no
whitespace** — and signed **EIP-191** with a throwaway attester key that never
holds funds. The API serves the body already in canonical order, so in JavaScript
the check needs no library:

```ts
const { signature, ...body } = attestation
const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
if (signer !== KYA_ATTESTER) throw new Error('not signed by KYA')   // pin the attester you trust
```

The `attester` field is in the body for **discovery only**. A consumer decides
which attester it trusts; the payload does not get to decide that for it.

`issued_at` says when the attestation was signed; `evidence.fetched_at` says when
the chain was actually read. Attestations are point-in-time and carry no
expiry — consumers set their own freshness policy from those two timestamps.

---

## 4. Where each piece of data comes from

| Data | Source | How it is pinned | Touched per verify |
|---|---|---|---|
| Address history: age, lifetime count, tx window, token transfers | **Blockscout Pro API**, `api.blockscout.com`, Base mainnet chain 8453, key-gated (`Authorization: Bearer`) | live read, or a ≤ 10-min cache entry, or a committed dated fixture | 6 HTTP requests (7 if the counter is cold) |
| Sanctions | **OFAC SDN list** — every entry with idType `Digital Currency Address - ETH` | static map in `src/sanctions.ts`; publication date **2026-08-07**, 100 unique addresses extracted 2026-08-16, of which 15 have activity on Base | 0 requests (in-process lookup) |
| Exchange identity of a funder | **Dune Spellbook**, model `cex_evms.addresses` | commit `9f61b0d` (2026-01-28), **4,957 addresses across 328 exchanges**, committed as `data/cex-addresses-evm.json`, rebuildable byte-for-byte by `scripts/build-cex-labels.ts`. Licence: BUSL 1.1, Dune Analytics AS, Change Date 2027-03-03 | 0 requests (in-process lookup) |
| Mixer denylist | this project's own policy list, 3 Tornado Cash contracts verified on chain 1 on 2026-08-16 | static map in `src/funding.ts`. None is deployed at the same address on Base, so on Base this branch does not fire today — an L1 mixer withdrawal that was later bridged is **not** caught | 0 requests |
| Exchange-class fallback | behavioural heuristic derived from the D2 harvest, fixed before looking at the result: an EOA with > 1M transactions on Base that was the first inbound source for ≥ 3 of 74 sampled wallets | 3 addresses in `src/funding.ts`; 2 of the 3 were later confirmed by the Dune list as Binance 76 and Bybit 6, the third is unnamed, not refuted | 0 requests |
| Payer identity | **x402 v1 `X-PAYMENT` header**, base64 JSON, field `payload.authorization.from` | supplied by the paying client; signature checked downstream by the payment middleware, not by the gate | 0 requests |
| Evidence link | `base.blockscout.com` public explorer | string only — **never called** | 0 requests |

Calibration inputs, off the hot path entirely: `data/addresses.csv` (the frame:
EOAs that sent USDC on Base in blocks 50021246–50021255) → `scripts/collect.ts` →
`data/signals.csv` (30 rows, committed) → `scripts/calibrate.ts` → the constants
pasted into `src/config.ts`.

---

## 5. On-chain versus off-chain

| Step | Where it runs | What it needs you to trust | Why the boundary is here |
|---|---|---|---|
| **Read** — the payer's Base history | **off-chain**, from an indexer, over data that is on-chain | that Blockscout reports the chain faithfully — and the attestation links the raw history so you can check | a contract cannot iterate an address's history; an indexer is the only affordable way to read it |
| **Computed** — signals, compliance gate, score, verdict | **off-chain**, pure TypeScript, deterministic | that KYA ran the published code — checkable by re-running it against the same evidence | the inputs are a 150-tx window, percentiles and logarithms. On-chain that is gas per verification, charged against a $0.001 payment |
| **Signed** — the attestation | **off-chain**, EIP-191 over canonical JSON, throwaway key | nothing. It is a signature | makes an off-chain result portable and attributable without a registry |
| **Verified** — who issued this attestation | **anywhere**: 3 lines of viem off-chain, or `ecrecover` in Solidity | nothing beyond pinning the attester address you trust | the consumer is not tied to KYA's uptime, and does not have to call KYA at all |
| **Settled** — the USDC transfer | **on-chain**, by the x402 facilitator the seller already uses | the facilitator, exactly as before KYA existed | **KYA has no custody, no allowance, no ability to move funds.** Deliberately |

**Why the boundary sits exactly there.** Three reasons, in order of weight:

1. **The input is not on-chain-readable.** A contract cannot enumerate an
   address's transaction history, let alone take percentiles over the last 150 of
   them. Putting the score on-chain would mean putting a trusted oracle in front
   of it — which moves the trust, it does not remove it.
2. **Thresholds are recalibrated by rerunning a script and committing the
   output.** In this repository a recalibration is a diff. On-chain it would be a
   deployment, and the honest reflex to say *"the diversity signal did not
   separate, drop it to weight zero"* would become an expensive governance event.
3. **Blast radius.** Because KYA never touches money, the worst possible KYA
   failure is a wrong verdict or an unavailable one — never a lost payment. The
   gate fails closed, so an unavailable verdict costs a refused request, not a
   settled one.

What KYA offers *instead of* on-chain execution is verifiability of the
**output**: a signed, canonically-serialized attestation, linked to the raw
evidence, computed by rules that are committed in the repository. That is a
genuinely different guarantee from on-chain execution, and it is not being sold
as the same thing — see
[`docs/POSITIONING.md` §3](POSITIONING.md#3-correction-the-scoring-rules-are-public).
An EIP-712 attestation a Solidity contract can consume directly is roadmap, not
v0.1.

---

## 6. Stateless, and what happens when it falls over

### 6.1 Stateless

Every request re-reads the chain and signs a fresh, point-in-time attestation.
There is:

- **no database**, no session, no user account, no API key of its own to issue;
- **no stored score** — nothing is ever "a score of record", so nothing can go
  stale without saying so;
- **nothing shared between requests** except the process-wide rate-limit queue
  and, on a public deployment, the counter of live verifications spent today
  (§6.2). Both are in-memory and per-instance: two instances have two of each.

Responses are served `cache-control: no-store` and carry
`X-KYA-Source: live | cache | fixture` so a caller always knows which of the
three answered, plus `X-KYA-Degraded: budget | upstream` when a replay stood in
for a live read that could not be served (§6.2).

The only writable state is `data/cache/`, a 10-minute TTL keyed by address, and it
is a pure convenience: on a read-only checkout the write failure is swallowed on
purpose, because the cache must never be able to break a verify. A fixture is
simply a cache entry that was kept and committed — same file format.

The practical consequence: **instances need no coordination.** Run one or fifty
behind a load balancer; the only thing they contend for is the Blockscout rate
budget. And a seller who wants no third party in the path can run `kyaGate()`
inside their own process, which is what the demo does.

### 6.2 If it falls over

Two rules, and which one applies depends on whether money is at stake.

**At the gate: fail closed, before settlement.** If reputation cannot be read,
the seller does not serve blind — and nobody has paid for a verdict that does
not exist. `src/gate.ts` never degrades, never substitutes older evidence, and
never guesses: it refuses with `503`.

**At `GET /verify`: degrade, and label it.** That endpoint is read-only and
settles nothing, so answering with a committed dated capture — clearly marked as
one — is more useful than a `502`, and it costs a caller nothing to detect. The
headers say which source answered and why it stood in, and `evidence.fetched_at`
still carries the instant the chain was actually read, so a replay can never
pass itself off as a fresh read.

| What breaks | What the caller gets | Did anything settle? |
|---|---|---|
| **Daily live-verify budget spent** (public deployment) | The server stops calling Blockscout *before* the network, and replays a committed capture — or a cache entry of any age, labelled `cache`: `200`, `X-KYA-Source: fixture | cache`, `X-KYA-Degraded: budget`. Neither available for that address → `429` with `Retry-After` counting down to 00:00 UTC. Cap from `KYA_DAILY_VERIFY_BUDGET` (default 500); only reads that actually reach Blockscout are charged, so a cache hit is free | No |
| Blockscout answers 500 | 1 retry (~0.5–0.75 s backoff), then the **server** replays a committed capture, or a cache entry of any age, if it has either (`X-KYA-Degraded: upstream`), else `502` carrying the real upstream message. The **gate** does not degrade: `503` | No |
| Blockscout hangs | 8 s timeout, 2 attempts → ~17 s, then the same fallback: replay if a capture exists, else `502` / `503` | No |
| Blockscout rate-limits (429) | up to 3 dedicated retries honouring `Retry-After`, then the normal *retry* budget | No |
| Bad or missing API key (401/402) | thrown immediately, no retry, with the actionable message | No |
| `ATTESTER_PRIVATE_KEY` missing or malformed | `ConfigError` **at boot** — the process refuses to start | Nothing ever ran |
| Offline mode, no fixture for the address | The server tries `data/fixtures/`, then `data/cache/` **at any age**, and only then answers `404` (`503` at the gate). A cache replay is labelled `X-KYA-Source: cache`, never passed off as a fixture or as a live read | No |
| Unexpected error inside verify | `500`, *"payment refused before settlement"* | No |
| **The whole KYA service is down** | The gate is middleware inside the seller's process: if `verify()` cannot answer, every paying request is refused `503` before settlement | No |

**What a replay actually resolves to.** `loadHistory` (`src/history.ts`) tries
three things in order, and the reply says which one answered:

```
1.  data/fixtures/<address>.json    committed dated capture   ->  X-KYA-Source: fixture
2.  data/cache/<address>.json       AT ANY AGE, no TTL here   ->  X-KYA-Source: cache
3.  neither exists                  ->  404 (server) · 503 (gate)
```

So the honest guarantee is **not** "never stale data": step 2 will serve a
capture of any age rather than fail. It is that stale data is never served
*unlabelled*. `X-KYA-Source` names the source on every `200`, and
`evidence.fetched_at` carries the instant the chain was actually read, so a
consumer can always tell what it is holding and apply its own freshness policy.
The 10-minute TTL belongs to the live path, where a fresh read is the
alternative; on the replay path there is no alternative, so an old entry beats
no answer — and says so.

The retry budget is sized for a live demo, not a batch job: ~17 s worst case
instead of ~65 s. The answer to a longer outage is not patience, it is
`--offline`, which replays committed dated captures and never touches the
network. A live server also honours `?offline=1` per request, so the demo flips
to fixtures without a restart.

**What the fallback is not.** It buys availability of an *answer*, never
freshness. A degraded reply is a dated capture: same format, same signature, and
an `evidence.fetched_at` that is visibly old. It is the right answer for a demo
URL that must stay useful under abuse or an upstream outage, and it is the wrong
answer for a seller deciding whether to serve a paying agent — which is exactly
why the gate does not do it.

**What survives an outage:** every attestation already issued. It is a standalone
signed object — a consumer verifies it with `ecrecover` and re-reads the evidence
on Blockscout, with no call to KYA at all. When KYA is down, the only thing lost
is freshness. There is no state to lose.


---

## 7. Glossary

Ten terms this document uses without stopping to explain them.

**x402** — An HTTP payment protocol. The server answers `402 Payment Required`
with a price; the client repeats the request carrying a signed payment in an
`X-PAYMENT` header. Contributed by Coinbase to the x402 Foundation under the
Linux Foundation in 2026. KYA sits in front of it and changes nothing about it.

**facilitator** — The service that verifies an x402 payment and submits it
on-chain. The seller chooses one. **KYA is not a facilitator**, has no custody
and never moves funds; the demo points at a stub inside its own process so no
testnet funds are needed.

**EIP-3009** — "Transfer with authorization": an ERC-20 extension that lets a
wallet *sign* a transfer that somebody else submits and pays gas for. It is why a
zero-balance wallet can still produce a valid payment — and why the fresh wallet
in the demo can be refused *after* signing, having lost nothing.

**EIP-191** — The Ethereum standard for signing an arbitrary message with a
wallet key (`personal_sign`). Every KYA attestation is signed this way, so any
consumer can recover the signer in three lines and compare it against the
attester it decided to trust.

**RFC 8785 (JCS)** — JSON Canonicalization Scheme: one deterministic byte
sequence for a given JSON value — keys sorted recursively, no whitespace. Without
it, two languages could serialize the same attestation differently and the
signature would fail to verify for no real reason.

**SDN** — Specially Designated Nationals, the sanctions list published by the US
Treasury's OFAC. KYA extracts the entries carrying an Ethereum address and uses
them as a binary gate that sits *outside* the score: a listed address is not
scored badly, it is not scored at all.

**EOA** — Externally Owned Account: an ordinary wallet controlled by a private
key, as opposed to a smart contract. Control of an EOA address is the same key on
every EVM chain, which is why an exchange label recorded on another chain still
identifies that address on Base.

**attester** — The keypair KYA signs attestations with, and the address a
consumer pins in order to trust them. Throwaway by design: it signs, it never
holds funds. The hosted deployment uses a different key from the one in the
README examples.

**stratum** (plural *strata*) — One of the three labelled groups in the
calibration set: fresh, mid, established, ten addresses each. Thresholds come
from comparing strata. The refusal to recompose a stratum to make a signal look
better is exactly why diversity and cadence ended at weight zero.

**cold start** — Having no history to judge *in the source a given scorer reads*.
A wallet with two years of Base activity and no prior x402 payment is a cold
start to anything scoring x402 payment history, and a track record to KYA. That
asymmetry is the argument in `POSITIONING.md` §1.4.
