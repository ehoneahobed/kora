import { type OfflineDataStatus, defineSchema, t } from '@korajs/core'
import type { AuthSyncBinding, OfflineRestoreResult } from '@korajs/core/bindings'
import { SimpleEventEmitter } from '@korajs/core/internal'
import type { StoragePersistence, Store } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
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
		backend?: 'opfs' | 'indexeddb' | 'native' | 'memory'
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
			backend: options.backend ?? 'opfs',
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

	test('without a reported shell it is never ready', () => {
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

describe('app.offline shell (the __KORA_SHELL__ contract)', () => {
	const g = globalThis as { __KORA_SHELL__?: unknown; window?: EventTarget }

	function withShell<T>(value: unknown, run: () => T): T {
		const previous = g.__KORA_SHELL__
		if (value === undefined) Reflect.deleteProperty(g, '__KORA_SHELL__')
		else g.__KORA_SHELL__ = value
		try {
			return run()
		} finally {
			if (previous === undefined) Reflect.deleteProperty(g, '__KORA_SHELL__')
			else g.__KORA_SHELL__ = previous
		}
	}

	test('absent contract: none, reason shell-none', () => {
		withShell(undefined, () => {
			const status = setup().controller.status()
			expect(status.shell).toEqual({
				state: expect.stringMatching(/^(none|unsupported)$/),
				version: null,
				misses: [],
			})
		})
	})

	test.each([
		['installed', 'ready', []],
		['installing', 'preparing', ['shell-installing']],
		['not-installed', 'not-ready', ['shell-not-installed']],
		['other-build', 'not-ready', ['shell-other-build']],
		['unsupported', 'not-ready', ['shell-unsupported']],
	] as const)('a reported %s shell makes the app %s', (state, expected, reasons) => {
		withShell({ v: 1, state, version: 'abc', misses: ['/x', 7] }, () => {
			const status = setup().controller.status()
			expect(status.shell).toEqual({ state, version: 'abc', misses: ['/x'] })
			expect(status.state).toBe(expected)
			expect(status.reasons).toEqual(reasons)
		})
	})

	test('a contract this version does not know is read as absent', () => {
		for (const value of [
			{ v: 2, state: 'installed', version: 'abc', misses: [] },
			{ v: 1, state: 'bundled', version: null, misses: [] },
			{ v: 1, state: 'nonsense', version: null, misses: [] },
			'installed',
			null,
		]) {
			withShell(value, () => {
				expect(setup().controller.status().shell.state).toMatch(/^(none|unsupported)$/)
			})
		}
	})

	test('the native backend is bundled: ready, whatever a page script reported', () => {
		withShell({ v: 1, state: 'not-installed', version: null, misses: [] }, () => {
			const status = setup({ backend: 'native' }).controller.status()
			expect(status.shell).toEqual({ state: 'bundled', version: null, misses: [] })
			expect(status).toMatchObject({ state: 'ready', reasons: [] })
		})
	})

	test('kora:shell re-computes and notifies subscribers', () => {
		const target = new EventTarget()
		const original = g.window
		g.window = target
		try {
			withShell({ v: 1, state: 'installing', version: null, misses: [] }, () => {
				const { controller } = setup()
				const listener = vi.fn()
				controller.subscribe(listener)
				expect(controller.status().reasons).toEqual(['shell-installing'])
				g.__KORA_SHELL__ = { v: 1, state: 'installed', version: 'abc', misses: [] }
				target.dispatchEvent(new Event('kora:shell'))
				expect(listener).toHaveBeenCalledTimes(1)
				expect(controller.status()).toMatchObject({ state: 'ready', shell: { version: 'abc' } })
				controller.dispose()
				// Disposed: later reports no longer reach the listener.
				g.__KORA_SHELL__ = { v: 1, state: 'other-build', version: 'abc', misses: [] }
				target.dispatchEvent(new Event('kora:shell'))
				expect(listener).toHaveBeenCalledTimes(1)
			})
		} finally {
			if (original === undefined) Reflect.deleteProperty(g, 'window')
			else g.window = original
		}
	})
})

describe('app.offline auth component (A3)', () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(5_000_000)
	})
	afterEach(() => vi.useRealTimers())

	const settle = () => vi.advanceTimersByTimeAsync(0)

	function bindingOf(
		restore: () => Promise<OfflineRestoreResult> | OfflineRestoreResult,
		extra: Partial<AuthSyncBinding> = {},
	): AuthSyncBinding & { notify: () => void } {
		const listeners = new Set<() => void>()
		return {
			auth: async () => ({ token: 't' }),
			resolveOfflineRestore: async () => restore(),
			subscribe: (listener) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			notify: () => {
				for (const listener of listeners) listener()
			},
			...extra,
		}
	}

	test('an app declaration of a restorable session is ready, with its limit', async () => {
		const { controller } = setup({
			installed: true,
			config: {
				sync: { url: 'ws://x', auth: async () => ({ token: 't' }) },
				offline: { auth: () => ({ restorable: true, until: 9_999_999_999_999 }) },
			},
		})
		controller.attach()
		await settle()
		expect(controller.status()).toMatchObject({
			state: 'ready',
			auth: { state: 'restorable', offlineUntil: 9_999_999_999_999 },
		})
	})

	test('a declaration of false or unknown is never ready', async () => {
		const no = setup({
			installed: true,
			config: {
				sync: { url: 'ws://x', auth: async () => ({ token: 't' }) },
				offline: { auth: async () => ({ restorable: false }) },
			},
		})
		no.controller.attach()
		await settle()
		expect(no.controller.status().reasons).toEqual(['auth-not-restorable'])
		const unknown = setup({
			installed: true,
			config: {
				sync: { url: 'ws://x', auth: async () => ({ token: 't' }) },
				offline: { auth: () => ({ restorable: 'unknown' }) },
			},
		})
		unknown.controller.attach()
		await settle()
		expect(unknown.controller.status().reasons).toEqual(['auth-unknown'])
	})

	test('a binding that proves a restorable session makes the app ready', async () => {
		const binding = bindingOf(() => ({ restorable: true, until: null }))
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		expect(controller.status().auth.state).toBe('loading')
		controller.attach()
		await settle()
		expect(controller.status()).toMatchObject({ state: 'ready', auth: { state: 'restorable' } })
	})

	test('every failure reason of the binding is not-restorable, and unknown stays unknown', async () => {
		for (const reason of [
			'signed-out',
			'locked',
			'non-durable-credentials',
			'expired',
			'clock-rollback',
		] as const) {
			const binding = bindingOf(() => ({ restorable: false, reason }))
			const { controller } = setup({
				installed: true,
				config: { sync: { url: 'ws://x', authClient: binding } },
			})
			controller.attach()
			await settle()
			expect(controller.status().reasons).toEqual(['auth-not-restorable'])
		}
		const unknown = bindingOf(() => ({
			restorable: 'unknown',
			reason: 'credential-durability-unknown',
		}))
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: unknown } },
		})
		controller.attach()
		await settle()
		expect(controller.status().reasons).toEqual(['auth-unknown'])
	})

	test('a binding without resolveOfflineRestore is unknown; an anonymous one has nothing to restore', async () => {
		const old = bindingOf(() => ({ restorable: true, until: null }))
		old.resolveOfflineRestore = undefined
		const a = setup({ installed: true, config: { sync: { url: 'ws://x', authClient: old } } })
		a.controller.attach()
		await settle()
		expect(a.controller.status().reasons).toEqual(['auth-unknown'])

		const anon = bindingOf(() => ({ restorable: false, reason: 'signed-out' }), {
			resolveSyncState: async () => ({ state: 'anonymous', mayConnectAnonymously: true }),
		})
		const b = setup({ installed: true, config: { sync: { url: 'ws://x', authClient: anon } } })
		b.controller.attach()
		await settle()
		expect(b.controller.status()).toMatchObject({ state: 'ready', auth: { state: 'n/a' } })
	})

	test('a binding still loading reports preparing', async () => {
		const binding = bindingOf(() => ({ restorable: true, until: null }), {
			resolveSyncState: async () => ({ state: 'loading' }),
		})
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status()).toMatchObject({ state: 'preparing', reasons: ['auth-loading'] })
	})

	test('ready flips off at offlineUntil, without any other event', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(1_000_000)
		let expired = false
		const binding = bindingOf(() =>
			expired ? { restorable: false, reason: 'expired' } : { restorable: true, until: 1_005_000 },
		)
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status().state).toBe('ready')
		expired = true
		await vi.advanceTimersByTimeAsync(5_100)
		expect(controller.status()).toMatchObject({
			state: 'not-ready',
			reasons: ['auth-not-restorable'],
		})
	})

	test('the state rule itself refuses a restorable answer whose limit has passed', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(2_000_000)
		const binding = bindingOf(() => ({ restorable: true, until: 1_999_000 }))
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status().reasons).toEqual(['auth-not-restorable'])
	})

	test('a wall clock moved back is caught by the watchdog, not by timers or events', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000_000)
		let rolledBack = false
		const binding = bindingOf(() =>
			rolledBack
				? { restorable: false, reason: 'clock-rollback' }
				: { restorable: true, until: null },
		)
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status().state).toBe('ready')
		rolledBack = true
		// The wall clock jumps back an hour while the monotonic clock moves 30 s.
		vi.setSystemTime(10_000_000 - 3_600_000)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(controller.status().reasons).toEqual(['auth-not-restorable'])
	})

	test('an ordinary clock does not re-evaluate on every watchdog tick', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000_000)
		const restore = vi.fn(
			async (): Promise<OfflineRestoreResult> => ({ restorable: true, until: null }),
		)
		const binding = bindingOf(restore)
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		const before = restore.mock.calls.length
		await vi.advanceTimersByTimeAsync(5 * 30_000)
		expect(restore.mock.calls.length).toBe(before)
	})

	test('the binding subscription re-evaluates (a sign-out ends ready)', async () => {
		let signedIn = true
		const binding = bindingOf(() =>
			signedIn ? { restorable: true, until: null } : { restorable: false, reason: 'signed-out' },
		)
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status().state).toBe('ready')
		signedIn = false
		binding.notify()
		await settle()
		expect(controller.status().reasons).toEqual(['auth-not-restorable'])
	})

	test('a throwing resolver is unknown (never ready) and reported', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const binding = bindingOf(() => {
			throw new Error('storage blocked')
		})
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: binding } },
		})
		controller.attach()
		await settle()
		expect(controller.status().reasons).toEqual(['auth-unknown'])
		expect(warn).toHaveBeenCalled()
		warn.mockRestore()
	})

	test('dispose stops the timers and the watchdog', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000_000)
		const restore = vi.fn(
			async (): Promise<OfflineRestoreResult> => ({ restorable: true, until: 10_100_000 }),
		)
		const { controller } = setup({
			installed: true,
			config: { sync: { url: 'ws://x', authClient: bindingOf(restore) } },
		})
		controller.attach()
		await settle()
		const before = restore.mock.calls.length
		controller.dispose()
		await vi.advanceTimersByTimeAsync(200_000)
		expect(restore.mock.calls.length).toBe(before)
	})
})
