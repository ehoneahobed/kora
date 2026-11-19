import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import type { CollectionAccessor, CollectionRecord } from '@korajs/store'
import { afterEach, describe, expect, test, vi } from 'vitest'

// The answers chunk (`pre-ready-answers-loader`) arrives over the network on a first visit.
// Holding it back stands in for that round trip: the first read must not wait for it (S0 P2).
// One test per file: while this factory is pending, a second import gets the real module.
// A signed-out visitor sending nothing is covered in pre-ready-seeds.test.ts.
const loaderGate = vi.hoisted(() => {
	let release: () => void = () => {}
	const open = new Promise<void>((resolve) => {
		release = resolve
	})
	return { open, release: () => release() }
})
vi.mock('./pre-ready-answers-loader', async (importOriginal) => {
	await loaderGate.open
	return importOriginal<typeof import('./pre-ready-answers-loader')>()
})
// The store never opens in these tests: only the pre-ready path is under test.
vi.mock('./adapter-resolver', async (importOriginal) => {
	const original = await importOriginal<typeof import('./adapter-resolver')>()
	return { ...original, createAdapter: () => new Promise<never>(() => {}) }
})
import { createApp } from './create-app'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: { fields: { title: t.string() } },
		tags: { fields: { name: t.string() } },
	},
})

const hlc = { wallTime: Date.now() - 60_000, logical: 0, nodeId: 'server' }

interface Sent {
	url: string
	body: string
	authorization: string | undefined
}

function endpoint(): Sent[] {
	const sent: Sent[] = []
	vi.stubGlobal(
		'fetch',
		async (url: string, init: { body: string; headers: Record<string, string> }) => {
			sent.push({ url, body: init.body, authorization: init.headers.authorization })
			const { queries } = JSON.parse(init.body) as {
				queries: Array<{ key: string; collection: string }>
			}
			return new Response(
				JSON.stringify({
					frontier: 9,
					grantKey: 'g1',
					results: queries.map((query) => ({
						key: query.key,
						status: 'ok',
						records: [
							{
								id: `${query.collection}-1`,
								values: query.collection === 'todos' ? { title: 'Alpha' } : { name: 'red' },
								fieldVersions: query.collection === 'todos' ? { title: hlc } : { name: hlc },
								created: hlc,
								latest: hlc,
							},
						],
						included: {},
						includedStatus: {},
						refreshed: [],
						absent: [],
					})),
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		},
	)
	return sent
}

function accessor(app: KoraApp, name: string): CollectionAccessor {
	return (app as unknown as Record<string, CollectionAccessor>)[name] as CollectionAccessor
}

async function until(condition: () => boolean, turns = 400): Promise<void> {
	for (let turn = 0; turn < turns && !condition(); turn++) {
		await new Promise<void>((resolve) => setTimeout(resolve, 5))
	}
}

let app: KoraApp | null = null
afterEach(() => {
	// The store never opens here, so close() would wait for it: let it go in the background.
	void app?.close().catch(() => {})
	app = null
	vi.unstubAllGlobals()
})

describe('the first read does not wait for the answers chunk (S0 P2)', () => {
	test('it is sent before the chunk arrives, and the chunk reuses its response', async () => {
		const sent = endpoint()
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: {
				url: 'ws://localhost:1/kora',
				auth: async () => ({ token: 't' }),
				firstVisit: { readThrough: true },
			},
		})
		const seen: string[][] = []
		accessor(app, 'todos')
			.where({})
			.subscribe((records: CollectionRecord[]) => seen.push(records.map((r) => String(r.title))))
		accessor(app, 'tags')
			.where({})
			.subscribe(() => {})

		await until(() => sent.length > 0, 100)
		// Sent while the chunk is still held back, both queries of the turn in one request.
		expect(sent).toHaveLength(1)
		expect(sent[0]?.url).toBe('http://localhost:1/kora/read')
		expect(sent[0]?.authorization).toBe('Bearer t')
		expect((JSON.parse(sent[0]?.body ?? '{}') as { queries: unknown[] }).queries).toHaveLength(2)
		expect(seen).toEqual([])

		loaderGate.release()
		await until(() => seen.some((rows) => rows.length > 0))
		expect(seen[seen.length - 1]).toEqual(['Alpha'])
		// The chunk took over the request in flight instead of sending its own.
		expect(sent).toHaveLength(1)
	})
})
