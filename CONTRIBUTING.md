# Contributing

How to build, test and send changes to KYA. The public documentation lives in
[`README.md`](README.md), [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/POSITIONING.md`](docs/POSITIONING.md) and [`docs/API.md`](docs/API.md);
the security posture and how to report a vulnerability are in
[`SECURITY.md`](SECURITY.md) and
[`docs/SECURITY-SUMMARY.md`](docs/SECURITY-SUMMARY.md).

## Prerequisites

- Node 22 or newer (`engines.node` in `package.json`).
- npm (ships with Node).
- No build step: everything runs through `tsx`.

## Setup

    npm ci

## Typecheck

    npm run typecheck

## Tests

    ATTESTER_PRIVATE_KEY=<throwaway> npm test

Every attestation is signed, offline ones included, so a throwaway attester key
is always needed. Generate one at run time and pass it as an environment
variable, the way CI does — never commit it, never store it in the repository:

    ATTESTER_PRIVATE_KEY=$(node -e "import('viem/accounts').then(a => console.log(a.generatePrivateKey()))") npm test

The suite is fully offline: it replays the committed fixtures in
`data/fixtures/` — no Blockscout key, no network, no `.env`. It covers canonical
serialization and signature recovery, the four fixture verdicts, the verdict
cutoffs, the payment-header parser, gate ordering, and the per-IP rate limit.

## Offline smoke tests

The same throwaway key drives them all:

    npx tsx src/cli.ts --offline 0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04   # whole pipeline, one screen
    npm run start:offline                                                     # GET /verify + the UI at :3000
    npm run demo:endpoint:offline                                             # seller, terminal 1
    npm run demo:agents:offline                                               # buyers, terminal 2

Expected from the demo pair: the established wallet is served, the fresh wallet
is refused `403` before settlement, both from committed fixtures. Against a live
read, add a `BLOCKSCOUT_API_KEY` to `.env` (see `.env.example`).

## Keys

- `.env` is gitignored; `.env.example` documents every variable.
- The attester key is a throwaway: it signs attestations and never holds funds.
  Generate it at run time, pass it as an environment variable, and discard it.
- Never commit a private key to this repository, in any file, in any form. A
  key that needs to persist is a design question, not a git question.

## Branches and pull requests

1. Branch from the default branch; use a short, descriptive branch name.
2. Keep a pull request to one kind of change (code, documentation, or tooling)
   unless they genuinely belong together.
3. CI runs `npm ci`, the typecheck and the offline test suite on every push and
   pull request; keep it green.
4. A pull request that changes documented behaviour updates the affected public
   document in the same pull request.
5. A pull request that changes security-relevant behaviour updates the status
   of the affected finding in
   [`docs/SECURITY-SUMMARY.md`](docs/SECURITY-SUMMARY.md) in the same pull
   request: a status moves only when the code that implements it lands.

## Documentation conventions

- Public documents are in English.
- Separate what is observed (with its source and date) from what was decided,
  what is limited, and what is planned.
- Date every external claim and link the primary source.
- Live, cache and fixture are different sources; anything served from a replay
  must say so (`X-KYA-Source`).
- Do not state that the score proves identity, intent, solvency or compliance.
- Do not include reproduction recipes for abuse against the hosted deployment.

## License

MIT. By contributing you agree that your contributions are licensed under the
repository's license.
