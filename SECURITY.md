# Security policy

## Supported

| Surface | Status |
|---|---|
| `master` (the default branch) | supported; security fixes land here |
| The hosted deployment linked in [`README.md`](README.md) | deployed from `master` |

There are no tagged releases yet. `master` and the hosted deployment are the
supported surface.

## Reporting a vulnerability

Use **GitHub's private vulnerability reporting** on this repository
(*Security → Report a vulnerability*). Please do not open a public issue for a
security report.

When reporting, it helps to include:

- the component involved: the server (`src/server.ts`), the gate
  (`src/gate.ts`), the verification pipeline (`src/`), the demo (`demo/`), or
  the CI configuration;
- what an attacker could achieve, and at what cost;
- the request or configuration that shows it. A description is enough; a
  reproducible proof-of-concept against the hosted deployment is not needed and
  should not be sent.

## Scope

In scope:

- the verification pipeline and attestation signing (`src/`),
- the gate and the demo processes (`src/gate.ts`, `demo/`),
- dependency and CI configuration (`.github/workflows/`, `package.json`),
- the HTTP contract documented in [`docs/API.md`](docs/API.md).

Out of scope:

- volumetric denial of service against the hosted deployment;
- social engineering;
- reports that a throwaway attester key could be stolen. The attester key signs
  attestations and never holds funds; its compromise has no financial reach.

## Current posture

[`docs/SECURITY-SUMMARY.md`](docs/SECURITY-SUMMARY.md) documents the threat
model, what the attestation does and does not prove, and the status of every
known finding — including what has **not** been fixed. Read it before assuming
a behaviour is intentional or a fix has been applied.
