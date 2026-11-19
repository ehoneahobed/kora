import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

// Records when the store starts opening its database (the runtime's storage downloads begin
// there in a browser).
const adapterCalls = vi.hoisted(() => ({ times: [] as number[] }))
vi.mock('./adapter-resolver', async (importOriginal) => {
	const original = await importOriginal<typeof import('./adapter-resolver')>()
	return {
		...original,
		createAdapter: async (...args: Parameters<typeof original.createAdapter>) => {
			adapterCalls.times.push(Date.now())
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

/** A read endpoint that answers only when released. */
function heldEndpoint(): { release(): void; asked(): boolean } {
	let release: () => void = () => {}
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	let asked = false
	vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
		asked = true
		await gate
		const { queries } = JSON.parse(init.body) as { queries: Array<{ key: string }> }
		return new Response(
			JSON.stringify({
				frontier: 1,
				grantKey: 'g',
				results: queries.map((query) => ({
					key: query.key,
					status: 'ok',
					records: [],
					included: {},
					includedStatus: {},
					refreshed: [],
					absent: [],
				})),
			}),
			{ status: 200, headers: { 'content-type': 'application/json' } },
		)
	})
	return { release: () => release(), asked: () => asked }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

// In a browser the runtime chunk downloads while the first screen is answered; here its first
// import is slow (it is transformed), so it is loaded once up front.
beforeAll(async () => {
	await import('./runtime-app')
})

let app: KoraApp | null = null
afterEach(async () => {
	await app?.close().catch(() => {})
	app = null
	vi.unstubAllGlobals()
	adapterCalls.times = []
})

describe('the store waits for a read-through read in flight (S0 P7)', () => {
	test('the database opens only after the pending read is answered', async () => {
		const endpoint = heldEndpoint()
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:' },
			sync: {
				url: 'ws://localhost:1/kora',
				auth: async () => ({ token: 't' }),
				firstVisit: { readThrough: true },
			},
		})
		;(app as unknown as Record<string, CollectionAccessor>).todos?.where({}).subscribe(() => {})
		for (let turn = 0; turn < 100 && !endpoint.asked(); turn++) await sleep(5)
		expect(endpoint.asked()).toBe(true)
		// A provider reads `ready` after its first render: a request to open the store.
		const ready = app.ready

		await sleep(300)
		expect(adapterCalls.times).toHaveLength(0)

		const releasedAt = Date.now()
		endpoint.release()
		await ready
		expect(adapterCalls.times).toHaveLength(1)
		expect(adapterCalls.times[0]).toBeGreaterThanOrEqual(releasedAt)
	})
})
