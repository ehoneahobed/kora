import {
	HybridLogicalClock,
	createOperation,
	defineSchema,
	foldRecord,
	serializeFoldState,
	t,
} from '@korajs/core'
import type { MergeTrace, Operation, SchemaDefinition } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

// RT-29: a server scope-entry insert restated the record's values with per-field
// versions only, so the device resolved every field by plain LWW against them:
// a counter lost the device's concurrent increment, a custom resolver was never
// called, and no MergeTrace explained the decision. With W7 the entry carries the
// record's fold state (`op.foldState`) and the device joins it per field kind.
const schema = defineSchema({
	version: 1,
	collections: {
		docs: {
			fields: {
				title: t.string(),
				views: t.number().merge('counter'),
				stock: t.number(),
				tags: t.array(t.string()),
			},
			resolve: {
				stock: (local, remote, base) => (local as number) + ((remote as number) - (base as number)),
			},
		},
	},
})

function clockAt(node: string, wall: number) {
	return new HybridLogicalClock(node, { now: () => wall } as never)
}

async function applyRemote(app: KoraApp, op: Operation) {
	const pipeline = (app.getStore() as unknown as { localMutationHandler: any }).localMutationHandler
	return pipeline.applyRemote(op)
}

describe('RT-29 scope entry merges every field kind', () => {
	let app: KoraApp
	afterEach(async () => {
		if (app) await app.close()
	})

	test('counter, resolver and array fields join the server state; traces explain it', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		await app.ready
		const docs = (app as unknown as Record<string, any>).docs
		const t0 = Date.now() - 60_000

		const insert = await createOperation(
			{
				nodeId: 'writer-a',
				type: 'insert',
				collection: 'docs',
				recordId: 'doc-1',
				data: { title: 'Doc', views: 1, stock: 10, tags: ['a'] },
				previousData: null,
				sequenceNumber: 1,
				causalDeps: [],
				schemaVersion: 1,
			},
			clockAt('writer-a', t0),
		)
		// Another device's concurrent edits, known to the server only.
		const other = await createOperation(
			{
				nodeId: 'writer-b',
				type: 'update',
				collection: 'docs',
				recordId: 'doc-1',
				data: { views: 4, stock: 13, tags: ['a', 'b'] },
				previousData: { views: 1, stock: 10, tags: ['a'] },
				sequenceNumber: 1,
				causalDeps: [insert.id],
				schemaVersion: 1,
			},
			clockAt('writer-b', t0 + 1),
		)

		await applyRemote(app, insert)
		// This device's concurrent edits (later HLC).
		await docs.update('doc-1', { views: 3, stock: 15, tags: ['a', 'c'] })

		// The record re-enters this device's scope: the server synthesizes an entry with
		// its current values, per-field versions and its fold state.
		const serverState = foldRecord([insert, other], schema as unknown as SchemaDefinition).state
		if (!serverState) throw new Error('no server state')
		const entry: Operation = {
			...insert,
			id: 'scope-entry-doc-1',
			nodeId: 'server',
			sequenceNumber: 7,
			data: { title: 'Doc', views: 4, stock: 13, tags: ['a', 'b'] },
			fieldVersions: {
				title: insert.timestamp,
				views: other.timestamp,
				stock: other.timestamp,
				tags: other.timestamp,
			},
			foldState: serializeFoldState(serverState),
		}
		const traces: MergeTrace[] = []
		app.events.on('merge:conflict', (event) => traces.push(event.trace))
		expect(await applyRemote(app, entry)).toBe('applied')

		const row = await docs.findById('doc-1')
		// Counter: 1 + 3 (other) + 2 (this device), not LWW's 3 or 4.
		expect(row.views).toBe(6)
		// Additive resolver: 10 + 3 + 5.
		expect(row.stock).toBe(18)
		// Element set: both concurrent adds.
		expect([...row.tags].sort()).toEqual(['a', 'b', 'c'])
		// Every field the server and this device disagreed on is explained.
		expect(traces.map((trace) => trace.field).sort()).toEqual(['stock', 'tags', 'views'])
		expect(traces.find((trace) => trace.field === 'views')?.strategy).toBe(
			'scope-entry-schema-counter',
		)
	})
})
