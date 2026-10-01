/**
 * RT-2 repro (red team, 2026-10-01): HTTP long-poll binds every request to an
 * authenticated session by the caller-supplied `clientId` alone. The bearer token is
 * never checked after the handshake, so anyone who knows the id can read the user's
 * stream and write as the user. Asserts the CORRECT behaviour (fails before the fix).
 */
import { defineSchema, t } from '@korajs/core'
import { JsonMessageSerializer, type SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), userId: t.string() } } },
})

const json = new JsonMessageSerializer()

async function setup() {
	const store = new MemoryServerStore('server-1')
	await store.setSchema(schema)
	const auth = new TokenAuthProvider({
		validate: async (token) =>
			token === 'alice-token'
				? { userId: 'alice', scopes: { notes: { userId: 'alice' } }, metadata: { deviceId: 'd1' } }
				: token === 'bob-token'
					? { userId: 'bob', scopes: { notes: { userId: 'bob' } }, metadata: { deviceId: 'd9' } }
					: null,
	})
	const server = new KoraSyncServer({
		store,
		auth,
		serializer: json,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
	})
	return { store, server }
}

/** The victim opens an HTTP session and returns the handle the server bound it to. */
async function victimSession(server: KoraSyncServer): Promise<string> {
	const response = await server.handleHttpRequest({
		clientId: 'alice-laptop',
		method: 'POST',
		contentType: 'application/json',
		authorization: 'Bearer alice-token',
		body: json.encode({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'alice-node',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'alice-token',
		} as SyncMessage) as string,
	} as never)
	expect(response.status).toBe(202)
	await vi.waitFor(() => expect(server.getConnectionCount()).toBe(1))
	await tick()
	// Post-fix the server issues the session id; pre-fix the clientId is the handle.
	return response.headers?.['x-kora-session'] ?? 'alice-laptop'
}

describe('RT-2: HTTP long-poll session hijack', () => {
	test('the session handle is server-issued and high-entropy, not the caller-chosen clientId', async () => {
		const { server } = await setup()
		const handle = await victimSession(server)
		expect(handle).not.toBe('alice-laptop')
		expect(handle.length).toBeGreaterThanOrEqual(32)
		await server.stop()
	})

	test("a request without the victim's credential cannot read the victim's stream", async () => {
		const { server } = await setup()
		const handle = await victimSession(server)
		for (const authorization of [undefined, 'Bearer bob-token', 'Bearer forged']) {
			const poll = await server.handleHttpRequest({
				clientId: handle,
				sessionId: handle,
				method: 'GET',
				...(authorization ? { authorization } : {}),
			} as never)
			expect(poll.status).not.toBe(200)
			expect(poll.body).toBeUndefined()
		}
		await server.stop()
	})

	test("a request without the victim's credential cannot write as the victim", async () => {
		const { server, store } = await setup()
		const handle = await victimSession(server)
		const forged = makeOp('alice-node', 1, {
			recordId: 'planted',
			data: { title: 'planted by attacker', userId: 'alice' },
		})
		for (const authorization of [undefined, 'Bearer bob-token']) {
			const post = await server.handleHttpRequest({
				clientId: handle,
				sessionId: handle,
				method: 'POST',
				contentType: 'application/json',
				...(authorization ? { authorization } : {}),
				body: json.encode({
					type: 'operation-batch',
					messageId: `b-${String(authorization)}`,
					operations: [forged],
					isFinal: true,
					batchIndex: 0,
				} as SyncMessage) as string,
			} as never)
			expect(post.status).not.toBe(202)
		}
		await tick()
		expect(await store.findRecord('notes', 'planted')).toBeNull()
		await server.stop()
	})
})
