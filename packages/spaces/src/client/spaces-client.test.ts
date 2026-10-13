import { describe, expect, test } from 'vitest'
import { type SpacesAppLike, SpacesError, SpacesOfflineError, createSpaces } from './spaces-client'

type Rows = Array<Record<string, unknown>>

/** An app whose members collection holds `rows` (and can be updated by `push`). */
function appWith(rows: Rows): { app: SpacesAppLike; push(row: Record<string, unknown>): void } {
	const listeners = new Set<(rows: readonly Record<string, unknown>[]) => void>()
	const app: SpacesAppLike = {
		collections: {
			space_members: {
				where: (conditions) => ({
					subscribe(callback) {
						const matching = (): Rows =>
							rows.filter((row) => Object.entries(conditions).every(([k, v]) => row[k] === v))
						const listener = (): void => callback(matching())
						listeners.add(listener)
						queueMicrotask(listener)
						return () => listeners.delete(listener)
					},
				}),
			},
		},
	}
	return {
		app,
		push(row) {
			rows.push(row)
			for (const listener of listeners) listener(rows)
		},
	}
}

function respond(status: number, body: unknown, raw = false): typeof fetch {
	return async () =>
		new Response(raw ? String(body) : JSON.stringify(body), {
			status,
			headers: { 'content-type': raw ? 'text/html' : 'application/json' },
		})
}

const ACCEPTED = { space: ['forms', 'f1'], role: 'editor', userId: 'bob' }

describe('createSpaces', () => {
	test('a refusal is a SpacesError with the route’s code and status', async () => {
		const spaces = createSpaces(appWith([]).app, {
			fetch: respond(403, { error: { code: 'FORBIDDEN', message: 'No.' } }),
		})
		const error = await spaces.leave(['forms', 'f1']).catch((e: unknown) => e)
		expect(error).toBeInstanceOf(SpacesError)
		expect(error).toMatchObject({ code: 'FORBIDDEN', status: 403, message: 'No.' })
	})

	test('a page that is not the routes’ JSON (a captive portal) counts as offline, even with 200', async () => {
		const portal = createSpaces(appWith([]).app, {
			fetch: respond(200, '<html>Sign in to Wi-Fi</html>', true),
		})
		await expect(portal.accept('t')).rejects.toBeInstanceOf(SpacesOfflineError)
		const proxy = createSpaces(appWith([]).app, {
			fetch: respond(502, '<html>Bad gateway</html>', true),
		})
		await expect(proxy.leave(['forms', 'f1'])).rejects.toBeInstanceOf(SpacesOfflineError)
	})

	test('accept waits for the membership with the accepted role, not a leftover row', async () => {
		const { app, push } = appWith([{ group: 'forms:f1', userId: 'bob', role: 'viewer' }])
		const spaces = createSpaces(app, { fetch: respond(200, ACCEPTED) })
		const result = spaces.accept('t', { timeoutMs: 2000 })
		await new Promise((resolve) => setTimeout(resolve, 20))
		push({ group: 'forms:f1', userId: 'bob', role: 'editor' })
		expect(await result).toMatchObject({ role: 'editor', pending: false })
	})

	test('accept resolves pending after the timeout when the membership has not arrived', async () => {
		const spaces = createSpaces(appWith([]).app, { fetch: respond(200, ACCEPTED) })
		expect(await spaces.accept('t', { timeoutMs: 30 })).toMatchObject({ pending: true })
	})

	test('sends the app’s headers and JSON to basePath on baseUrl', async () => {
		const seen: Array<{ url: string; init?: RequestInit }> = []
		const spaces = createSpaces(appWith([]).app, {
			baseUrl: 'https://api.example.com/',
			basePath: '/sharing/',
			headers: async () => ({ authorization: 'Bearer abc' }),
			fetch: async (url, init) => {
				seen.push({ url: String(url), init })
				return new Response(
					JSON.stringify({ space: ['forms', 'f1'], invitationsRevoked: 0, changed: true }),
					{ status: 200 },
				)
			},
		})
		await spaces.changeRole(['forms', 'f1'], 'bob', 'viewer', { from: 'editor' })
		expect(seen[0]?.url).toBe('https://api.example.com/sharing/members/role')
		expect(seen[0]?.init?.method).toBe('POST')
		expect((seen[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer abc')
		expect(JSON.parse(String(seen[0]?.init?.body))).toEqual({
			space: ['forms', 'f1'],
			userId: 'bob',
			role: 'viewer',
			from: 'editor',
		})
	})
})
