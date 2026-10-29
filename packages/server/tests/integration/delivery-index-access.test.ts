/**
 * An access session reads the delivery visibility index (C2.5) and receives exactly what the
 * global scan would send it. The sources are the grant's, the memberships' (one per case of
 * `operationTouchesMemberships`) and the session's own node; a membership change ends the
 * chunk and the next read uses the sources of the new grant.
 *
 * Every scenario is played on one log twice, through the index and through the global scan
 * (`getOperationsAfterDeliveryIn` removed), and the delivered streams must be identical. The
 * index must also have returned the triggering operation itself, so a silent fallback to the
 * global scan cannot make the comparison pass.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import {
	type DeliveryIndexRead,
	type DeliverySources,
	partitionKey,
} from '../../src/store/delivery-partitions'
import type { DeliveredOperation } from '../../src/store/server-store'
import { type Harness, createHarness } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'edit', 'manage'],
		groups: { documents: { owner: 'ownerId', role: 'manage' } },
	},
	collections: {
		members: {
			fields: { userId: t.string(), group: t.string(), role: t.string() },
			access: { read: memberOfKey('group', 'manage') },
		},
		documents: {
			fields: { title: t.string(), ownerId: t.string().stamp('userId') },
			access: {
				read: member('id'),
				create: owner('ownerId'),
				update: member('id', 'edit'),
				delete: member('id', 'manage'),
			},
		},
		comments: {
			fields: { documentId: t.string(), body: t.string(), authorId: t.string().default('x') },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'view', { group: 'documents' }),
			},
		},
	},
})

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

type Context = ReturnType<Harness['server']['getKoraContext']>

/** A scenario writes a log; `isTrigger` names the operations the index must find for bob. */
interface Scenario {
	name: string
	write: (h: Harness, ctx: Context) => Promise<void>
	isTrigger: (op: DeliveredOperation) => boolean
}

let commentCounter = 0
async function comment(ctx: Context, documentId: string, body = 'b'): Promise<void> {
	commentCounter += 1
	await ctx.apply({
		collection: 'comments',
		type: 'insert',
		recordId: `c${commentCounter}`,
		data: { documentId, body },
	})
}
async function document(ctx: Context, id: string, ownerId: string): Promise<void> {
	await ctx.apply({
		collection: 'documents',
		type: 'insert',
		recordId: id,
		data: { title: `t-${id}`, ownerId },
	})
}
async function noise(ctx: Context, count: number): Promise<void> {
	// Other tenants' data: never visible to bob, and enough of it to span scan chunks.
	for (let i = 0; i < count; i++) await comment(ctx, 'documents-of-ann')
}

const SCENARIOS: Scenario[] = [
	{
		name: 'a membership row naming the user',
		write: async (h, ctx) => {
			await document(ctx, 'd1', 'ann')
			await document(ctx, 'd2', 'ann')
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await h.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
			// Written after the grant, in the same chunk: found only through the new sources.
			await comment(ctx, 'd1')
			await comment(ctx, 'd1')
			await comment(ctx, 'd2')
			await noise(ctx, 6)
			await comment(ctx, 'd1')
		},
		isTrigger: (d) => d.operation.collection === 'members',
	},
	{
		name: 'a group transferred to a user who held nothing in it',
		write: async (_h, ctx) => {
			await document(ctx, 'd1', 'ann')
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await ctx.apply({
				collection: 'documents',
				type: 'update',
				recordId: 'd1',
				data: { ownerId: 'bob' },
			})
			await comment(ctx, 'd1')
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await comment(ctx, 'd1')
		},
		isTrigger: (d) =>
			d.operation.collection === 'documents' &&
			d.operation.type === 'update' &&
			d.operation.data?.ownerId === 'bob',
	},
	{
		name: 'a group created with the user as its owner',
		write: async (_h, ctx) => {
			await document(ctx, 'd1', 'ann')
			await noise(ctx, 6)
			await document(ctx, 'd9', 'bob')
			await comment(ctx, 'd9')
			await comment(ctx, 'd9')
			await noise(ctx, 6)
			await comment(ctx, 'd9')
		},
		isTrigger: (d) => d.operation.collection === 'documents' && d.operation.recordId === 'd9',
	},
	{
		name: 'a group transferred away from the user',
		write: async (_h, ctx) => {
			await document(ctx, 'd1', 'bob')
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await ctx.apply({
				collection: 'documents',
				type: 'update',
				recordId: 'd1',
				data: { ownerId: 'ann' },
			})
			await comment(ctx, 'd1')
			await noise(ctx, 4)
			await comment(ctx, 'd1')
		},
		isTrigger: (d) =>
			d.operation.collection === 'documents' &&
			d.operation.type === 'update' &&
			d.operation.data?.ownerId === 'ann',
	},
	{
		name: 'deletion and restore of a group the user holds',
		write: async (h, ctx) => {
			await document(ctx, 'd1', 'ann')
			await comment(ctx, 'd1')
			await h.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await ctx.apply({ collection: 'documents', type: 'delete', recordId: 'd1', data: null })
			await comment(ctx, 'd1')
			await noise(ctx, 4)
			await ctx.apply({
				collection: 'documents',
				type: 'update',
				recordId: 'd1',
				data: { title: 'back' },
			})
			await comment(ctx, 'd1')
		},
		isTrigger: (d) =>
			d.operation.collection === 'documents' &&
			d.operation.recordId === 'd1' &&
			d.operation.type !== 'insert',
	},
	{
		name: 'the revival of a group the user holds only a membership row for',
		write: async (h, ctx) => {
			await document(ctx, 'd1', 'ann')
			await comment(ctx, 'd1')
			await ctx.apply({ collection: 'documents', type: 'delete', recordId: 'd1', data: null })
			await h.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
			await noise(ctx, 6)
			await ctx.apply({
				collection: 'documents',
				type: 'update',
				recordId: 'd1',
				data: { title: 'back' },
			})
			await comment(ctx, 'd1')
			await noise(ctx, 6)
			await comment(ctx, 'd1')
		},
		isTrigger: (d) =>
			d.operation.collection === 'documents' &&
			d.operation.recordId === 'd1' &&
			d.operation.type === 'update',
	},
]

/** What a client applies, in order: narrowings, retractions and operations, plus the watermark. */
function stream(messages: SyncMessage[], withIds = true): string[] {
	const out: string[] = []
	let watermark = 0
	for (const m of messages) {
		if (m.type !== 'operation-batch') continue
		const batch = m as unknown as {
			operations: Array<{ id: string; type: string; collection: string; recordId: string }>
			retractions?: Array<{ collection: string; recordId: string }>
			accessNarrowing?: unknown
			maxDeliverySequence?: number
		}
		if (batch.accessNarrowing !== undefined) {
			out.push(`narrow ${JSON.stringify(batch.accessNarrowing)}`)
		}
		for (const r of batch.retractions ?? []) out.push(`retract ${r.collection}/${r.recordId}`)
		for (const op of batch.operations) {
			out.push(`${op.type} ${op.collection}/${op.recordId}${withIds ? ` ${op.id}` : ''}`)
		}
		watermark = Math.max(watermark, batch.maxDeliverySequence ?? 0)
	}
	out.push(`watermark ${watermark}`)
	return out
}

interface IndexTrace {
	reads: Array<{ sources: DeliverySources; read: DeliveryIndexRead }>
	/** Operations the global scan returned (the tail above the index, or everything). */
	scanned: number
}

/** Plays one session through the index, and records what the store was asked. */
async function playThroughIndex(
	h: Harness,
	nodeId: string,
	handshake: Partial<SyncMessage> = FRESH,
): Promise<{ messages: SyncMessage[]; trace: IndexTrace }> {
	const store = h.store as unknown as {
		getOperationsAfterDeliveryIn?: (
			s: DeliverySources,
			a: number,
			l: number,
		) => Promise<DeliveryIndexRead>
		getOperationsAfterDelivery: (a: number, l: number) => Promise<DeliveredOperation[]>
	}
	const trace: IndexTrace = { reads: [], scanned: 0 }
	const indexRead = store.getOperationsAfterDeliveryIn
	const globalRead = store.getOperationsAfterDelivery
	if (indexRead) {
		store.getOperationsAfterDeliveryIn = async (sources, after, limit) => {
			const read = await indexRead.call(h.store, sources, after, limit)
			trace.reads.push({ sources, read })
			return read
		}
	}
	store.getOperationsAfterDelivery = async (after, limit) => {
		const rows = await globalRead.call(h.store, after, limit)
		trace.scanned += rows.length
		return rows
	}
	try {
		const bob = await h.login('bob', nodeId, handshake)
		await h.settle()
		await bob.client.disconnect()
		return { messages: bob.messages, trace }
	} finally {
		store.getOperationsAfterDeliveryIn = indexRead
		store.getOperationsAfterDelivery = globalRead
	}
}

/** Plays the same session with the index switched off. */
async function playThroughScan(
	h: Harness,
	nodeId: string,
	handshake: Partial<SyncMessage> = FRESH,
): Promise<SyncMessage[]> {
	const store = h.store as unknown as { getOperationsAfterDeliveryIn?: unknown }
	const indexRead = store.getOperationsAfterDeliveryIn
	store.getOperationsAfterDeliveryIn = undefined
	try {
		const bob = await h.login('bob', nodeId, handshake)
		await h.settle()
		await bob.client.disconnect()
		return bob.messages
	} finally {
		store.getOperationsAfterDeliveryIn = indexRead
	}
}

describe('access sessions read the delivery index', () => {
	for (const scenario of SCENARIOS) {
		test(`${scenario.name}: the same stream and re-scope unit as the global scan`, async () => {
			// Small batches: the scan chunk is 10, so every scenario spans several chunks
			// and the membership change falls inside one.
			const harness = await createHarness(schema, auth, { batchSize: 2 })
			await scenario.write(harness, harness.server.getKoraContext())
			await harness.store.whenDeliveryIndexIdle?.()

			const { messages: indexed, trace } = await playThroughIndex(harness, 'bob-node')
			const scanned = await playThroughScan(harness, 'bob-node')

			expect(stream(indexed)).toEqual(stream(scanned))
			expect(stream(scanned).length).toBeGreaterThanOrEqual(2)

			// The index answered, and the triggering operation came out of it.
			const log = await harness.store.getOperationsAfterDelivery(0, 10_000)
			const triggers = log.filter(scenario.isTrigger).map((d) => d.operation.id)
			expect(triggers.length).toBeGreaterThan(0)
			const returned = new Set(
				trace.reads
					.flatMap((r) => (r.read.complete ? r.read.operations : []))
					.map((d) => d.operation.id),
			)
			for (const id of triggers) expect(returned.has(id)).toBe(true)
			// No bulk global read: the log was covered, so the scan only checks the tail.
			expect(trace.scanned).toBe(0)
		})
	}

	test('a handshake probe and a stream of an access session scan nothing in bulk', async () => {
		const harness = await createHarness(schema, auth, { batchSize: 2 })
		const ctx = harness.server.getKoraContext()
		await document(ctx, 'd1', 'ann')
		await noise(ctx, 30)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await comment(ctx, 'd1')
		await harness.store.whenDeliveryIndexIdle?.()
		const { messages, trace } = await playThroughIndex(harness, 'bob-node')
		const scanned = await playThroughScan(harness, 'bob-node')
		// The handshake's version vector (the pre-pass) names the same nodes.
		const vector = (list: SyncMessage[]): string[] =>
			Object.keys(
				(
					list.find((m) => m.type === 'handshake-response') as unknown as {
						versionVector: Record<string, number>
					}
				).versionVector,
			).sort()
		expect(vector(messages)).toEqual(vector(scanned))
		expect(stream(messages)).toEqual(stream(scanned))
		// Thirty other-tenant operations were never read through the global scan.
		expect(trace.scanned).toBe(0)
		expect(trace.reads.length).toBeGreaterThanOrEqual(2)
	})
})

/** A scripted session that stays connected while the log changes under it. */
async function liveRun(useIndex: boolean): Promise<{ lines: string[]; indexReads: number }> {
	// Record ids repeat in both runs, so the two streams compare line by line.
	commentCounter = 0
	const harness = await createHarness(schema, auth, { batchSize: 2 })
	const store = harness.store as unknown as { getOperationsAfterDeliveryIn?: unknown }
	const original = store.getOperationsAfterDeliveryIn as
		| ((s: DeliverySources, a: number, l: number) => Promise<DeliveryIndexRead>)
		| undefined
	let indexReads = 0
	if (useIndex && original) {
		store.getOperationsAfterDeliveryIn = (s: DeliverySources, a: number, l: number) => {
			indexReads += 1
			return original.call(harness.store, s, a, l)
		}
	} else {
		store.getOperationsAfterDeliveryIn = undefined
	}
	const ctx = harness.server.getKoraContext()
	await document(ctx, 'd1', 'ann')
	await document(ctx, 'd2', 'ann')
	await document(ctx, 'd3', 'ann')
	await comment(ctx, 'd1')
	const bob = await harness.login('bob', 'bob-node', FRESH)
	const step = async (action: () => Promise<unknown>): Promise<void> => {
		await action()
		await harness.settle()
	}
	// Membership changes while the session is streaming, each followed by writes that the
	// new grant must (or must no longer) deliver.
	await step(() =>
		harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' }),
	)
	await step(() => comment(ctx, 'd1'))
	await step(() => comment(ctx, 'd2'))
	await step(() =>
		ctx.apply({
			collection: 'documents',
			type: 'update',
			recordId: 'd2',
			data: { ownerId: 'bob' },
		}),
	)
	await step(() => comment(ctx, 'd2'))
	await step(() => comment(ctx, 'd1'))
	await step(() => harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] }))
	await step(() => comment(ctx, 'd1'))
	await step(() => comment(ctx, 'd2'))
	await step(() =>
		ctx.apply({
			collection: 'documents',
			type: 'update',
			recordId: 'd2',
			data: { ownerId: 'ann' },
		}),
	)
	await step(() => comment(ctx, 'd2'))
	await step(() => document(ctx, 'd9', 'bob'))
	await step(() => comment(ctx, 'd9'))
	await step(() =>
		ctx.apply({ collection: 'documents', type: 'delete', recordId: 'd9', data: null }),
	)
	await step(() => comment(ctx, 'd9'))
	return { lines: stream(bob.messages, false), indexReads }
}

/**
 * A grant and the writes that follow it land while a push of a connected session is in
 * flight, so the push reads its chunk under sources computed BEFORE the grant. The chunk
 * holds the membership row but none of the group's later writes; the stream must end the
 * chunk at the row and read again under the new grant's sources.
 */
async function burstRun(useIndex: boolean): Promise<string[]> {
	commentCounter = 0
	const harness = await createHarness(schema, auth, { batchSize: 2 })
	const ctx = harness.server.getKoraContext()
	await document(ctx, 'd1', 'ann')
	await comment(ctx, 'd1')
	const bob = await harness.login('bob', 'bob-node', FRESH)
	const store = harness.store as unknown as Record<string, unknown>
	const method = useIndex ? 'getOperationsAfterDeliveryIn' : 'getOperationsAfterDelivery'
	const original = store[method] as (...args: unknown[]) => Promise<unknown>
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let reads = 0
	store[method] = async (...args: unknown[]) => {
		reads += 1
		if (reads === 1) await gate
		return original.apply(harness.store, args)
	}
	// Wakes the session: its push computes its sources, then waits at the gate.
	await comment(ctx, 'documents-of-ann')
	await vi.waitFor(() => expect(reads).toBe(1))
	await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
	for (let i = 0; i < 6; i++) await comment(ctx, 'd1')
	release()
	await harness.settle()
	return stream(bob.messages, false).filter((line) => !line.startsWith('watermark'))
}

/**
 * One scenario played into a connected session that holds nothing: the whole scenario lands
 * while the session's first push waits, so the push reads under the sources of a user with no
 * groups and must find every membership case through the membership sources alone.
 */
async function connectedScenario(
	useIndex: boolean,
	scenario: Scenario,
): Promise<{ lines: string[]; triggersReturned: boolean }> {
	commentCounter = 0
	const harness = await createHarness(schema, auth, { batchSize: 2 })
	const ctx = harness.server.getKoraContext()
	const bob = await harness.login('bob', 'bob-node', FRESH)
	const store = harness.store as unknown as Record<string, unknown>
	const method = useIndex ? 'getOperationsAfterDeliveryIn' : 'getOperationsAfterDelivery'
	const original = store[method] as (...args: unknown[]) => Promise<unknown>
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let reads = 0
	const returned = new Set<string>()
	store[method] = async (...args: unknown[]) => {
		reads += 1
		if (reads === 1) await gate
		const result = await original.apply(harness.store, args)
		for (const d of (result as DeliveryIndexRead).operations ?? []) returned.add(d.operation.id)
		return result
	}
	await comment(ctx, 'documents-of-ann')
	await vi.waitFor(() => expect(reads).toBe(1))
	await scenario.write(harness, ctx)
	release()
	await harness.settle()
	const log = await harness.store.getOperationsAfterDelivery(0, 10_000)
	const triggers = log.filter(scenario.isTrigger).map((d) => d.operation.id)
	expect(triggers.length).toBeGreaterThan(0)
	return {
		lines: stream(bob.messages, false).filter((line) => !line.startsWith('watermark')),
		triggersReturned: triggers.every((id) => returned.has(id)),
	}
}

describe('every membership case reaches a connected session through the index', () => {
	for (const scenario of SCENARIOS) {
		test(`${scenario.name}: found by the index, same stream as the global scan`, async () => {
			const indexed = await connectedScenario(true, scenario)
			const scanned = await connectedScenario(false, scenario)
			expect(indexed.lines).toEqual(scanned.lines)
			expect(indexed.triggersReturned).toBe(true)
		})
	}
})

describe('a connected access session follows membership changes through the index', () => {
	test('a grant inside a chunk read under the previous grant loses none of the writes after it', async () => {
		const indexed = await burstRun(true)
		const scanned = await burstRun(false)
		expect(indexed).toEqual(scanned)
		// The six comments written after the grant arrive as operations, not only as entries.
		expect(indexed.filter((line) => line.startsWith('insert comments/')).length).toBeGreaterThan(6)
	})

	test('delivers what the global scan delivers, in the same order', async () => {
		const withIndex = await liveRun(true)
		const withScan = await liveRun(false)
		expect(withIndex.indexReads).toBeGreaterThan(0)
		// Entries carry synthesized ids; the watermark line differs only by log length.
		const strip = (lines: string[]): string[] => lines.filter((l) => !l.startsWith('watermark'))
		expect(strip(withIndex.lines)).toEqual(strip(withScan.lines))
		expect(strip(withScan.lines).length).toBeGreaterThan(8)
	})
})

/**
 * A grant that the delivery poll installs while the stream of a connected session judges a
 * chunk (the chunk was read under the sources of the grant before it). The stream must not
 * carry on with those sources; the session ends up with exactly the global scan's stream.
 */
async function pollDuringChunkRun(
	useIndex: boolean,
): Promise<{ lines: string[]; scannedAfter: number }> {
	commentCounter = 0
	const harness = await createHarness(schema, auth, { batchSize: 2 })
	const ctx = harness.server.getKoraContext()
	await document(ctx, 'd1', 'ann')
	await document(ctx, 'd2', 'ann')
	await comment(ctx, 'd2')
	await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd2'], role: 'view' })
	const bob = await harness.login('bob', 'bob-node', FRESH)
	const store = harness.store as unknown as Record<string, unknown>
	const method = useIndex ? 'getOperationsAfterDeliveryIn' : 'getOperationsAfterDelivery'
	const original = store[method] as (...args: unknown[]) => Promise<unknown>
	let landed = false
	let counting = false
	let scannedAfter = 0
	store[method] = async (...args: unknown[]) => {
		const result = await original.apply(harness.store, args)
		if (!landed) {
			landed = true
			// The chunk is read; before it is judged the grant moves and the poll installs it.
			await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
			for (let i = 0; i < 4; i++) await comment(ctx, 'd1')
			await harness.server.pollDeliveryLog()
			counting = true
		}
		return result
	}
	// Rows the global scan returns from then on (the rest of the stream, or only its tail).
	const scan = store.getOperationsAfterDelivery as (...args: unknown[]) => Promise<unknown[]>
	const scanner = async (...args: unknown[]): Promise<unknown[]> => {
		const rows = await scan.apply(harness.store, args)
		if (counting) scannedAfter += rows.length
		return rows
	}
	store.getOperationsAfterDelivery = useIndex ? scanner : scan
	await comment(ctx, 'd2')
	await vi.waitFor(() => expect(landed).toBe(true))
	await harness.settle()
	return {
		lines: stream(bob.messages, false).filter((line) => !line.startsWith('watermark')),
		scannedAfter,
	}
}

describe('a grant installed by the delivery poll while a chunk is judged', () => {
	test('the session ends with the global scan stream', async () => {
		const indexed = await pollDuringChunkRun(true)
		const scanned = await pollDuringChunkRun(false)
		expect(indexed.lines).toEqual(scanned.lines)
		expect(indexed.lines.filter((l) => l.startsWith('insert comments/')).length).toBeGreaterThan(4)
		// The stale sources are dropped: the rest of that stream is read by global scan. (The
		// stream would be correct either way, because the membership row is still found; this
		// pins the safety net itself.)
		expect(indexed.scannedAfter).toBeGreaterThan(0)
	})
})

describe('the id key of a group the user holds', () => {
	for (const name of [
		'deletion and restore of a group the user holds',
		'the revival of a group the user holds only a membership row for',
	]) {
		test(`${name}: the session names it as a source`, async () => {
			const scenario = SCENARIOS.find((s) => s.name === name)
			if (!scenario) throw new Error(`no scenario named ${name}`)
			const harness = await createHarness(schema, auth, { batchSize: 2 })
			await scenario.write(harness, harness.server.getKoraContext())
			await harness.store.whenDeliveryIndexIdle?.()
			const { trace } = await playThroughIndex(harness, 'bob-node')
			const key = partitionKey('documents', 'id', 'd1')
			expect(trace.reads.some((r) => r.sources.partitionKeys.includes(key))).toBe(true)
		})
	}
})
