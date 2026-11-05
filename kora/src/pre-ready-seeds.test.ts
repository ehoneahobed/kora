import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import type { CollectionAccessor, CollectionRecord } from '@korajs/store'
import { afterEach, describe, expect, test, vi } from 'vitest'

// The store opens when the first query subscribes; holding the adapter back stands in for a
// slow WASM and OPFS start, which is what an answer shown before the store opens races.
const openGate = vi.hoisted(() => ({ open: Promise.resolve(), hold: false, release: () => {} }))
vi.mock('./adapter-resolver', async (importOriginal) => {
	const original = await importOriginal<typeof import('./adapter-resolver')>()
	return {
		...original,
		createAdapter: async (...args: Parameters<typeof original.createAdapter>) => {
			if (openGate.hold) await openGate.open
			return original.createAdapter(...args)
		},
	}
})
import { createApp } from './create-app'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

function todos(app: KoraApp): CollectionAccessor {
	return (app as unknown as Record<string, CollectionAccessor>).todos as CollectionAccessor
}

const AT = Date.now() - 60_000
const hlc = { wallTime: AT, logical: 0, nodeId: 'server' }

function row(id: string, title: string) {
	return { id, values: { title }, fieldVersions: { title: hlc }, created: hlc, latest: hlc }
}

/** A read endpoint whose answer the test releases by hand. */
function readEndpoint(rows: ReturnType<typeof row>[]) {
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let gated = true
	vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
		if (gated) await gate
		const { queries } = JSON.parse(init.body) as { queries: Array<{ key: string }> }
		return new Response(
			JSON.stringify({
				frontier: 9,
				grantKey: 'g1',
				results: queries.map((query) => ({
					key: query.key,
					status: 'ok',
					records: rows,
					included: {},
					includedStatus: {},
					refreshed: [],
					absent: [],
				})),
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	})
	return {
		release: () => {
			gated = false
			release()
		},
		releaseNow: () => {
			gated = false
			release()
		},
	}
}

function newApp(): KoraApp {
	return createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: ':memory:' },
		sync: {
			url: 'ws://localhost:1/kora',
			auth: async () => ({ token: 't' }),
			firstVisit: { readThrough: true },
		},
	})
}

/** Let modules load and promises settle (real I/O), . */
async function until(condition: () => boolean): Promise<void> {
	for (let turn = 0; turn < 400 && !condition(); turn++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
}

const titles = (records: readonly CollectionRecord[]): string[] =>
	records.map((record) => String(record.title))

describe('a read-through answer carries over to the store (S4b, 5.5)', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.close().catch(() => {})
		app = null
		vi.unstubAllGlobals()
		openGate.hold = false
	})

	test('an answer shown before the store opens is not replaced by an empty first result', async () => {
		openGate.hold = true
		openGate.open = new Promise<void>((resolve) => {
			openGate.release = resolve
		})
		const endpoint = readEndpoint([row('a', 'Alpha'), row('b', 'Beta')])
		endpoint.releaseNow()
		app = newApp()
		const seen: string[][] = []
		todos(app)
			.where({})
			.orderBy('title')
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		await until(() => seen.length > 0)
		expect(seen).toEqual([['Alpha', 'Beta']])

		openGate.release()
		await app.ready
		await until(() => seen.length > 1)

		expect(seen.every((rows) => rows.length > 0)).toBe(true)
		expect(seen[seen.length - 1]).toEqual(['Alpha', 'Beta'])
		// The rows are in the store, not only on screen.
		const stored = await todos(app).where({}).orderBy('title').exec()
		expect(titles(stored)).toEqual(['Alpha', 'Beta'])
	})

	test('once the store has taken over, a late answer is not shown and nothing is seeded', async () => {
		const endpoint = readEndpoint([row('a', 'Alpha')])
		app = newApp()
		const seen: string[][] = []
		todos(app)
			.where({})
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		await app.ready
		await until(() => seen.length > 0)
		endpoint.release()
		for (let turn = 0; turn < 20; turn++) await new Promise<void>((r) => setTimeout(r, 5))
		expect(seen.every((rows) => rows.length === 0)).toBe(true)
		expect(await todos(app).where({}).exec()).toEqual([])
	})
})
