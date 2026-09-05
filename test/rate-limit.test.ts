/**
 * npm test   ->   tsx --test
 *
 * The per-IP limit on GET /verify, exercised through the real HTTP stack
 * (createApp() + fetch), not by calling handleVerify() directly: the limiter
 * is Express middleware sitting in front of the route, so calling the
 * handler in-process would prove nothing about whether it actually runs.
 *
 * KYA_VERIFY_RATE_LIMIT_PER_MIN is set to 3 before createApp() is ever
 * asked to serve a request, so this file's whole one-minute window is three
 * requests: the fourth must be refused regardless of the address queried.
 * OFFLINE means every one of them replays a committed fixture, no network,
 * no Blockscout key, and no daily budget involved (offline bypasses it).
 *
 * Run from the repository root: data/fixtures/ is resolved against the cwd.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

// Set before createApp() and before any request: read per-request, like
// dailyVerifyBudget(), but only ever seen here at 3 for this whole file.
process.env.KYA_VERIFY_RATE_LIMIT_PER_MIN = '3'

// Fixed throwaway key, same one kya.test.ts uses: only the HTTP status and
// headers are asserted below, never a signer, so which key signs does not
// matter, only that ATTESTER_PRIVATE_KEY is present before verify() runs.
process.env.ATTESTER_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

// Dynamic imports, not static ones: a static `import` is hoisted above the
// two assignments above, which would let src/server.ts's loadDotEnv() (or a
// stale process.env from another file) win the race for ATTESTER_PRIVATE_KEY
// instead of the fixed key this file needs.
const { setOffline } = await import('../src/history.js')
const { createApp } = await import('../src/server.js')

setOffline(true)

const ESTABLISHED = '0xeA258496a9311Ffe29CDf920Ca0E8BB4B41c9F04'

test('a fourth /verify from the same IP inside a minute gets 429, not a fixture', async () => {
  const app = createApp()
  const server = app.listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  const url = `http://127.0.0.1:${address.port}/verify?address=${ESTABLISHED}`

  try {
    // 1-3: under the limit, so the limiter steps aside and the request is
    // served normally, from the committed fixture (offline mode).
    for (let i = 1; i <= 3; i += 1) {
      const res = await fetch(url)
      assert.equal(res.status, 200, `request ${i} of 3 should be under the limit`)
      assert.equal(res.headers.get('x-kya-source'), 'fixture', `request ${i} source`)
    }

    // 4: over the limit. The limiter answers, and handleVerify never runs
    // -- this is refused before it could have spent anything.
    const fourth = await fetch(url)
    assert.equal(fourth.status, 429)
    assert.equal(fourth.headers.get('cache-control'), 'no-store')
    // draft-7 standardHeaders: one combined RateLimit header, plus the
    // policy, plus the always-present Retry-After -- fetch's Headers.get is
    // case-insensitive, matching the wire names express-rate-limit sends.
    assert.ok(fourth.headers.get('ratelimit'), 'RateLimit header missing')
    assert.ok(fourth.headers.get('ratelimit-policy'), 'RateLimit-Policy header missing')
    assert.ok(fourth.headers.get('retry-after'), 'retry-after header missing')
    // Not the standard headers, which express-rate-limit sets itself:
    // the OLD X-RateLimit-* family is legacyHeaders, deliberately off here.
    assert.equal(fourth.headers.get('x-ratelimit-limit'), null)

    const body = (await fourth.json()) as {
      error: string
      reason: string
      retry_after_seconds: number
    }
    assert.equal(body.error, 'too many verifications from this address in the last minute')
    assert.equal(body.reason, 'rate')
    assert.equal(typeof body.retry_after_seconds, 'number')
    assert.ok(body.retry_after_seconds > 0 && body.retry_after_seconds <= 60)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
