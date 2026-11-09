import 'fake-indexeddb/auto'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { AuthSyncState } from '@korajs/core/bindings'
import { runAllowingPreReadyWrites } from '@korajs/core/lite'
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

function newAuthClientApp(state: AuthSyncState, token = 'binding-token'): KoraApp {
	return createApp({
		schema,
		store: { adapter: 'better-sqlite3', name: ':memory:' },
		sync: {
			url: 'ws://localhost:1/kora',
			authClient: { auth: async () => ({ token }), resolveSyncState: async () => state },
			firstVisit: { readThrough: true },
		},
	})
}

/** Let modules load and promises settle (real I/O), . */
async function until(condition: () => boolean, turns = 400): Promise<void> {
	for (let turn = 0; turn < turns && !condition(); turn++) {
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

	test('a write made before the store opens shows on the answered screen at once', async () => {
		openGate.hold = true
		openGate.open = new Promise<void>((resolve) => {
			openGate.release = resolve
		})
		const endpoint = readEndpoint([row('a', 'Alpha')])
		endpoint.releaseNow()
		app = newApp()
		const seen: string[][] = []
		todos(app)
			.where({})
			.orderBy('title')
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		await until(() => seen.length > 0)
		expect(seen[seen.length - 1]).toEqual(['Alpha'])

		// The store is still closed: the insert waits in the queue, and the screen shows it.
		// (A framework hook, useMutation, is what allows a write before ready.)
		const written = runAllowingPreReadyWrites(() =>
			todos(app as KoraApp).insert({ title: 'Gamma' }),
		)
		await until(() => seen[seen.length - 1]?.length === 2)
		expect(seen[seen.length - 1]).toEqual(['Alpha', 'Gamma'])

		openGate.release()
		await written
		await app.ready
		await until(() => seen[seen.length - 1]?.length === 2 && seen.length > 2)
		expect(titles(await todos(app).where({}).orderBy('title').exec())).toEqual(['Alpha', 'Gamma'])
	})

	test('coverage: server while answered from memory, then a local result that is not complete while the scope is still arriving', async () => {
		openGate.hold = true
		openGate.open = new Promise<void>((resolve) => {
			openGate.release = resolve
		})
		const endpoint = readEndpoint([row('a', 'Alpha')])
		endpoint.releaseNow()
		app = newApp()
		const coverage: Array<{ source: string; complete: boolean }> = []
		todos(app)
			.where({})
			.subscribe(() => {}, {
				onCoverage: (value: { source: string; complete: boolean }) => coverage.push(value),
			})
		await until(() => coverage.length > 0)
		expect(coverage).toEqual([{ source: 'server', complete: true }])

		openGate.release()
		await app.ready
		await until(() => coverage.length > 1)
		// The sync endpoint is unreachable here: nothing of the scope arrived, so the local rows
		// are not claimed to be the whole answer.
		expect(coverage[coverage.length - 1]).toEqual({ source: 'local', complete: false })
	})

	test('coverage: a local-only app is local and complete', async () => {
		const local = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		try {
			const coverage: Array<{ source: string; complete: boolean }> = []
			todos(local)
				.where({})
				.subscribe(() => {}, {
					onCoverage: (value: { source: string; complete: boolean }) => coverage.push(value),
				})
			await local.ready
			await until(() => coverage.length > 0)
			expect(coverage[coverage.length - 1]).toEqual({ source: 'local', complete: true })
		} finally {
			await local.close().catch(() => {})
		}
	})

	test('once the store has taken over, a late answer is not shown and nothing is seeded', async () => {
		const endpoint = readEndpoint([row('a', 'Alpha')])
		app = newApp()
		const seen: string[][] = []
		todos(app)
			.where({})
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		// Reading `ready` (a provider does) does not end the wait for the first answer; the wait
		// itself does, so the store takes over before the answer arrives.
		await until(() => seen.length > 0)
		endpoint.release()
		for (let turn = 0; turn < 20; turn++) await new Promise<void>((r) => setTimeout(r, 5))
		expect(seen.every((rows) => rows.length === 0)).toBe(true)
		expect(await todos(app).where({}).exec()).toEqual([])
	})
})

describe('read-through and a device that already holds its replica (design 5.3)', () => {
	let app: KoraApp | null = null
	const subscriptions: Array<() => void> = []
	const unsubscribeAll = (): void => {
		for (const stop of subscriptions.splice(0)) stop()
	}
	afterEach(async () => {
		unsubscribeAll()
		openGate.release()
		await app?.close().catch(() => {})
		app = null
		vi.unstubAllGlobals()
		openGate.hold = false
	})

	function storedKeys(entries: Record<string, string>): void {
		const values = new Map(Object.entries(entries))
		vi.stubGlobal('localStorage', {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => void values.set(key, value),
			removeItem: (key: string) => void values.delete(key),
		})
	}

	function countingEndpoint() {
		const calls: string[] = []
		vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
			calls.push(url)
			const { queries } = JSON.parse(init.body) as { queries: Array<{ key: string }> }
			return new Response(
				JSON.stringify({
					frontier: 9,
					grantKey: 'g1',
					results: queries.map((query) => ({
						key: query.key,
						status: 'ok',
						records: [row('a', 'From the server')],
						included: {},
						includedStatus: {},
						refreshed: [],
						absent: [],
					})),
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		})
		return calls
	}

	const COMPLETE = {
		'kora:db::memory:': JSON.stringify({ v: 1, epoch: 'e1', backend: 'opfs' }),
		'kora:replica-complete::memory:': 'e1',
	}

	function holdStoreOpen(): void {
		openGate.hold = true
		openGate.open = new Promise<void>((resolve) => {
			openGate.release = resolve
		})
	}

	test('a completed replica sends no read request and the store answers', async () => {
		storedKeys(COMPLETE)
		holdStoreOpen()
		const calls = countingEndpoint()
		app = newApp()
		const seen: string[][] = []
		subscriptions.push(
			todos(app)
				.where({})
				.orderBy('title')
				.subscribe((records: CollectionRecord[]) => seen.push(titles(records))),
		)
		await new Promise<void>((resolve) => setTimeout(resolve, 100))
		expect(calls).toEqual([])
		openGate.release()
		await app.ready
		await until(() => seen.length > 0)
		expect(calls).toEqual([])
		expect(seen.flat()).not.toContain('From the server')
	})

	test('a completed replica does not wait for an answer before the store opens', async () => {
		storedKeys(COMPLETE)
		countingEndpoint()
		const started = Date.now()
		app = newApp()
		await app.ready
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	test('a database whose first download never finished still reads through', async () => {
		storedKeys({ 'kora:db::memory:': COMPLETE['kora:db::memory:'] })
		holdStoreOpen()
		const calls = countingEndpoint()
		app = newApp()
		const seen: string[][] = []
		subscriptions.push(
			todos(app)
				.where({})
				.orderBy('title')
				.subscribe((records: CollectionRecord[]) => seen.push(titles(records))),
		)
		await until(() => seen.flat().includes('From the server'))
		expect(calls.length).toBeGreaterThan(0)
		expect(seen.flat()).toContain('From the server')
		openGate.release()
		await app.ready
	})

	test('a per-user database is judged for the user signing in, not another one', async () => {
		const base = join(mkdtempSync(join(tmpdir(), 'kora-replica-')), 'kora-docs')
		const name = `${base}__user_b`
		storedKeys({
			[`kora:db:${name}`]: JSON.stringify({ v: 1, epoch: 'e1', backend: 'opfs' }),
			[`kora:replica-complete:${name}`]: 'e1',
		})
		holdStoreOpen()
		const calls = countingEndpoint()
		const open = (user: string): KoraApp =>
			createApp({
				schema,
				store: { adapter: 'better-sqlite3', name: base, namespaceByAuthUser: true },
				sync: {
					url: 'ws://localhost:1/kora',
					authClient: {
						auth: async () => ({ token: 't' }),
						resolveUserId: async () => user,
					},
					firstVisit: { readThrough: true },
				},
			})
		app = open('b')
		const seen: string[][] = []
		subscriptions.push(
			todos(app)
				.where({})
				.orderBy('title')
				.subscribe((records: CollectionRecord[]) => seen.push(titles(records))),
		)
		await new Promise<void>((resolve) => setTimeout(resolve, 100))
		expect(calls).toEqual([])
		openGate.release()
		await app.ready
		unsubscribeAll()
		await app.close()

		holdStoreOpen()
		app = open('a')
		const other: string[][] = []
		subscriptions.push(
			todos(app)
				.where({})
				.orderBy('title')
				.subscribe((records: CollectionRecord[]) => other.push(titles(records))),
		)
		await until(() => other.flat().includes('From the server'))
		expect(calls.length).toBeGreaterThan(0)
		openGate.release()
		await app.ready
	})
})

describe('read-through for an app that signs in through authClient (G2)', () => {
	let app: KoraApp | null = null
	afterEach(async () => {
		await app?.close().catch(() => {})
		app = null
		vi.unstubAllGlobals()
		openGate.hold = false
	})

	test('a signed-in user sees the first screen before the store opens, with the binding token', async () => {
		openGate.hold = true
		openGate.open = new Promise<void>((resolve) => {
			openGate.release = resolve
		})
		const headers: Array<Record<string, string>> = []
		const endpoint = readEndpoint([row('a', 'Alpha')])
		const inner = (globalThis as { fetch: typeof fetch }).fetch
		vi.stubGlobal(
			'fetch',
			async (url: string, init: { body: string; headers: Record<string, string> }) => {
				headers.push(init.headers)
				return inner(url, init as never)
			},
		)
		endpoint.releaseNow()
		app = newAuthClientApp({ state: 'authenticated', userId: 'u1', token: 'binding-token' })
		const seen: string[][] = []
		todos(app)
			.where({})
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		await until(() => seen.length > 0)
		expect(seen[0]).toEqual(['Alpha'])
		expect(headers[0]?.authorization).toBe('Bearer binding-token')
		openGate.release()
		await app.ready
		await until(() => seen.length > 1)
		expect(seen[seen.length - 1]).toEqual(['Alpha'])
	})

	test('a signed-out visitor sends no read request and the store answers', async () => {
		const fetchSpy = vi.fn()
		vi.stubGlobal('fetch', fetchSpy)
		app = newAuthClientApp({ state: 'signed-out', mayConnectAnonymously: false })
		const seen: string[][] = []
		todos(app)
			.where({})
			.subscribe((records: CollectionRecord[]) => seen.push(titles(records)))
		await until(() => seen.length > 0)
		await app.ready
		expect(seen[0]).toEqual([])
		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
