import { type Operation, defineSchema, t } from '@korajs/core'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { ClientSession } from '../../src/session/client-session'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { createServerTransportPair } from '../../src/transport/memory-server-transport'
import type { AuthProvider } from '../../src/types'

/**
 * LMS-11 (external report, Part D #11): delivery-stream scope lookups.
 *
 * These tests pin CORRECT behaviour that the report's proposed changes would break or
 * that bears on the "deny-set for __none__ scopes" request. They use the in-memory store
 * so they run hermetically; the Postgres timing/query-count benchmark lives in
 * LMS-11-pg.test.ts.
 */

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { schoolId: t.string(), title: t.string() } },
		grades: { fields: { schoolId: t.string(), score: t.number() } },
	},
})

let seq = 0
function mkOp(o: Partial<Operation> & Pick<Operation, 'collection' | 'recordId'>): Operation {
	seq += 1
	return {
		id: `op-${seq}`,
		nodeId: 'teacher-device',
		type: 'insert',
		data: null,
		previousData: null,
		timestamp: { wallTime: 1_000 + seq, logical: 0, nodeId: 'teacher-device' },
		sequenceNumber: seq,
		causalDeps: [],
		schemaVersion: 1,
		...o,
	}
}

function batches(messages: SyncMessage[]): OperationBatchMessage[] {
	return messages.filter((m): m is OperationBatchMessage => m.type === 'operation-batch')
}

async function firstSync(
	store: MemoryServerStore,
	auth: AuthProvider,
	handshake: Record<string, unknown> = {},
): Promise<OperationBatchMessage[]> {
	const { client, server } = createServerTransportPair()
	const messages: SyncMessage[] = []
	client.onMessage((m) => messages.push(m))
	const session = new ClientSession({ sessionId: 's', transport: server, store, auth })
	session.start()
	client.send({
		type: 'handshake',
		messageId: 'hs',
		nodeId: 'student-phone',
		versionVector: {},
		schemaVersion: 1,
		authToken: 'ok',
		lastDeliverySequence: 0,
		...handshake,
	} as SyncMessage)
	await vi.waitFor(() => expect(batches(messages).some((b) => b.isFinal)).toBe(true))
	return batches(messages)
}

describe('LMS-11: first-sync delivery correctness', () => {
	test('retract policy: a first sync (fromDeliverySeq 0) MUST still carry retractions (report fix #11.3 is unsafe)', async () => {
		// The stream itself creates client state: the insert is visible (its own data
		// carries schoolId=s1), so it is delivered; the later update moves the record to
		// s2. Without a retraction in the SAME stream the fresh client keeps a record that
		// is no longer in its scope. "No prior client state" is false.
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		await store.applyRemoteOperation(
			mkOp({ collection: 'lessons', recordId: 'L1', data: { schoolId: 's1', title: 'Intro' } }),
		)
		await store.applyRemoteOperation(
			mkOp({
				collection: 'lessons',
				recordId: 'L1',
				type: 'update',
				data: { schoolId: 's2' },
				previousData: { schoolId: 's1' },
			}),
		)
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u', scopes: { lessons: { schoolId: 's1' } } }),
		}
		const out = await firstSync(store, auth, { scopeExitPolicy: 'retract' })
		const delivered = out.flatMap((b) => b.operations.map((o) => o.recordId))
		const retracted = out.flatMap((b) => (b.retractions ?? []).map((r) => r.recordId))
		expect(delivered).toContain('L1')
		expect(retracted).toContain('L1')
	})

	test('a collection the auth provider omits (deny) must NOT be widened by the client handshake syncScope', async () => {
		// Kora already denies collections absent from the scope map with zero lookups,
		// which is the framework-native "deny-set". The LMS app's '__none__' sentinel is
		// an app convention; one reason an app might avoid plain omission is checked here.
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		await store.applyRemoteOperation(
			mkOp({ collection: 'grades', recordId: 'G1', data: { schoolId: 's9', score: 97 } }),
		)
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u', scopes: { lessons: { schoolId: 's1' } } }),
		}
		const out = await firstSync(store, auth, { syncScope: { grades: {} } })
		const delivered = out.flatMap((b) => b.operations.map((o) => `${o.collection}/${o.recordId}`))
		expect(delivered).not.toContain('grades/G1')
	})

	test('an auth-omitted collection must NOT become writable via the client handshake syncScope', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u', scopes: { lessons: { schoolId: 's1' } } }),
		}
		const { client, server } = createServerTransportPair()
		const messages: SyncMessage[] = []
		client.onMessage((m) => messages.push(m))
		const session = new ClientSession({ sessionId: 's', transport: server, store, auth })
		session.start()
		client.send({
			type: 'handshake',
			messageId: 'hs',
			nodeId: 'student-phone',
			versionVector: {},
			schemaVersion: 1,
			authToken: 'ok',
			lastDeliverySequence: 0,
			syncScope: { grades: {} },
		} as SyncMessage)
		await vi.waitFor(() => expect(session.getState()).toBe('streaming'))
		const forged = mkOp({
			collection: 'grades',
			recordId: 'G-forged',
			nodeId: 'student-phone',
			timestamp: { wallTime: 9_999_999, logical: 0, nodeId: 'student-phone' },
			sequenceNumber: 1,
			data: { schoolId: 's9', score: 100 },
		})
		client.send({
			type: 'operation-batch',
			messageId: 'b1',
			operations: [forged],
			isFinal: true,
			batchIndex: 0,
		} as unknown as SyncMessage)
		await vi.waitFor(() =>
			expect(
				messages.some((m) => m.type !== 'operation-batch' && m.type !== 'handshake-response'),
			).toBe(true),
		)
		const stored = await store.queryCollection('grades', { where: { id: 'G-forged' } })
		expect(stored).toHaveLength(0)
	})
})

describe('LMS-11: lookup counts (HEAD)', () => {
	test('retract policy issues a record lookup for EVERY out-of-scope op, even inserts/deletes that can never exit scope', async () => {
		const store = new MemoryServerStore('server')
		await store.setSchema(schema)
		const N = 200
		for (let i = 0; i < N; i++) {
			// 95% other schools, inserts carry schoolId so visibility needs no lookup
			const school = i % 20 === 0 ? 's1' : `s${2 + (i % 19)}`
			await store.applyRemoteOperation(
				mkOp({ collection: 'lessons', recordId: `L${i}`, data: { schoolId: school, title: 't' } }),
			)
		}
		const auth: AuthProvider = {
			authenticate: async () => ({ userId: 'u', scopes: { lessons: { schoolId: 's1' } } }),
		}
		const count = async (policy: 'retain' | 'retract'): Promise<number> => {
			const spy = vi.spyOn(store, 'queryCollection')
			await firstSync(store, auth, { scopeExitPolicy: policy })
			const n = spy.mock.calls.length
			spy.mockRestore()
			return n
		}
		const retain = await count('retain')
		const retract = await count('retract')
		console.log(
			`[LMS-11] ${N} insert ops, 5% in scope: lookups retain=${retain} retract=${retract}`,
		)
		expect(retain).toBe(0)
		// Correct behaviour: an insert cannot exit scope (operationExitsScopes returns false
		// for non-updates), so no lookup is needed. HEAD does N*0.95 lookups.
		expect(retract).toBe(0)
	})
})
