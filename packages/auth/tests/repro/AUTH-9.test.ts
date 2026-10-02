/**
 * AUTH-9 repro:
 *  (a) sign-in returns immediately for unknown emails (no dummy PBKDF2), so
 *      response time distinguishes registered from unregistered accounts;
 *  (b) the per-account sign-in limiter is keyed by email+IP, so rotating the
 *      client IP (X-Forwarded-For is trusted upstream) gives unlimited guesses
 *      against a single account.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import { describe, expect, test } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

async function setup() {
	const auth = createKoraAuthServer({ jwtSecret: 'e'.repeat(64) })
	await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email: 'known@example.com', password: 'password-123' },
		ip: '10.0.0.1',
	})
	return auth
}

async function timeSignIn(auth: Awaited<ReturnType<typeof setup>>, email: string, n: number) {
	const start = performance.now()
	for (let i = 0; i < n; i++) {
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signin',
			body: { email, password: 'wrong-password' },
			ip: `10.1.${i}.1`,
		})
	}
	return (performance.now() - start) / n
}

describe('AUTH-9: account enumeration and per-account brute force', () => {
	test('(a) unknown-email and wrong-password sign-ins take comparable time', async () => {
		const auth = await setup()
		const known = await timeSignIn(auth, 'known@example.com', 5)
		const unknown = await timeSignIn(auth, 'nobody@example.com', 5)
		// Correct: within the same order of magnitude.
		expect(unknown * 3).toBeGreaterThan(known)
	}, 120_000)

	test('(b) 15 wrong guesses (limit is 10/min) on one account from rotating IPs are eventually throttled', async () => {
		const auth = await setup()
		const statuses: number[] = []
		for (let i = 0; i < 15; i++) {
			const r = await auth.handleRequest({
				method: 'POST',
				path: '/auth/signin',
				body: { email: 'known@example.com', password: `guess-${i}` },
				ip: `203.0.113.${i}`,
			})
			statuses.push(r.status)
		}
		expect(statuses).toContain(429)
	}, 120_000)
})
