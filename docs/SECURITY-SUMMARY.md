# Security summary

> Status as of November 2026, describing the code on this branch. This change is
> documentation only: **no security correction has been applied in it**, and no
> claim below should be read as one. A finding's status changes only in the
> commit that changes the code.

## What KYA is, security-wise

KYA reads an address's public Base history, scores it, and signs a
point-in-time attestation of the verdict. The score measures observed history.
It does not prove identity, intent, solvency or compliance, and nothing in an
attestation should be read as any of those claims.

## Threat model, high level

- **What an attestation vouches for:** that it was signed by the attester key,
  over exactly this content, and that the evidence it cites was linked at
  signing time.
- **What it does not vouch for:** that the address is who a caller hopes it is;
  that the history will not change; that the published code is what produced a
  given attestation. The check for the last one is re-derivation from the
  committed rules and the linked evidence, not the signature.
- **Attacker positions considered:**
  - *forged attestation* — closed by verifying the signature against a pinned
    attester;
  - *tampered attestation* — closed by canonical serialization (RFC 8785) plus
    EIP-191, which binds the signature to the content;
  - *stale or replayed data* — mitigated, not solved: every reply labels its
    source (`X-KYA-Source`) and carries `evidence.fetched_at`; freshness
    remains the consumer's policy (see open item 1);
  - *spending the operator's data-provider budget on requests that never lead
    to settlement* — open (see open item 2);
  - *sanctions exposure* — a binary gate outside the score, over a static,
    dated list (see limitations).

## Signature and trust in the attester

- Attestations are serialized as canonical JSON (RFC 8785) and signed EIP-191.
  Any consumer can recover the signer in three lines and compare it against the
  attester *it decided to trust*.
- The `attester` field in the body is for discovery only. Trust is pinned out
  of band: for the hosted deployment, the production attester address is
  published in [`README.md`](../README.md). Nothing inside an attestation's
  payload gets to decide whose signature a consumer accepts.
- The attester key is throwaway by design: it signs attestations and never
  holds funds. Keys are generated at run time and passed as environment
  variables; they are never committed, and nothing in this repository's
  practice suggests versioning them.

## Open findings, real status

None of the items below has been fixed in code as of this branch.

1. **No freshness or audience binding on the attestation.** The signed body
   carries no `expires_at`, no nonce and no audience field. A consumer that
   verifies only the signature can accept an old attestation, one about a
   different address than the one it is transacting with, or one replayed from
   a fixture if it ignores `X-KYA-Source` and `evidence.fetched_at`. Today the
   attestation is point-in-time by design and the consumer owns the freshness
   policy. Found in the September 2026 security and architecture review;
   status: **open**.
2. **A costly reputation read can be triggered before the payment signature is
   checked.** The gate runs ahead of the payment middleware and names the payer
   from the payment header without validating the payment's signature, which
   the downstream x402 stack does later. A request whose payment would never
   settle can still cause a reputation read. It cannot move funds — a payer
   address that was not signed for never settles — but it can cause external
   reads. Reported by an external security review received 2026-09-05;
   status: **open, fix planned, not applied**.
3. **Dependency advisories.** An `npm audit` on 2026-09-10 recorded 2 high
   advisories (axios 1.16.0, ws 8.18.0), both transitive through the
   `x402-express` dependency chain; neither is a direct dependency and neither
   is imported by `src/`. Advisory counts move with the advisory database;
   these numbers are the 2026-09-10 snapshot, scoped to this repository's
   lockfile. Updating dependencies is separate work and is not part of this
   change.

## What was checked, and when

Point-in-time results from the September 2026 review pass (2026-09-05), not
continuous guarantees:

- no `.env` file tracked anywhere in the repository's history; `.gitignore`
  covers it;
- no secret patterns in the tree;
- CI runs least-privilege (`permissions: contents: read`) and generates a
  throwaway attester key at run time rather than storing one;
- the offline test suite covers signature recovery, fixture verdicts, the
  payment-header parser, gate ordering, and the per-IP rate limit.

## What this attestation does not prove

- identity of the wallet's controller;
- intent of past or future transactions;
- solvency or creditworthiness;
- regulatory compliance of the address or its counter parties.

A high score means the observed Base history looks established. That is the
whole claim.

## Not included here

This file deliberately contains no reproduction steps, no exploit payloads and
no request recipes against the hosted deployment. Findings are described at
the level needed to understand and fix them.

## Reporting a new issue

See [`SECURITY.md`](../SECURITY.md): GitHub's private vulnerability reporting,
not a public issue.
