import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { InMemoryTotpStore, TotpManager, base32Decode } from '../../mfa/totp'
import { decodeJwt } from '../../tokens/jwt'
import { createKoraAuthServer } from './quickstart-server'

function totp(secretB32: string, at = Date.now()): string {
	const buf = Buffer.alloc(8)
	buf.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
	const h = createHmac('sha1', Buffer.from(base32Decode(secretB32)))
		.update(buf)
		.digest()
	const off = (h[h.length - 1] as number) & 0xf
	return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0')
}

async function enrolledUser() {
	const totpManager = new TotpManager({ issuer: 'Kora', store: new InMemoryTotpStore() })
	const auth = createKoraAuthServer({ jwtSecret: 'm'.repeat(64), mfa: totpManager })
	const signup = await auth.handleRequest({
		method: 'POST',
		path: '/auth/signup',
		body: { email: 'mfa@example.com', password: 'password-123', deviceId: 'd1' },
	})
	const userId = (signup.body as { data: { user: { id: string } } }).data.user.id
	const { secret, recoveryCodes } = await totpManager.enable(userId, 'mfa@example.com')
	await totpManager.verifySetup(userId, totp(secret, Date.now() - 30_000))
	return { auth, secret, recoveryCodes }
}

async function signIn(auth: Awaited<ReturnType<typeof enrolledUser>>['auth']) {
	return auth.handleRequest({
		method: 'POST',
		path: '/auth/signin',
		body: { email: 'mfa@example.com', password: 'password-123', deviceId: 'd1' },
	})
}

describe('MFA at issuance (AUTH-10)', () => {
	it('a password alone yields a challenge, never tokens, and the mfa token is useless elsewhere', async () => {
		const { auth } = await enrolledUser()
		const res = await signIn(auth)
		expect(res.status).toBe(200)
		const data = (res.body as { data: Record<string, unknown> }).data
		expect(data.mfaRequired).toBe(true)
		expect(data).not.toHaveProperty('tokens')
		const mfaToken = data.mfaToken as string
		expect(decodeJwt(mfaToken)?.type).toBe('mfa_pending')

		expect(await auth.auth.authenticate(mfaToken)).toBeNull()
		const me = await auth.handleRequest({
			method: 'GET',
			path: '/auth/me',
			headers: { authorization: `Bearer ${mfaToken}` },
		})
		expect(me.status).toBe(401)
		const refresh = await auth.handleRequest({
			method: 'POST',
			path: '/auth/refresh',
			body: { refreshToken: mfaToken },
		})
		expect(refresh.status).toBe(401)
	})

	it('/auth/mfa/verify exchanges the challenge plus a code for tokens carrying amr', async () => {
		const { auth, secret } = await enrolledUser()
		const mfaToken = ((await signIn(auth)).body as { data: { mfaToken: string } }).data.mfaToken

		const wrong = await auth.handleRequest({
			method: 'POST',
			path: '/auth/mfa/verify',
			body: { mfaToken, code: '000000' },
		})
		expect(wrong.status).toBe(401)
		expect(wrong.body).toMatchObject({ code: 'MFA_CODE_INVALID' })

		const ok = await auth.handleRequest({
			method: 'POST',
			path: '/auth/mfa/verify',
			body: { mfaToken, code: totp(secret) },
		})
		expect(ok.status).toBe(200)
		const tokens = (ok.body as { data: { tokens: { accessToken: string } } }).data.tokens
		expect(decodeJwt(tokens.accessToken)?.amr).toEqual(['pwd', 'otp'])
		expect(await auth.auth.authenticate(tokens.accessToken)).not.toBeNull()

		// The challenge is single-use.
		const again = await auth.handleRequest({
			method: 'POST',
			path: '/auth/mfa/verify',
			body: { mfaToken, code: totp(secret, Date.now() + 30_000) },
		})
		expect(again.status).toBe(401)
	})

	it('a recovery code also completes the challenge', async () => {
		const { auth, recoveryCodes } = await enrolledUser()
		const mfaToken = ((await signIn(auth)).body as { data: { mfaToken: string } }).data.mfaToken
		const ok = await auth.handleRequest({
			method: 'POST',
			path: '/auth/mfa/verify',
			body: { mfaToken, recoveryCode: recoveryCodes[0] },
		})
		expect(ok.status).toBe(200)
		const tokens = (ok.body as { data: { tokens: { accessToken: string } } }).data.tokens
		expect(decodeJwt(tokens.accessToken)?.amr).toEqual(['pwd', 'rcv'])
	})
})
