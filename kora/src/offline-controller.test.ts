import { type OfflineDataStatus, defineSchema, t } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { StoragePersistence, Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { describe, expect, test, vi } from 'vitest'
import { createOfflineController } from './offline-controller'
import type { KoraConfig } from './types'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

type EngineData = Omit<OfflineDataStatus, 'quarantined'> & {
	blocked: boolean
	sessionLive: boolean
}

function fakeEngine(data: EngineData, quarantined = 0) {
	const listeners = new Set<() => void>()
	const state = { data }
	return {
		state,
		changed: () => {
			for (const listener of listeners) listener()
		},
		engine: {
			getOfflineData: () => state.data,
			onStatusChange: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			refreshOfflineMarks: vi.fn(async () => {}),
			getQuarantinedOperations: async () => new Array(quarantined).fill({}),
		} as unknown as SyncEngine,
	}
}

function fakeStore(overrides: { evicted?: unknown; writes?: 'durable' | 'failing' } = {}): Store {
	return {
		getStorageEviction: () => overrides.evicted ?? null,
		getWriteDurability: () => ({ state: overrides.writes ?? 'durable' }),
	} as unknown as Store
}

const persistence = (persisted: boolean, state = 'persisted') =>
	({ status: () => ({ persisted, state, requested: false }) }) as unknown as StoragePersistence

const complete: EngineData = {
	state: 'complete',
	progress: 1,
	completedAt: 5,
	blocked: false,
	sessionLive: false,
}

function setup(
	options: {
		config?: Partial<KoraConfig>
		engine?: ReturnType<typeof fakeEngine> | null
		store?: Store | null
		durable?: boolean
		inert?: boolean
		persisted?: boolean
		installed?: boolean
	} = {},
) {
	const emitter = new SimpleEventEmitter()
	const engine = options.engine === undefined ? fakeEngine(complete) : options.engine
	const controller = createOfflineController({
		config: { schema, ...(options.config ?? {}) } as KoraConfig,
		emitter,
		persistence: persistence(options.persisted ?? true),
		inert: options.inert ?? false,
		runtime: () => ({
			store: options.store === undefined ? fakeStore() : options.store,
			engine: engine?.engine ?? null,
			durable: options.durable ?? true,
			backend: 'opfs',
		}),
		...(options.installed
			? { shell: () => ({ state: 'installed' as const, version: 'v1', misses: [] }) }
			: {}),
	})
	return { controller, emitter, engine }
}

describe('app.offline status', () => {
	test('is ready only when shell, data, storage and auth all hold', () => {
		const { controller } = setup({ installed: true, config: { sync: { url: 'ws://x' } } })
		controller.attach()
		expect(controller.status()).toMatchObject({ state: 'ready', reasons: [] })
	})

	test('without a shell it is never ready (A4 fills the shell in)', () => {
		const { controller } = setup()
		controller.attach()
		const status = controller.status()
		expect(status.state).toBe('not-ready')
		expect(status.reasons).toEqual([expect.stringMatching(/^shell-(none|unsupported)$/)])
	})

	test('local-only data is local; sync configured with no engine is incomplete', () => {
		const local = setup({ engine: null, installed: true })
		expect(local.controller.status()).toMatchObject({ state: 'ready', data: { state: 'local' } })
		const synced = setup({ engine: null, installed: true, config: { sync: { url: 'ws://x' } } })
		expect(synced.controller.status().reasons).toEqual(['data-incomplete'])
	})

	test('a server render reports server-rendering, never ready', () => {
		const { controller } = setup({ inert: true, installed: true, engine: null, store: null })
		expect(controller.status().reasons).toContain('server-rendering')
	})

	test('data from the engine: syncing on a live session is preparing; blocked is data-blocked', () => {
		const syncing = fakeEngine({
			state: 'syncing',
			progress: 0.3,
			completedAt: null,
			blocked: false,
			sessionLive: true,
		})
		const a = setup({ engine: syncing, installed: true })
		expect(a.controller.status()).toMatchObject({ state: 'preparing', reasons: ['data-syncing'] })

		const blocked = fakeEngine({
			state: 'syncing',
			progress: null,
			completedAt: null,
			blocked: true,
			sessionLive: true,
		})
		const b = setup({ engine: blocked, installed: true })
		expect(b.controller.status().reasons).toEqual(['data-blocked'])
	})

	test('storage: non-durable, failing writes and another tab are reported', () => {
		expect(setup({ durable: false, installed: true }).controller.status().reasons).toEqual([
			'storage-non-durable',
		])
		const failing = setup({ store: fakeStore({ writes: 'failing' }), installed: true })
		expect(failing.controller.status().reasons).toEqual(['storage-writes-failing'])

		const { controller, emitter } = setup({ installed: true })
		emitter.emit({ type: 'store:tab-exclusive', dbName: 'x', heldBy: null, message: 'm' })
		expect(controller.status().reasons).toEqual(['storage-other-tab'])
	})

	test('allowUncoordinatedTabs is never claimed ready', () => {
		const { controller } = setup({
			installed: true,
			config: { store: { allowUncoordinatedTabs: true } },
		})
		expect(controller.status().reasons).toEqual(['storage-uncoordinated'])
	})

	test('a configured sign-in is unknown (never ready) until the auth component exists', () => {
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', auth: async () => ({ token: 't' }) } },
		})
		expect(controller.status().auth.state).toBe('unknown')
		expect(controller.status().reasons).toEqual(['auth-unknown'])
	})

	test('persisted false, quarantined operations and an unacknowledged eviction never gate', async () => {
		const evicted = {
			dbName: 'x',
			detectedAt: 1,
			lastOpenedAt: null,
			evidence: ['manifest'],
			lostWrites: { count: 2, certain: true },
		}
		const { controller } = setup({
			installed: true,
			persisted: false,
			store: fakeStore({ evicted }),
			engine: fakeEngine(complete, 3),
		})
		controller.attach()
		await vi.waitFor(() => expect(controller.status().data.quarantined).toBe(3))
		const status = controller.status()
		expect(status.state).toBe('ready')
		expect(status.storage.persisted).toBe(false)
		expect(status.storage.evicted).toEqual(evicted)
	})

	test('subscribers hear changes once, and nothing when the snapshot is unchanged', () => {
		const engine = fakeEngine({
			state: 'syncing',
			progress: 0,
			completedAt: null,
			blocked: false,
			sessionLive: true,
		})
		const { controller } = setup({ engine, installed: true })
		controller.attach()
		const heard: string[] = []
		controller.subscribe((status) => heard.push(status.data.state))

		engine.changed()
		expect(heard).toEqual([])
		const first = controller.status()
		expect(controller.status()).toBe(first)

		engine.state.data = complete
		engine.changed()
		engine.changed()
		expect(heard).toEqual(['complete'])
		expect(controller.status().state).toBe('ready')
	})

	test('an unsubscribed listener hears nothing; dispose stops following', () => {
		const engine = fakeEngine(complete)
		const { controller } = setup({ engine, installed: true })
		controller.attach()
		const listener = vi.fn()
		const off = controller.subscribe(listener)
		off()
		engine.state.data = { ...complete, state: 'incomplete', completedAt: null }
		engine.changed()
		expect(listener).not.toHaveBeenCalled()
		controller.dispose()
	})

	test('a missed bus message is recovered by re-reading marks on pageshow', async () => {
		const engine = fakeEngine(complete)
		const g = globalThis as { window?: EventTarget }
		const original = g.window
		const target = new EventTarget()
		g.window = target
		try {
			const { controller } = setup({ engine, installed: true })
			controller.attach()
			engine.engine.refreshOfflineMarks = vi.fn(async () => {})
			target.dispatchEvent(new Event('pageshow'))
			await vi.waitFor(() => expect(engine.engine.refreshOfflineMarks).toHaveBeenCalled())
			controller.dispose()
		} finally {
			if (original === undefined) Reflect.deleteProperty(g, 'window')
			else g.window = original
		}
	})
})
