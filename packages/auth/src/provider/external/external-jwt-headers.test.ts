import { createHmac } from 'node:crypto'
import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import { ExternalJwtProvider } from './external-jwt-provider'

/**
 * Tokens from an external identity provider (Supabase, Auth0 with a shared secret...) carry
 * standard JWS headers: a `kid`, sometimes no `typ`, keys in any order. They are verified by
 * the header's meaning (alg HS256), not by its exact bytes. Any other algorithm is refused.
 */
const SECRET = 'kora-external-test-secret-must-be-32-chars-long'
const b64 = (value: string) => Buffer.from(value).toString('base64url')

function sign(header: Record<string, unknown> | string, claims: Record<string, unknown>): string {
	const head = b64(typeof header === 'string' ? header : JSON.stringify(header))
	const body = b64(JSON.stringify(claims))
	const signature = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url')
	return `${head}.${body}.${signature}`
}

const claims = () => ({
	sub: 'user-1',
	aud: 'authenticated',
	exp: Math.floor(Date.now() / 1000) + 3600,
})
const provider = new ExternalJwtProvider({ providerName: 'supabase', jwtSecret: SECRET })
const accepted = async (token: string) => (await provider.validateAccessToken(token)) !== null

describe('external HS256 tokens are verified by their header, not its exact bytes', () => {
	test('a header with a kid is accepted', async () => {
		expect(await accepted(sign({ alg: 'HS256', typ: 'JWT', kid: 'key-2025' }, claims()))).toBe(true)
	})

	test('a header without typ is accepted', async () => {
		expect(await accepted(sign({ alg: 'HS256' }, claims()))).toBe(true)
	})

	test('typ JWT in any case, and the access-token typ at+jwt (RFC 9068), are accepted', async () => {
		expect(await accepted(sign({ alg: 'HS256', typ: 'jwt' }, claims()))).toBe(true)
		expect(await accepted(sign({ alg: 'HS256', typ: 'at+jwt' }, claims()))).toBe(true)
	})

	test('a header with its keys in another order is accepted', async () => {
		expect(await accepted(sign('{"typ":"JWT","alg":"HS256"}', claims()))).toBe(true)
	})

	test('alg none, RS256 and HS512 are refused, even with a valid HMAC', async () => {
		for (const alg of ['none', 'RS256', 'HS512', 'hs256']) {
			expect(await accepted(sign({ alg, typ: 'JWT' }, claims())), alg).toBe(false)
		}
	})

	test('a header that names critical extensions is refused', async () => {
		expect(await accepted(sign({ alg: 'HS256', crit: ['b64'], b64: false }, claims()))).toBe(false)
	})

	test('a non-JWT typ, a header that is not an object, and a tampered signature are refused', async () => {
		expect(await accepted(sign({ alg: 'HS256', typ: 'at+jwt+other' }, claims()))).toBe(false)
		expect(await accepted(sign('["HS256"]', claims()))).toBe(false)
		const token = sign({ alg: 'HS256', kid: 'k' }, claims())
		expect(await accepted(`${token.slice(0, -2)}xx`)).toBe(false)
	})

	test('property: HS256 with any key order and extra fields verifies; any other alg never does', async () => {
		const extra = fc.dictionary(
			fc.string({ minLength: 1, maxLength: 6 }).filter((k) => !['alg', 'typ', 'crit'].includes(k)),
			fc.oneof(fc.string(), fc.integer()),
			{ maxKeys: 4 },
		)
		await fc.assert(
			fc.asyncProperty(
				extra,
				fc.boolean(),
				fc.constantFrom('HS256', 'none', 'RS256', 'ES256', 'HS384', 'HS512', 'HS256 '),
				async (fields, withTyp, alg) => {
					const header: Record<string, unknown> = { ...fields, alg }
					if (withTyp) header.typ = 'JWT'
					// Shuffle the key order.
					const shuffled = Object.fromEntries(Object.entries(header).reverse())
					expect(await accepted(sign(shuffled, claims()))).toBe(alg === 'HS256')
				},
			),
			{ numRuns: 200 },
		)
	})
})
