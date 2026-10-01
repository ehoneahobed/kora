/**
 * AUTH-14 repro (low-severity bundle). Asserts CORRECT behavior; each case FAILS today.
 *  - passkey: verifyAuthenticationResponse ignores the UV flag although options require UV
 *  - ExternalJwtProvider (HS256): a token with no `exp` is accepted forever; `aud`/`iss` unchecked
 *  - webhooks: verifyWebhookSignature has no timestamp window (replay); register() accepts
 *    internal/metadata URLs (SSRF)
 */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { describe, expect, test, vi } from 'vitest'
import {
	InMemoryWebhookStore,
	WebhookManager,
	verifyWebhookSignature,
} from '../../src/admin/webhooks'
import { verifyAuthenticationResponse } from '../../src/passkey/passkey-server'
import { ExternalJwtProvider } from '../../src/provider/external/external-jwt-provider'
import { encodeJwt } from '../../src/tokens/jwt'

const b64u = (b: Buffer) => b.toString('base64url')

describe('AUTH-14: passkey user-verification flag', () => {
	test('assertion without UV is rejected when UV is required', async () => {
		const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
		const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
		const x = Buffer.from(jwk.x, 'base64url')
		const y = Buffer.from(jwk.y, 'base64url')
		const cose = Buffer.concat([
			Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
			x,
			Buffer.from([0x22, 0x58, 0x20]),
			y,
		])

		const rpIdHash = createHash('sha256').update('example.com').digest()
		const flags = Buffer.from([0x01]) // UP only, UV NOT set
		const authData = Buffer.concat([rpIdHash, flags, Buffer.from([0, 0, 0, 0])])
		const clientDataJSON = Buffer.from(
			JSON.stringify({ type: 'webauthn.get', challenge: 'chal', origin: 'https://example.com' }),
		)
		const signed = Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()])
		const signature = sign('sha256', signed, privateKey) // DER

		const run = verifyAuthenticationResponse({
			assertion: {
				credentialId: 'cred',
				authenticatorData: b64u(authData),
				clientDataJSON: b64u(clientDataJSON),
				signature: b64u(signature),
				userHandle: null,
			},
			expectedChallenge: 'chal',
			expectedOrigin: 'https://example.com',
			expectedRpId: 'example.com',
			publicKey: b64u(cose),
			previousSignCount: 0,
		})
		const result = await run.catch((e: unknown) => ({ verified: false, error: e }))
		expect(result.verified).toBe(false)
	})
})

describe('AUTH-14: ExternalJwtProvider HS256', () => {
	const secret = 'k'.repeat(40)
	test('token without exp is rejected', async () => {
		const p = new ExternalJwtProvider({ providerName: 'supabase', jwtSecret: secret })
		const forever = encodeJwt({ sub: 'u1' }, secret)
		expect(await p.toSyncAuthProvider().authenticate(forever)).toBeNull()
	})
	test('token minted for another audience/issuer sharing the secret is rejected', async () => {
		const p = new ExternalJwtProvider({ providerName: 'supabase', jwtSecret: secret })
		const now = Math.floor(Date.now() / 1000)
		const other = encodeJwt(
			{ sub: 'u1', aud: 'some-other-service', iss: 'evil', exp: now + 600 },
			secret,
		)
		expect(await p.toSyncAuthProvider().authenticate(other)).toBeNull()
	})
})

describe('AUTH-14: webhooks', () => {
	test('signature helper rejects a stale (replayed) payload', async () => {
		let captured: { body: string; sig: string } | null = null
		const fetchStub = (async (_u: string, init: RequestInit) => {
			captured = {
				body: String(init.body),
				sig: (init.headers as Record<string, string>)['X-Webhook-Signature'] as string,
			}
			return new Response('ok')
		}) as unknown as typeof fetch
		const mgr = new WebhookManager({ store: new InMemoryWebhookStore(), fetch: fetchStub })
		const ep = await mgr.register({
			url: 'https://hooks.example.com/kora',
			events: ['user.deleted'] as never,
		})
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(Date.now() - 24 * 3600_000) // delivery captured a day ago
		await mgr.dispatch('user.deleted' as never, { userId: 'u1' })
		vi.useRealTimers()
		expect(captured).not.toBeNull()
		const c = captured as unknown as { body: string; sig: string }
		// Replayed today, byte-for-byte: correct behavior is rejection.
		expect(await verifyWebhookSignature(c.body, c.sig, ep.secret)).toBe(false)
	})
	test('register() refuses link-local / loopback targets', async () => {
		const mgr = new WebhookManager({ store: new InMemoryWebhookStore() })
		await expect(
			mgr.register({
				url: 'http://169.254.169.254/latest/meta-data/',
				events: ['user.created' as never],
			}),
		).rejects.toThrow()
	})
})
