/**
 * AUTH-11 repro: sync authentication happens only at handshake. After the user
 * revokes a device (or signs it out), the already-open sync session of that
 * device keeps uploading and receiving data indefinitely; the server offers no
 * re-validation or per-user/device session termination.
 * Asserts CORRECT behavior, so it FAILS today.
 */
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import { KoraSyncServer, MemoryServerStore } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { createKoraAuthServer } from '../../src/provider/built-in/quickstart-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string(), userId: t.string() }, scope: ['userId'] } },
})

function op(nodeId: string, userId: string, seq: number, title: string): Operation {
	return {
		id: `op-${nodeId}-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'todos',
		recordId: `r-${nodeId}-${seq}`,
		data: { title, userId },
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: 0, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
	}
}

describe('AUTH-11: live sync sessions survive revocation', () => {
	test('revoking a device cuts off its open sync session', async () => {
		const auth = createKoraAuthServer({ jwtSecret: 'l'.repeat(64) })
		const laptop = (
			await auth.handleRequest({
				method: 'POST',
				path: '/auth/signup',
				body: { email: 'u@example.com', password: 'password-123', deviceId: 'laptop' },
			})
		).body as { data: { user: { id: string }; tokens: { accessToken: string } } }
		const phone = (
			await auth.handleRequest({
				method: 'POST',
				path: '/auth/signin',
				body: { email: 'u@example.com', password: 'password-123', deviceId: 'phone' },
			})
		).body as { data: { tokens: { accessToken: string } } }
		const uid = laptop.data.user.id

		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const server = new KoraSyncServer({ store, auth: auth.auth })

		const conn = (token: string, nodeId: string) => {
			const { client, server: transport } = createServerTransportPair()
			const messages: SyncMessage[] = []
			client.onMessage((m) => messages.push(m))
			server.handleConnection(transport)
			client.send({
				type: 'handshake',
				messageId: `hs-${nodeId}`,
				nodeId,
				versionVector: {},
				schemaVersion: 1,
				authToken: token,
				syncScope: { todos: { userId: uid } },
			} as SyncMessage)
			return { client, messages }
		}
		const stolen = conn(laptop.data.tokens.accessToken, 'laptop')
		const owner = conn(phone.data.tokens.accessToken, 'phone')
		await vi.waitFor(() =>
			expect(stolen.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)
		await vi.waitFor(() =>
			expect(owner.messages.some((m) => m.type === 'handshake-response')).toBe(true),
		)

		// Owner revokes the stolen laptop.
		const r = await auth.handleRequest({
			method: 'DELETE',
			path: '/auth/device/laptop',
			headers: { authorization: `Bearer ${phone.data.tokens.accessToken}` },
		})
		expect(r.status).toBe(200)
		// A NEW handshake from the laptop is correctly refused...
		expect(await auth.auth.authenticate(laptop.data.tokens.accessToken)).toBeNull()

		// ...but the existing session continues to receive the owner's new data...
		owner.client.send({
			type: 'operation-batch',
			messageId: 'b-owner',
			operations: [op('phone', uid, 1, 'written after revocation')],
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		// ...and to write. (Once the fix closes the session, the in-memory client
		// transport refuses to send at all; that is the correct outcome, so a throw
		// here counts as "the write did not reach the server".)
		try {
			stolen.client.send({
				type: 'operation-batch',
				messageId: 'b-stolen',
				operations: [op('laptop', uid, 1, 'written by revoked device')],
				isFinal: true,
				batchIndex: 0,
			} as SyncMessage)
		} catch {
			// transport closed by the server
		}
		await new Promise((res) => setTimeout(res, 150))

		const got = stolen.messages.flatMap((m) => (m.type === 'operation-batch' ? m.operations : []))
		expect.soft(got.map((o) => o.data?.title)).not.toContain('written after revocation')
		const stored = await store.getOperationCount()
		expect(stored).toBe(1)
	})
})
