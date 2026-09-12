# KYA: Positioning, monetization, and one correction

> Three questions this document exists to answer, one section each:
>
> - *"What is the competitive advantage?"* — Coinbase already screens as a
>   facilitator, and there are good companies flagging addresses. §1.
> - *"Is there a business here — who pays, and what does it cost to run?"* — §2.
> - *"Are the scoring rules on-chain?"* — an earlier verbal answer said, in
>   effect, that they are not public; §3 retracts it in writing.
>
> Every number below is either read from this repository or explicitly labelled
> as an external measurement with its source named.

**Contents**

1. [Competitive advantage](#1-competitive-advantage)
2. [Monetization](#2-monetization)
3. [Correction: the scoring rules are public](#3-correction-the-scoring-rules-are-public)

---

## 1. Competitive advantage

### 1.1 It is not sanctions flagging, and it does not replace it

Chainalysis, TRM Labs and the screening Coinbase performs as an x402 facilitator
all answer one question well: **is this money dirty?** They trace funds across
hops, they maintain proprietary attribution, they carry the regulatory weight,
and they have been doing it for years. KYA does not compete on that question and
would lose if it tried.

KYA consumes one of the same inputs (the OFAC SDN list) and it consumes it in
the least clever way possible: as a **binary gate that sits outside the score**.
An address on the list, or funded by a listed address or a known mixer, is not
given a low score. It is not scored at all: `score: 0`, `gated: true`, and the
matching SDN entry is named in the refusal. That is a deliberately narrow claim.
It is one static list, refreshed by hand, with no multi-hop tracing behind it.
On the sanctions question, the incumbents are simply better, and the honest
framing is that KYA defers to them.

### 1.2 The case nobody blocks: measured, not asserted

On **18 August 2026** I ran the demo addresses through **SENTINEL**, the
compliance facilitator built by **Mauritius Oracle**: **11 screening layers with
multi-hop fund tracing**. Its block threshold of **76 is declared in SENTINEL's
own response payload**: it is not a number I inferred from the results.

The endpoint is public and free, so **anyone can reproduce this with one curl**,
no key and no account:

```
GET https://mru-oracle.com/facilitator/kya/{address}

curl https://mru-oracle.com/facilitator/kya/0xBEabA203Ef49Ee2828b77b0B7E84839e76092787
curl https://mru-oracle.com/facilitator/kya/0xeB94Dd34439e017EBa695678265e44Ea12E16B97
```

Their route is literally `/facilitator/kya/`. The acronym collides with this
project's name and the two are unrelated, worth knowing before a reader clicks
the link.

What those two calls returned on 18 August 2026:

| Address | What it is | SENTINEL (blocks at ≥ 76) | KYA (suspicious at ≤ 84) |
|---|---|---|---|
| `0xBEab…2787` | 6.99 days old, 42 transactions, funded by Binance 76 | **62 → elevated, not blocked** | **60 → suspicious** |
| `0xeB94…6B97` | **zero transactions**, nothing ever funded it | **68 → elevated, not blocked** | **0 → suspicious** |

**SENTINEL is not blind to this, and the comparison is worth making precisely.**
Its own payload returns `riskBand: "elevated"`, `recommendation:
"PROCEED_WITH_CAUTION"` and `blocked: false`, and the largest single
contributor to both scores is **maturity**, on addresses with almost no age at
all. It is looking at the same thing KYA looks at, and it says so.

The control case is the fourth demo address, `0x098B…2f96`, which is on the OFAC
SDN list as Lazarus Group. KYA gates it (`score: 0`, `gated: true`) and so would
any sanctions screen worth the name. That is the case where the incumbents are
already right and KYA claims nothing new. The two rows above are the whole
argument.

**Both wallets are clean, and that is precisely the point.** The facilitator is
asked "is this money dirty?" and answers, correctly, *no*. There is no tainted
source to trace, because there is no source at all: a wallet created seven days
ago has nothing to trace, and a wallet with zero transactions has less than
nothing. Multi-hop tracing over an empty history returns an empty result, and an
empty result reads as *clean*.

The seller's actual question is different: **"has this agent ever done anything?"**
For a seller taking sub-dollar payments from an autonomous buyer, the expensive
failure is not usually laundered money. It is a wallet minted five minutes ago to
burn a free tier, abuse a rate limit, scrape a paid model, or walk away from a
dispute, and then be discarded and replaced by the next one. Zero history is not
a compliance finding. It is a *reputation* finding, and the two are answered
differently: SENTINEL surfaces it as an advisory band and a recommendation a
human is expected to read, while KYA turns the same observation into a
calibrated verdict that a seller's middleware acts on before settlement. The
observation is shared. What differs is whether anything happens automatically:
`PROCEED_WITH_CAUTION` is not a decision a payment path can execute, and `403`
is.

Three limits on that claim, stated up front:

- This is **four addresses on one vendor**, not a benchmark. It demonstrates that
  the gap exists; it does not measure how wide it is.
- It is a **single reading taken on 18 August 2026, not an evaluation of
  SENTINEL as a product.** One call per address, on one day. Both wallets have
  kept living since, and SENTINEL's own screening will have moved on too, so a
  curl run today can legitimately return different numbers than the ones in the
  table. The point being made is about the *question* being asked, not about the
  quality of the answer.
- Not blocking a clean wallet is the *correct* behaviour for a sanctions screen.
  This is not a defect in their product. It is a different question that their
  product is not asked to decide.

### 1.3 It is not a facilitator: it is middleware in front of one

KYA is one Express middleware. It mounts **in front of** whatever payment
middleware and whatever facilitator the seller already runs:

```ts
app.use(kyaGate())                          // KYA: who is paying, and what have they done
app.use(paymentMiddleware(payTo, { … }))    // the seller's existing x402 stack, untouched
app.get('/chem', handler)
```

The consequences are structural, not marketing:

- **It never touches the money.** No custody, no allowance, no ability to move
  funds. Settlement is done by the facilitator the seller already chose.
- **It composes with Coinbase's facilitator rather than competing with it.** A
  seller can run both. KYA answers "has this agent got a track record?"; the
  facilitator answers "is this payment good and is this money clean?"
- **The worst KYA failure is a wrong or unavailable verdict**, never a lost
  payment. The gate fails closed, so an outage costs a refused request, not a
  settled one.
- **A refusal costs the buyer nothing.** The `403` lands before settlement, so the
  refused agent pays zero, and the refusal ships the signed attestation and the
  Blockscout link so the agent can check the claim itself.

### 1.4 Against the x402 reputation scorers: a cold-start asymmetry

History-based scoring of x402 payers already exists: **AgentQuay, DJD
AgentScore, ACHIVX, AgentKarma, Agent402**. They score the wallet's **x402
payment history**.

KYA scores the wallet's **general Base history**: age, lifetime transaction
count, and the provenance of the first inbound transfer. It requires no prior
x402 activity at all.

That produces a clean asymmetry in both directions:

| Wallet | An x402-history scorer sees | KYA sees |
|---|---|---|
| 662.73 days on Base, 51,666 transactions, exchange-funded, but has never made an x402 payment | **cold start**: no payment history to score | **857, trusted** |
| Created a week ago, but has already made a handful of x402 payments | some payment history to score | **suspicious**: 6.99 days and 42 transactions scores 60 |

The first row is the one that matters commercially: the population of wallets
with a long Base history vastly exceeds the population with an x402 payment
history, and x402 is young enough that "no prior x402 payments" describes almost
every wallet that has not yet arrived. A scorer that can only read x402 history
has nothing to say about a new customer on their first purchase, which is
exactly the moment a seller needs an answer.

The credential systems (Visa TAP, Mastercard Verifiable Intent, Skyfire KYAPay,
Trulioo/PayOS Digital Agent Passport, ERC-8004) sit in a third category: they
issue an identity to the agent and need an acceptor on the other side. KYA needs
no issuer, no registry and no enrollment; it reads what the wallet already did.
(ERC-8004 also ships a Reputation Registry. A 2026 preprint measuring it as
deployed found feedback rarely anchored in verifiable interaction, and over 90%
of reviewers on Base showing coordinated sybil behaviour. That is a **preprint**,
not peer-reviewed, and should be cited as one.)

### 1.5 Be honest about the moat: it is thin

**There is no data advantage here, and claiming one would be false.**

The history KYA reads is public. It is on Base. Anyone can read it: Blockscout's
free tier is enough to start, and the raw data is available to every participant
in this market equally. **If Coinbase decided to score payers by their Base
history, it could, and it would ship faster than I can.** It already sits in the
payment path, it already runs the facilitator, and it already has the
distribution. Nothing in this repository would slow that down by a day.

What actually exists is smaller, and worth naming precisely:

1. **A calibration methodology, and the discipline behind it.** The thresholds are
   not opinions; they are the *output* of a committed 30-address reference set
   that anyone can rerun (§3). More to the point, the negative results were kept:
   two of the five signals did not separate the set, and instead of quietly
   dropping them or recomposing the sample until they worked, they carry declared
   weight zero and are still reported as evidence. That reflex is reproducible by
   a competitor: it is just not usually reproduced.
2. **The integration position.** KYA is the layer a seller integrates **once**, in
   front of whatever facilitator they use. If a seller mounts it and later
   switches facilitators, the gate does not move. That is a real position, but it
   is worth exactly as much as the adoption behind it, and today the adoption is
   zero.

That is a thin moat, and I would rather say so than dress it up. It is thin in
the way most application-layer moats are thin at the start: the defensibility
would have to come from being early to a specific integration surface and from
the calibration getting better with real seller feedback, not from owning data
nobody else can reach.

**The merchant test is what would tell us whether thin is enough**: put the gate
in front of a real seller's paid endpoint, with real agent traffic, and find out
whether the seller keeps it switched on. That answers three things at once:
whether the refusals are the right refusals, whether the `unknown` band is usable
as a policy knob, and whether a seller would pay for it. Until that runs, "thin
moat" is the accurate description and any stronger claim would be one I could not
back.

---

## 2. Monetization

### 2.1 Who pays: the seller, because the seller carries the risk

The buyer has no incentive to be screened, and the agent being screened is the
last party who should fund the screening. The seller is the one exposed: they
serve the resource, they eat the abuse, they carry the chargeback-equivalent and
the compliance exposure. So the seller pays.

This is the same structure as **email antispam, where the receiver pays for
filtering, not the sender.** Nobody has ever successfully billed the sender for
being checked. The receiving side buys the filter because the receiving side
holds the loss. Reputation for agent payments has the same shape: the party
holding the risk is the party buying the answer.

It is also why KYA is middleware rather than a facilitator. A facilitator has to
be chosen instead of another facilitator. A gate is mounted in front of the one
already chosen, which is a much smaller decision to ask a seller to make.

### 2.2 Cost: the data is nearly free, and stays nearly free at scale

Measured from the Blockscout Pro plans page (checked 2026-08-18) and from the
request count in the code:

```
   Free tier          100,000 credits per DAY, renewed daily
                      20 credits per API call
                      5 requests/second

   One verify         6 HTTP calls  (7 when /counters comes back cold)

   100,000 / 20     = 5,000 calls per day
   5,000 / 7        ≈   714 verifications per day   (worst case, cold counter)
   5,000 / 6        ≈   833 verifications per day   (typical)
```

The 10-minute cache stretches that further: a repeat verification of the same
address inside the window costs **zero** calls.

The next tier is **$49/month for 100 million credits**. Taking those as the
monthly allowance, the arithmetic is:

```
   100,000,000 / 20 = 5,000,000 calls per month
   5,000,000 / 7    ≈ 714,000 verifications per month   (worst case)
   $49 / 714,000    ≈ $0.00007 per verification
```

That is roughly **seven thousandths of one cent** per verification, and it does
not degrade with scale: cost per verify is constant in the size of the address,
because the 6 calls are constant in the size of the address. A 51,666-transaction
wallet and a 42-transaction wallet cost the same to check.

**The conclusion that matters:** reading the chain is not the economic
constraint on this product. At any volume a seller would plausibly generate, the
data cost rounds to nothing next to a single engineer-hour. **The bottleneck is
adoption, not infrastructure**, and a business plan for KYA is a distribution
plan, not a cost model.

### 2.3 What is not decided: the price

**I have not priced this, and I am not going to invent a number for a slide.**

Every plausible shape is defensible on a whiteboard and undecidable without a
customer: per-verification, a monthly seat for the seller, a percentage of the
protected volume, free below a threshold with paid tiers above it, or open-source
gate with a hosted attester. Picking one today would mean picking it from
aesthetics.

The order is deliberate: **the merchant test comes first, pricing comes after.**
What a seller will pay depends on what the gate is worth to them, and what it is
worth to them depends on how much abuse it actually refuses in their traffic,
which is a measurement I do not have yet and cannot honestly estimate. The cost
side is settled (§2.2: effectively zero, at any scale worth discussing), so
pricing is entirely a question of demonstrated value, and demonstrated value is
what the merchant test produces.

---

## 3. Correction: the scoring rules are public

### 3.1 What I said, and why it was wrong

An earlier answer, given verbally, said the scoring formula is *"hidden at the
back."*

**That answer was wrong, and I am retracting it here in writing.** Nothing about
the scoring is hidden. Every weight, every threshold, every cutoff and the entire
formula are committed in this repository, the calibration that produced the
measured ones is reproducible with one command, and the per-request arithmetic
ships in the API response.

The correct answer to the question actually asked is two sentences:
**No, the scoring does not execute on-chain: it is computed off-chain in
TypeScript. And yes, every rule it uses is public, committed and reproducible.**

### 3.2 Where every rule lives

| What | File | What it holds |
|---|---|---|
| ZERO/FULL thresholds per axis | `src/config.ts:78` | `ageDays 3.03 → 532.09`, `txCount 54.75 → 2236.25` (**MEASURED**) |
| Axis weights | `src/config.ts:88` | `funding 0.40`, `maturity 0.35`, `volume 0.25` (**CHOSEN**) |
| Fallback weights without funding | `src/config.ts:99` | `maturity 0.58`, `volume 0.42` (**CHOSEN**) |
| Funding class levels | `src/config.ts:115` | `exchange 1.0`, `unknown 0.35`, `none 0.05`, `mixer 0`, `sanctioned 0` (**CHOSEN**) |
| Scale, floor, confidence constant | `src/config.ts:124` | `scale 1000`, `eps 0.02`, `confidenceK 25` (**CHOSEN**) |
| Burst penalty | `src/config.ts:137` | `burstRatio > 50 → ×0.85` (**CHOSEN**) |
| Verdict cutoffs | `src/config.ts:160` | `suspiciousMax 84`, `trustedMin 193` (**MEASURED**) |
| The formula itself | `src/score.ts:108` | `scoreAddress()`: normalization, EPS floor, weighted geometric mean in log space, penalty, confidence, and the compliance gate that runs before all of it |
| Cutoffs applied | `src/verdict.ts:29` | `verdictFor()`: ≤ 84 suspicious, ≥ 193 trusted, between = unknown |
| The reference set | `data/signals.csv` | 30 rows, committed on purpose: the evidence behind every calibrated number |
| The calibration | `scripts/calibrate.ts` | reads `data/signals.csv`, prints every measured number and a paste-ready config block |
| Per-request arithmetic | `src/server.ts:143` | `explain()`: what `?explain=1` returns |

`src/config.ts` labels each constant **MEASURED** or **CHOSEN** in the file
itself, with the distinction spelled out at the top: MEASURED means it is the
output of `scripts/calibrate.ts` over the committed reference set and anyone can
reproduce it; CHOSEN means it is a design decision, argued but not measured,
because no labelled reference set exists that could measure it. Saying which is
which is the entire point of the calibration story, and it would be pointless if
the file were hidden.

### 3.3 Reproduce it yourself, three ways

**One: rerun the calibration.** No API key, no network:

```
   npx tsx scripts/calibrate.ts
```

It reads `data/signals.csv` and prints, among the rest:

```
   SUSPICIOUS_MAX = highest fresh score      = 84
   TRUSTED_MIN    = lowest established score = 193
   the clusters do not touch: empty gap of 109 points

   separation at those cutoffs
     group          suspicious   unknown   trusted
     fresh                  10         0         0
     mid                     4         2         4
     established             0         0        10
```

followed by a literal `export const VERDICT = { suspiciousMax: 84, trustedMin:
193 }` block to paste into `src/config.ts`. **The threshold is an output of this
repository, not an input.** The script does not write to `config.ts`: the number
is checked by eye and committed by hand, so the diff is visible.

*(One caveat, so nobody is surprised: the separation ratios annotated in
`src/config.ts` (`176x`, `41x`, `0.09x`) are hand-written notes, not script
output. `calibrate.ts` prints ZERO and FULL, and the ratios are computed from
them.)*

**Two: ask the API for the arithmetic.** `GET /verify?address=0x…&explain=1`
returns `{ attestation, breakdown, source, captured_at }`, where `breakdown` is
the entire unsigned computation: each axis with its raw `value`, its `normalized`
value and its `weight`; the `geometric_mean`; the `penalty`; the `confidence` and
the `evidence_mass` it came from; the `scale`; and the `cutoffs`. That is every
term of `score = 1000 · G · penalty · confidence`. It is exactly what the demo UI
draws its explanation panel from, and it is enough to recompute the score by
hand.

**Three: read the reasons in any attestation.** Even without `explain=1`, every
attestation carries `reasons` in plain text with the thresholds inline:

```
   "663 days old (full credit at 532.09, none below 3.03)"
   "51666 transactions (full credit at 2236.25, none below 54.75)"
   "funded by Binance 76 (0x3304e22d…7b566a), identity confirmed against dune-spellbook@9f61b0d"
```

A refused agent gets the same thing in the `403` body, plus the Blockscout link
to the raw history, so it can check the claim against the chain without trusting
KYA at all.

### 3.4 "Not on-chain" and "hidden" are different claims

They are worth separating carefully, because conflating them produced the
earlier wrong answer.

**"On-chain" is a question about *where the computation runs*.** KYA's score is
computed off-chain, in TypeScript, in the seller's process or on a KYA server.
That is true, and it is a **design decision**, argued in
[`docs/ARCHITECTURE.md` §5](ARCHITECTURE.md#5-on-chain-versus-off-chain). The
short version:

- The input is not on-chain-readable. A contract cannot enumerate an address's
  transaction history, let alone take percentiles over the last 150 of them.
  Moving the score on-chain would mean putting a trusted oracle in front of it,
  which relocates the trust rather than removing it.
- Recalibration would become a deployment. Here it is a diff, which is what
  makes it cheap enough to publish the negative results and drop two signals to
  weight zero.
- Gas per verification, charged against a $0.001 payment, is not a rounding error.
  It is the whole margin.

**"Hidden" is a question about *whether anyone can see it*.** Nothing is hidden.
§3.2 lists the file and line of every rule; §3.3 gives three independent ways to
reproduce the numbers without asking me for anything.

**What KYA provides instead of on-chain execution is verifiability of the
output.** The attestation is serialized as canonical JSON (RFC 8785: keys sorted
recursively, no whitespace) and signed EIP-191, so any consumer (in any
language, and a Solidity contract via `ecrecover`) can confirm who issued it in
three lines, with no call to KYA:

```ts
const { signature, ...body } = attestation
const signer = await recoverMessageAddress({ message: JSON.stringify(body), signature })
if (signer !== KYA_ATTESTER) throw new Error('not signed by KYA')
```

**And the limit of that guarantee, stated plainly:** a signature proves *who
issued* an attestation. It does **not** prove that KYA ran the published code to
produce it. What closes that gap is re-derivation, not cryptography: the rules
are committed, the evidence is linked, so an auditor can recompute the score from
the same inputs and compare. That is a weaker guarantee than on-chain execution
and it should not be sold as an equivalent one. An EIP-712 attestation that a
Solidity contract can consume directly is on the roadmap; it is not in v0.1.
