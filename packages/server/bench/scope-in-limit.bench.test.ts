/**
 * Cost of large `$in` scope grants (F17), on SQLite and (with KORA_PG_TEST_URL) Postgres.
 *
 * Models a documents app: every record carries a `spaceId`; a user's grant is
 * `spaceId $in [every space they belong to]`. For grants of 1 (baseline), 100, 1,000
 * and 5,000 values it measures, against a log of SEED_OPS operations spread over
 * SPACES spaces (the readable data is the same 400 operations for every size):
 *
 * - handshake: a fresh device's initial sync, handshake to final batch (the server
 *   reads the whole log after the device's watermark and tests each operation
 *   against the grant);
 * - revalidation: one `revalidateSessions()` pass over LIVE_SESSIONS sessions that
 *   all hold the grant (re-authentication, scope resolution and comparison);
 * - delivery: LIVE_OPS server-authored writes fanned out to the live sessions, half
 *   inside the grant, timed until every session holds every in-scope write.
 *
 * Run: pnpm --filter @korajs/server bench:scope-in
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Operation, defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../src/auth/token-auth'
import { KoraSyncServer } from '../src/server/kora-sync-server'
import { createPostgresServerStore } from '../src/store/postgres-server-store'
import type { ServerStore } from '../src/store/server-store'
import { createSqliteServerStore } from '../src/store/sqlite-server-store'
import { createServerTransportPair } from '../src/transport/memory-server-transport'
import { withContentId } from '../tests/fixtures/content-id'

const SIZES = (process.env.KORA_BENCH_SIZES ?? '1,100,1000,5000').split(',').map(Number)
const SPACES = 5_000
const SEED_OPS = Number(process.env.KORA_BENCH_SEED_OPS ?? 20_000)
const LIVE_SESSIONS = 20
const LIVE_OPS = 200
const RUNS = 3

const schema = defineSchema({
	version: 1,
	collections: { docs: { fields: { spaceId: t.string(), title: t.string() } } },
})

const spaceIds = Array.from({ length: SPACES }, (_, i) => `doc:${String(i).padStart(5, '0')}`)

// The data a session can read is the same for every grant size: the first 100 spaces
// (400 operations). Larger grants add spaces that hold nothing (a user who belongs to
// many empty or quiet spaces), so the timings isolate the cost of the predicate itself:
// every operation outside the grant is compared against all of its values.
const DATA_SPACES_IN_GRANT = 100

function grantFor(token: string): string[] {
	const size = Number(token.split(':')[1])
	const data = spaceIds.slice(0, Math.min(size, DATA_SPACES_IN_GRANT))
	const empty = Array.from({ length: Math.max(0, size - data.length) }, (_, i) => `empty:${i}`)
	return [...data, ...empty]
}

const auth = new TokenAuthProvider({
	validate: async (token) => ({
		userId: token.split(':')[0] ?? token,
		scopes: { docs: { spaceId: { $in: grantFor(token) } } },
	}),
})

interface Row {
	store: string
	values: number
	handshakeMs: number
	inScopeOps: number
	revalidateMs: number
	revalidatePerSessionMs: number
	deliveryMs: number
	deliveryPerOpMs: number
}

const rows: Row[] = []
const cleanups: Array<() => Promise<void>> = []

afterAll(async () => {
	for (const cleanup of cleanups) await cleanup()
	console.log('\n$in scope cost (median of 3 runs)')
	console.table(rows)
})

async function seed(store: ServerStore): Promise<void> {
	await store.setSchema(schema)
	const nodeId = 'seed-node'
	const base = Date.now() - 3_600_000
	for (let i = 0; i < SEED_OPS; i++) {
		const op: Operation = withContentId({
			id: '',
			nodeId,
			type: 'insert',
			collection: 'docs',
			recordId: `doc-${i}`,
			data: { spaceId: spaceIds[i % SPACES] as string, title: `Doc ${i}` },
			previousData: null,
			timestamp: { wallTime: base + i, logical: 0, nodeId },
			sequenceNumber: i + 1,
			causalDeps: [],
			schemaVersion: 1,
		})
		await store.applyRemoteOperation(op)
	}
}

interface Client {
	messages: SyncMessage[]
	finalAt: number | null
	received: Set<string>
	disconnect: () => void
}

function connect(server: KoraSyncServer, token: string, nodeId: string): Client {
	const { client, server: transport } = createServerTransportPair()
	const state: Client = {
		messages: [],
		finalAt: null,
		received: new Set(),
		disconnect: () => client.disconnect(),
	}
	client.onMessage((m) => {
		if (m.type === 'operation-batch') {
			for (const op of m.operations as Operation[]) state.received.add(op.recordId)
			if (m.isFinal && state.finalAt === null) state.finalAt = performance.now()
			client.send({
				type: 'acknowledgment',
				messageId: `ack-${m.messageId}`,
				acknowledgedMessageId: m.messageId,
				lastSequenceNumber: 0,
				...((m as { maxDeliverySequence?: number }).maxDeliverySequence !== undefined
					? { deliverySequence: (m as { maxDeliverySequence: number }).maxDeliverySequence }
					: {}),
			} as SyncMessage)
		} else {
			state.messages.push(m)
		}
	})
	server.handleConnection(transport)
	client.send({
		type: 'handshake',
		messageId: `hs-${nodeId}`,
		nodeId,
		versionVector: {},
		schemaVersion: 1,
		authToken: token,
		lastDeliverySequence: 0,
	} as SyncMessage)
	return state
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	return Number((sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1))
}

async function benchStore(label: string, store: ServerStore): Promise<void> {
	await seed(store)
	const server = new KoraSyncServer({
		store,
		auth,
		relayRetransmitIntervalMs: 0,
		deliveryPollIntervalMs: 0,
		sessionRevalidationIntervalMs: 0,
		maxScopePredicateValues: Math.max(...SIZES),
	})
	cleanups.push(() => server.stop())
	let session = 0

	for (const size of SIZES) {
		const expectedInScope = Math.ceil(SEED_OPS / SPACES) * Math.min(size, DATA_SPACES_IN_GRANT)
		const handshakes: number[] = []
		for (let run = 0; run < RUNS; run++) {
			session += 1
			const started = performance.now()
			const c = connect(server, `u${session}:${size}`, `n-${label}-${session}`)
			await vi.waitFor(() => expect(c.finalAt).not.toBeNull(), { timeout: 600_000, interval: 2 })
			handshakes.push((c.finalAt as number) - started)
			expect([...c.received].filter((id) => id.startsWith('doc-')).length).toBe(expectedInScope)
			c.disconnect()
		}

		const live: Client[] = []
		for (let i = 0; i < LIVE_SESSIONS; i++) {
			session += 1
			const c = connect(server, `u${session}:${size}`, `n-${label}-${session}`)
			await vi.waitFor(() => expect(c.finalAt).not.toBeNull(), { timeout: 600_000, interval: 2 })
			live.push(c)
		}

		const revalidations: number[] = []
		for (let run = 0; run < RUNS; run++) {
			const started = performance.now()
			const ended = await server.revalidateSessions()
			revalidations.push(performance.now() - started)
			expect(ended).toBe(0)
		}

		const deliveries: number[] = []
		for (let run = 0; run < RUNS; run++) {
			const ids: string[] = []
			const started = performance.now()
			for (let i = 0; i < LIVE_OPS; i++) {
				const inScope = i % 2 === 0
				const recordId = `live-${label}-${size}-${run}-${i}`
				if (inScope) ids.push(recordId)
				const space = inScope
					? spaceIds[(i * 7) % Math.min(size, DATA_SPACES_IN_GRANT)]
					: spaceIds[SPACES - 1 - (i % 100)]
				const result = await server.getKoraContext().apply({
					collection: 'docs',
					type: 'insert',
					recordId,
					data: { spaceId: space as string, title: 'live' },
				})
				expect(result.ok).toBe(true)
			}
			await vi.waitFor(
				() => {
					for (const c of live) for (const id of ids) expect(c.received.has(id)).toBe(true)
				},
				{ timeout: 600_000, interval: 5 },
			)
			deliveries.push(performance.now() - started)
		}
		for (const c of live) c.disconnect()

		rows.push({
			store: label,
			values: size,
			handshakeMs: median(handshakes),
			inScopeOps: expectedInScope,
			revalidateMs: median(revalidations),
			revalidatePerSessionMs: Number((median(revalidations) / LIVE_SESSIONS).toFixed(2)),
			deliveryMs: median(deliveries),
			deliveryPerOpMs: Number((median(deliveries) / LIVE_OPS).toFixed(2)),
		})
	}
}

describe('F17: $in scope predicate cost', () => {
	test('SQLite', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-bench-'))
		cleanups.push(async () => rmSync(dir, { recursive: true, force: true }))
		await benchStore('sqlite', createSqliteServerStore({ filename: join(dir, 'bench.db') }))
	})

	test.skipIf(!process.env.KORA_PG_TEST_URL)('Postgres', async () => {
		const store = await createPostgresServerStore({
			connectionString: process.env.KORA_PG_TEST_URL as string,
		})
		cleanups.push(() => store.close())
		await benchStore('postgres', store)
	})
})
