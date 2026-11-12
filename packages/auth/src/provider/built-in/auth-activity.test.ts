import { describe, expect, it, vi } from 'vitest'
import { AuthActivity, countedSend } from './auth-activity'
import { createKoraAuthServer } from './quickstart-server'

vi.mock('./password-hash', () => import('./password-hash.test-double'))

const HOUR = 3_600_000
const TEST_SECRET = 'a'.repeat(64)

describe('AuthActivity', () => {
	it('counts outcomes by code, separately for the last hour and the last day', () => {
		let now = 10 * HOUR
		const activity = new AuthActivity(() => now)
		activity.failed('signIns', 'INVALID_CREDENTIALS')
		activity.succeeded('signIns')
		now += 3 * HOUR
		activity.failed('signIns', 'RATE_LIMITED')
		activity.serverError()
		const snapshot = activity.snapshot()
		expect(snapshot.lastHour.signIns).toEqual({
			succeeded: 0,
			failed: 1,
			byCode: { RATE_LIMITED: 1 },
		})
		expect(snapshot.last24h.signIns).toEqual({
			succeeded: 1,
			failed: 2,
			byCode: { INVALID_CREDENTIALS: 1, RATE_LIMITED: 1 },
		})
		expect(snapshot.last24h.serverErrors).toBe(1)
		// A day on, the oldest hour has left the window.
		now += 22 * HOUR
		expect(activity.snapshot().last24h.signIns.byCode).toEqual({ RATE_LIMITED: 1 })
	})

	it('keeps codes plain and bounded', () => {
		const activity = new AuthActivity(() => 0)
		activity.failed('signUps', 'person@example.com is taken')
		activity.failed('signUps', null)
		for (let index = 0; index < 80; index += 1) activity.failed('signUps', `CODE_${index}`)
		const { byCode } = activity.snapshot().last24h.signUps
		expect(byCode.OTHER).toBeGreaterThanOrEqual(2)
		expect(Object.keys(byCode).length).toBeLessThanOrEqual(51)
		expect(JSON.stringify(byCode)).not.toContain('example.com')
	})

	it('counts a mailer that fails, and still lets the failure through', async () => {
		const activity = new AuthActivity()
		await countedSend(async () => undefined, activity)({})
		await expect(
			countedSend(async () => {
				throw new Error('SMTP down')
			}, activity)({}),
		).rejects.toThrow('SMTP down')
		expect(activity.snapshot().lastHour.emails).toEqual({
			succeeded: 1,
			failed: 1,
			byCode: { SEND_FAILED: 1 },
		})
	})
})

describe('the auth server counts what its routes did', () => {
	it('sign-ups, sign-ins by outcome, and the route reports them as insights', async () => {
		const auth = createKoraAuthServer({ jwtSecret: TEST_SECRET })
		const post = (path: string, body: unknown) =>
			auth.handleRequest({ method: 'POST', path, body, ip: '127.0.0.1' })
		expect(
			(await post('/auth/signup', { email: 'a@example.com', password: 'password123', name: 'A' }))
				.status,
		).toBe(201)
		expect(
			(await post('/auth/signin', { email: 'a@example.com', password: 'password123' })).status,
		).toBe(200)
		expect(
			(await post('/auth/signin', { email: 'a@example.com', password: 'wrong-password' })).status,
		).toBe(401)
		const counts = auth.activity().lastHour
		expect(counts.signUps.succeeded).toBe(1)
		expect(counts.signIns).toEqual({ succeeded: 1, failed: 1, byCode: { INVALID_CREDENTIALS: 1 } })
		expect(auth.httpRoute.path).toBe('/auth')
		expect(auth.httpRoute.insights.key).toBe('auth')
		expect(auth.httpRoute.insights.read().lastHour.signIns.failed).toBe(1)
		expect(JSON.stringify(auth.activity())).not.toContain('a@example.com')
	})

	it('a verification email the mailer fails to send is counted', async () => {
		const auth = createKoraAuthServer({
			jwtSecret: TEST_SECRET,
			emailVerification: {
				url: (token) => `https://app.example/verify#${token}`,
				send: () => {
					throw new Error('provider down')
				},
			},
		})
		await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email: 'b@example.com', password: 'password123', name: 'B' },
			ip: '127.0.0.1',
		})
		await vi.waitFor(() => expect(auth.activity().lastHour.emails.failed).toBe(1))
	})
})
