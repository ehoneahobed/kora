/**
 * AUTH-10 repro (TotpManager):
 *  (a) verify() has no failed-attempt limit, so a 6-digit code can be brute-forced
 *      (1e6 space, ~3 valid codes per 30 s window);
 *  (b) disable() uses validateCode() without consuming the time-step, so an
 *      already-used (observed) code can be replayed to turn MFA off.
 *  (Token issuance ignoring MFA is shown by code reading; see results-auth.md.)
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { createHmac } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { InMemoryTotpStore, TotpManager, base32Decode } from '../../src/mfa/totp'

function totp(secretB32: string, at = Date.now()): string {
	const counter = Math.floor(at / 1000 / 30)
	const buf = Buffer.alloc(8)
	buf.writeBigUInt64BE(BigInt(counter))
	const h = createHmac('sha1', Buffer.from(base32Decode(secretB32))).update(buf).digest()
	const off = (h[h.length - 1] as number) & 0xf
	const bin = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000
	return bin.toString().padStart(6, '0')
}

async function enrolled() {
	const mgr = new TotpManager({ issuer: 'Kora', store: new InMemoryTotpStore() })
	const { secret } = await mgr.enable('u1', 'u1@example.com')
	// Enroll with the previous window's code so the current one is still fresh.
	expect(await mgr.verifySetup('u1', totp(secret, Date.now() - 30_000))).toBe(true)
	return { mgr, secret }
}

describe('AUTH-10: TOTP brute force and replay', () => {
	test('(a) after many wrong codes, verification is locked out', async () => {
		const { mgr, secret } = await enrolled()
		const right = totp(secret)
		let wrongTried = 0
		for (let i = 0; i < 200; i++) {
			const guess = String(i).padStart(6, '0')
			if (guess === right) continue
			await mgr.verify('u1', guess).catch(() => false)
			wrongTried++
		}
		expect(wrongTried).toBeGreaterThan(100)
		// Correct behavior: locked (false or throws) after a bounded number of failures.
		const after = await mgr.verify('u1', right).catch(() => false)
		expect(after).toBe(false)
	})

	test('(b) a code already consumed by verify() cannot be replayed to disable MFA', async () => {
		const { mgr, secret } = await enrolled()
		const code = totp(secret)
		expect(await mgr.verify('u1', code)).toBe(true) // legit login uses (and consumes) it
		await expect(mgr.disable('u1', code)).rejects.toThrow()
		expect(await mgr.isEnabled('u1')).toBe(true)
	})
})
