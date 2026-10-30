import 'fake-indexeddb/auto'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import type { CollectionAccessor } from '@korajs/store'
import type { WorkerRequest, WorkerResponse } from '@korajs/store/sqlite-wasm'
import { afterEach, describe, expect, test } from 'vitest'
import { MockWorkerBridge } from '../../packages/store/src/adapters/sqlite-wasm-mock-bridge'
import { createApp } from './create-app'
import type { KoraApp } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		todos: {
			fields: {
				title: t.string(),
				completed: t.boolean().default(false),
			},
		},
	},
})

const WATCHED = [
	'store:write-pending',
	'store:write-settled',
	'query:patched',
	'store:overlay-diverged',
	'store:overlay-disabled',
] as const

/** `app.storage.writes` as the framework's own tests and DevTools see it (internal extras). */
interface InternalWrites {
	pending?: number
	onRollback?: (callback: () => void) => () => void
}

describe('createApp({ store: { instantUpdates } })', () => {
	let app: KoraApp

	afterEach(async () => {
		await app?.close()
	})

	function todosOf(target: KoraApp): CollectionAccessor {
		return (target as Record<string, unknown>).todos as CollectionAccessor
	}

	function watch(target: KoraApp): KoraEvent[] {
		const seen: KoraEvent[] = []
		for (const type of WATCHED) target.events.on(type, (event) => seen.push(event))
		return seen
	}

	const labels = (events: readonly KoraEvent[]): string[] =>
		events.map((event) =>
			event.type === 'store:write-settled' ? `${event.type}:${event.outcome}` : event.type,
		)

	test('off by default: no overlay events and no pending writes', async () => {
		app = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
		const seen = watch(app)
		await app.ready
		todosOf(app)
			.where({})
			.subscribe(() => {})
		await todosOf(app).insert({ title: 'plain' })
		expect(seen).toEqual([])
		expect((app.storage.writes as InternalWrites).pending).toBe(0)
	})

	test('on: a write is registered, settles committed, and the pending count returns to zero', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:', instantUpdates: true },
		})
		const seen = watch(app)
		await app.ready
		const delivered: string[][] = []
		todosOf(app)
			.where({})
			.subscribe((rows) => delivered.push(rows.map((row) => String(row.title))))
		await todosOf(app).insert({ title: 'fast' })
		expect(labels(seen)).toContain('store:write-pending')
		expect(labels(seen)).toContain('store:write-settled:committed')
		expect(delivered.at(-1)).toEqual(['fast'])
		expect((app.storage.writes as InternalWrites).pending).toBe(0)
	})

	test('{ durable: true } skips the prediction for that write only', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:', instantUpdates: true },
		})
		const seen = watch(app)
		await app.ready
		await todosOf(app).insert({ title: 'waits' }, { durable: true })
		await todosOf(app).insert({ title: 'shown' })
		const pending = seen.flatMap((event) => (event.type === 'store:write-pending' ? [event] : []))
		expect(pending.map((event) => event.predicted)).toEqual([false, true])
		expect(pending[0]?.reason).toBe('durable-option')
		const titles = (await todosOf(app).where({}).exec()).map((row) => row.title)
		expect(titles).toEqual(expect.arrayContaining(['waits', 'shown']))
	})

	test('onRollback can be attached before the store opens', async () => {
		app = createApp({
			schema,
			store: { adapter: 'better-sqlite3', name: ':memory:', instantUpdates: true },
		})
		const off = (app.storage.writes as InternalWrites).onRollback?.(() => {})
		expect(typeof off).toBe('function')
		await app.ready
		off?.()
	})

	test('the IndexedDB fallback store gets the same setting', async () => {
		const originalWorker = globalThis.Worker
		class VolatileOpfsWorker {
			onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null
			onerror: ((event: ErrorEvent) => void) | null = null
			private readonly bridge = new MockWorkerBridge()

			postMessage(request: WorkerRequest): void {
				void this.bridge
					.send(request)
					.then((response) => {
						if (request.type === 'open' && response.type === 'success') {
							this.onmessage?.({
								data: {
									...response,
									data: { persistent: false, fallbackReason: 'unsupported' },
								},
							} as MessageEvent<WorkerResponse>)
							return
						}
						this.onmessage?.({ data: response } as MessageEvent<WorkerResponse>)
					})
					.catch((error: unknown) => {
						this.onerror?.({
							message: error instanceof Error ? error.message : String(error),
						} as ErrorEvent)
					})
			}

			terminate(): void {
				this.bridge.terminate()
			}
		}
		Object.defineProperty(globalThis, 'Worker', { value: VolatileOpfsWorker, configurable: true })
		try {
			app = createApp({
				schema,
				// A simulated browser client without a window object: not a server render.
				ssr: false,
				store: {
					adapter: 'sqlite-wasm',
					workerUrl: '/worker.js',
					name: `iu-fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`,
					instantUpdates: true,
				},
			})
			const seen = watch(app)
			const fallbacks: KoraEvent[] = []
			app.events.on('store:storage-fallback', (event) => fallbacks.push(event))
			await app.ready
			expect(fallbacks).toHaveLength(1)
			await todosOf(app).insert({ title: 'on the fallback store' })
			expect(labels(seen)).toContain('store:write-pending')
		} finally {
			Object.defineProperty(globalThis, 'Worker', { value: originalWorker, configurable: true })
		}
	})
})
