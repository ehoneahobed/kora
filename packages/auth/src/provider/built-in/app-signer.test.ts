import { describe, expect, test } from 'vitest'
import { AppSignerError, createAppSigner } from './app-signer'
import { authSecretFromEnv } from './quickstart-server'

describe('createAppSigner', () => {
	test('a signed value reads back; a changed or foreign token does not', () => {
		const links = createAppSigner('secret-a', 'share-link')
		const token = links.sign({ documentId: 'doc_1', role: 'viewer' })
		expect(links.verify(token)).toEqual({ documentId: 'doc_1', role: 'viewer' })

		const [body, mac] = token.split('.') as [string, string]
		const forged = Buffer.from(
			JSON.stringify({ v: { documentId: 'doc_2', role: 'editor' } }),
		).toString('base64url')
		expect(links.verify(`${forged}.${mac}`)).toBeNull()
		expect(links.verify(`${body}.${mac.slice(0, -2)}AA`)).toBeNull()
		expect(links.verify('')).toBeNull()
		expect(links.verify('no-dot')).toBeNull()
		expect(links.verify(`${body}.${mac}.extra`)).toBeNull()
		expect(createAppSigner('secret-b', 'share-link').verify(token)).toBeNull()
	})

	test('a token for one purpose is refused by another', () => {
		const token = createAppSigner('secret-a', 'share-link').sign({ id: 1 })
		expect(createAppSigner('secret-a', 'invite').verify(token)).toBeNull()
	})

	test('changing the secret keeps earlier tokens working while the old secret is listed', () => {
		const before = createAppSigner('old-secret', 'share-link').sign('doc_1')
		const env = { KORA_AUTH_SECRET: 'new-secret', KORA_AUTH_SECRET_PREVIOUS: 'old-secret' }
		const after = createAppSigner(authSecretFromEnv(env) ?? '', 'share-link')
		expect(after.verify(before)).toBe('doc_1')
		// New tokens use the current secret, so they keep working once the old one is dropped.
		const fresh = after.sign('doc_2')
		expect(createAppSigner('new-secret', 'share-link').verify(fresh)).toBe('doc_2')
		expect(createAppSigner('new-secret', 'share-link').verify(before)).toBeNull()
	})

	test('an expiring token works until it expires', () => {
		const links = createAppSigner('secret-a', 'share-link')
		const token = links.sign({ id: 1 }, { expiresInSeconds: 60, now: 1_000_000 })
		expect(links.verify(token, { now: 1_000_000 + 59_000 })).toEqual({ id: 1 })
		expect(links.verify(token, { now: 1_000_000 + 60_000 })).toBeNull()
	})

	test('mistakes in the app are reported clearly', () => {
		expect(() => createAppSigner('', 'share-link')).toThrow(AppSignerError)
		expect(() => createAppSigner([], 'share-link')).toThrow(/authSecretFromEnv/)
		expect(() => createAppSigner('s', 'has spaces')).toThrow(/purpose/)
		const links = createAppSigner('s', 'p')
		expect(() => links.sign(undefined)).toThrow(/JSON/)
		expect(() => links.sign(1n)).toThrow(/JSON/)
		expect(() => links.sign('x', { expiresInSeconds: 0 })).toThrow(/positive/)
		expect(() => links.sign('x'.repeat(10_000))).toThrow(/too large/)
	})
})
