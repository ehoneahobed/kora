/**
 * RT-61 repro (Phase 3 red team, 2026-10-02): a device can hand-shake with the
 * server's own node id and author `merge('server-authoritative')` writes.
 *
 * The handshake response publishes `authoritativeNodeIds` (the store's node id). The
 * session reserves only the `kora:` namespace, and the server's node id is never
 * claimed in the node-claims table, so the first device to present it claims it.
 * Every operation it uploads then carries authority class 1 in the fold on the server
 * and on every device: a user overrides a field the server alone is meant to decide
 * (an approval, a balance, a role), whatever the server wrote, and its writes also
 * consume the server node's sequence space.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the server's decision stands.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { KoraSyncServer } from '../../src/server/kora-sync-server'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import { withContentId } from '../fixtures/content-id'
import { tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		tasks: {
			fields: {
				title: t.string(),
				owner: t.string(),
				status: t.string().merge('server-authoritative'),
			},
		},
	},
})

async function login(server: KoraSyncServer, nodeId: string) {
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
		authToken: 'alice-token',
		protocolVersion: 2,
		sequenceReservation: true,
	} as unknown as SyncMessage)
	await vi.waitFor(() =>
		expect(messages.some((m) => m.type === 'handshake-response' || m.type === 'error')).toBe(true),
	)
	await tick()
	const response = messages.find((m) => m.type === 'handshake-response') as
		| (SyncMessage & { accepted: boolean; authoritativeNodeIds?: string[] })
		| undefined
	return { client, messages, response }
}

function op(nodeId: string, seq: number, partial: Partial<Operation>): Operation {
	// A real content-addressed id: the server verifies every uploaded id (RT-64).
	return withContentId({
		id: `rt61-${nodeId}-${seq}`,
		nodeId,
		type: 'insert',
		collection: 'tasks',
		recordId: 'task-1',
		data: {},
		previousData: null,
		timestamp: { wallTime: Date.now(), logical: seq, nodeId },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...partial,
	})
}

describe('RT-61: a device claims the server node id', () => {
	test("a user cannot author server-authoritative writes under the server's node id", async () => {
		const store = new MemoryServerStore('server-1')
		await store.setSchema(schema)
		const auth = new TokenAuthProvider({
			validate: async (token) =>
				token === 'alice-token' ? { userId: 'alice', scopes: { tasks: { owner: 'alice' } } } : null,
		})
		const server = new KoraSyncServer({
			store,
			auth,
			relayRetransmitIntervalMs: 0,
			deliveryPollIntervalMs: 0,
		})

		// Alice, legitimately, learns the server's node id from the handshake.
		const alice = await login(server, 'alice-node')
		expect(alice.response?.accepted).toBe(true)
		// beta.14 (RT-62): the store authors under `kora:server:<deployment>:<instance>`;
		// the configured 'server-1' is a legacy server id, still advertised. Both are
		// the server's, and neither has history yet.
		const advertised = alice.response?.authoritativeNodeIds ?? []
		expect(advertised).toContain('server-1')
		expect(advertised).toContain(store.getNodeId())
		const serverNode = 'server-1'
		alice.client.send({
			type: 'operation-batch',
			messageId: 'b1',
			operations: [
				op('alice-node', 1, { data: { title: 'expense', owner: 'alice', status: 'pending' } }),
			],
			isFinal: true,
			batchIndex: 0,
		} as SyncMessage)
		await vi.waitFor(async () => expect(await store.findRecord('tasks', 'task-1')).toBeTruthy())

		await alice.client.disconnect()

		// Before the server has authored anything under its node id (a fresh server, or
		// one restarted with an auto-generated node id, RT-62), Alice reconnects
		// presenting that id: no owner and no history, so her session claims it.
		const forged = await login(server, serverNode as string)

		// The server (a moderator route) decides.
		const decision = await server.getKoraContext().apply({
			collection: 'tasks',
			type: 'update',
			recordId: 'task-1',
			data: { status: 'rejected' },
		})
		expect(decision.ok).toBe(true)
		expect(await store.findRecord('tasks', 'task-1')).toMatchObject({ status: 'rejected' })

		if (forged.response?.accepted) {
			forged.client.send({
				type: 'operation-batch',
				messageId: 'b2',
				operations: [
					op(serverNode as string, 900_000, {
						type: 'update',
						data: { status: 'approved' },
						previousData: { status: 'rejected' },
						timestamp: { wallTime: Date.now() + 1000, logical: 0, nodeId: serverNode as string },
					}),
				],
				isFinal: true,
				batchIndex: 0,
			} as SyncMessage)
			await tick(100)
		}
		// Correct: the handshake is refused (or the upload is), and the decision stands.
		expect(await store.findRecord('tasks', 'task-1')).toMatchObject({ status: 'rejected' })
		expect(forged.response?.accepted).not.toBe(true)
		// The current server node id is refused the same way.
		const current = await login(server, store.getNodeId())
		expect(current.response?.accepted).not.toBe(true)
		expect(current.messages.some((m) => m.type === 'error')).toBe(true)
		await server.stop()
	})
})
