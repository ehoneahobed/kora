/**
 * Sharing with `@korajs/auth`: an invitee whose address is not verified is refused,
 * verifies it with the link the auth server emails, and then accepts.
 */
import { createKoraAuthServer } from '@korajs/auth/server'
import { MemoryServerStore, createKoraServer } from '@korajs/server'
import { expect, test } from 'vitest'
import { koraAuthIdentity, spacesRoutes } from '../../src/server'
import { codeOf, schema, sharing } from './fixture'

test('an unverified invitee verifies their address, then accepts', async () => {
	const verificationLinks: Array<{ to: string; url: string }> = []
	const invitations: Array<{ email: string; url: string }> = []
	const auth = createKoraAuthServer({
		jwtSecret: 'a'.repeat(64),
		emailVerification: {
			url: (token) => `https://app.test/verify-email#${token}`,
			send: (message) => {
				verificationLinks.push(message)
			},
			sendOnSignUp: false,
		},
	})
	const store = new MemoryServerStore()
	await store.setSchema(schema, { accessRulesEnforced: true })
	const server = createKoraServer({
		store,
		experimentalAccessRules: true,
		accessSweepIntervalMs: 0,
	})
	const route = spacesRoutes({
		sharing,
		...koraAuthIdentity(auth),
		acceptUrl: (token) => `https://app.test/invite#${token}`,
		deliverInvitation: ({ email, url }) => {
			invitations.push({ email, url })
		},
	})
	const signUp = async (email: string): Promise<{ id: string; token: string }> => {
		const response = await auth.handleRequest({
			method: 'POST',
			path: '/auth/signup',
			body: { email, password: 'password123', name: email },
			ip: '127.0.0.1',
		})
		if (!('data' in response.body)) throw new Error('signup failed')
		const data = response.body.data as { user: { id: string }; tokens: { accessToken: string } }
		return { id: data.user.id, token: data.tokens.accessToken }
	}
	const call = (token: string, path: string, body: unknown) =>
		route.handle({
			method: 'POST',
			path: `/api/spaces${path}`,
			body,
			headers: { authorization: `Bearer ${token}` },
			kora: server.getKoraContext(),
			access: server.access,
		})
	const fragment = (url: string) => url.slice(url.indexOf('#') + 1)

	const ann = await signUp('ann@example.com')
	const bob = await signUp('bob@example.com')
	await server.getKoraContext().apply({
		collection: 'forms',
		type: 'insert',
		recordId: 'f1',
		data: { title: 'Survey', ownerId: ann.id },
	})
	expect(
		(
			await call(ann.token, '/invitations/create', {
				space: ['forms', 'f1'],
				email: 'bob@example.com',
				role: 'editor',
			})
		).status,
	).toBe(200)
	const invite = fragment(invitations[0]?.url ?? '')

	// Not verified yet: the accept page says so, and accepting is refused.
	expect((await call(bob.token, '/invitations/describe', { token: invite })).body).toMatchObject({
		match: 'unverified',
	})
	expect(codeOf(await call(bob.token, '/invitations/accept', { token: invite }))).toBe(
		'EMAIL_NOT_VERIFIED',
	)

	// The accept page offers verification; bob opens the emailed link, signed in.
	const sent = await auth.handleRequest({
		method: 'POST',
		path: '/auth/email/send-verification',
		headers: { authorization: `Bearer ${bob.token}` },
	})
	expect(sent.status).toBe(200)
	expect(verificationLinks[0]?.to).toBe('bob@example.com')
	const verified = await auth.handleRequest({
		method: 'POST',
		path: '/auth/email/verify',
		body: { token: fragment(verificationLinks[0]?.url ?? '') },
		headers: { authorization: `Bearer ${bob.token}` },
	})
	expect(verified.status).toBe(200)

	// The same session now accepts.
	expect((await call(bob.token, '/invitations/accept', { token: invite })).status).toBe(200)
	expect((await server.access.roleOf(bob.id, ['forms', 'f1']))?.role).toBe('editor')
	await server.stop?.()
})
