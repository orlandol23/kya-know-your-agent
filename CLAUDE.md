# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Commit and PR conventions

Commits are authored as `Orlando Fernandes
<27815856+orlandol23@users.noreply.github.com>`, set by `env` in
`.claude/settings.json`. Confirm it landed with
`git log -1 --format='%an <%ae>'`; if another identity got in, amend with
`--reset-author` instead of leaving it in the history.

Nothing in a commit message or a pull request body may name the tool or the
session that wrote it: no `Co-Authored-By:` trailer, no `Claude-Session:`
trailer, no "Generated with/by Claude Code" footer, and no `claude.ai/code`
link. Describe the change, not how it was produced.

PR bodies may be written in Portuguese. They are read by the repository owner,
not by visitors browsing the code.

## Language

This repository splits by audience, on purpose, and the split stays as it is.

English, because these are what a visitor reads: `README.md`,
`docs/ARCHITECTURE.md`, `docs/POSITIONING.md`, all code comments, test names,
commit messages and PR titles.

Portuguese, because these are working records rather than deliverables:
`PLAN.md` and `DECISIONS.md`. Both open with a "Note for English readers"
banner explaining the choice and pointing at the English material, and both
carry an English translation in every heading so the file can still be
navigated. Code and data cite PLAN.md's calibration sections by number, which
is why it is kept verbatim rather than rewritten.

Do not "fix" those two into English. Add to them in Portuguese, keeping the
bilingual headings.

## Stack

TypeScript on Node 22+, run through `tsx` with no build step. `viem` for chain
reads, `express` for the server, Blockscout as the data source, x402 as the
payment layer being scored.

## Commands

```bash
npm test                    # tsx --test, 6 tests, offline: no key, no network
npm run typecheck           # tsc --noEmit
npm run start:offline       # GET /verify plus the demo UI at :3000
npm run demo:agents:offline # two agents side by side
```

Every attestation is signed, offline ones included, so a throwaway attester key
is always needed. Generate one inline; never commit a key and never add a
repository secret for it. CI does exactly this and passes it as an environment
variable.

## Notes

- Offline mode replays committed fixtures, which are dated captures of live
  addresses. It is the path CI and the tests use, so it must keep working with
  no network and no Blockscout key.
- The attester address is printed at startup and echoed in the `attester` field
  for discovery, but a consumer decides which attester to trust. Nothing in the
  payload gets to make that decision.
- `/verify` is rate limited per IP (`KYA_VERIFY_RATE_LIMIT_PER_MIN`, default 30)
  ahead of the process-wide daily budget, so a limited request is never charged
  against it. `trust proxy` is set to one hop for Railway; changing the hosting
  means revisiting that number, or every caller lands in one bucket.
- The gate fails closed and runs inside a seller's own process against their own
  key. Leave that property alone.
- The OFAC list is a committed snapshot and goes stale. Refreshing it is an
  owner task, not something to synthesise.
