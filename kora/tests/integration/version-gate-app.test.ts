/**
 * Version gate, app layer (docs/design/version-gate.md, sections 5, 6 and 9): the
 * `app:build-superseded` announcement precedes every refusal, writes of every kind refuse
 * with BUILD_SUPERSEDED (a local refusal, never a server rejection), sync stops and stays
 * stopped, queued operations are uploaded once by the new build, and the default prompt
 * can be replaced.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type KoraEvent, defineSchema, t } from '@korajs/core'
import { createMutationController } from '@korajs/core/bindings'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { BuildSupersededError, VersionGate } from '@korajs/store'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { KoraSyncServer, MemoryServerStore } from '../../../packages/server/src/index'
import { createServerTransportPair } from '../../../packages/server/src/internal'
import {
	MockBroadcastChannel,
	MockLockManager,
	createOpenSeqCounter,
	flushMicrotasks,
	waitUntil,
} from '../../../packages/store/tests/fixtures/browser-sim'
import type { SyncRuntimeState } from '../../src/sync-lifecycle'
import {
	SUPERSEDED_MESSAGE,
	UNSAVED_MESSAGE,
	createAppVersionGate,
	reloadIntoNewestBuild,
	resolveAppBuild,
	unsavedMessage,
	wireAppVersionGate,
} from '../../src/version-gate'

let server: KoraSyncServer
let serverStore: MemoryServerStore

class MemoryTransport implements SyncTransport {
	private inner: ReturnType<typeof createServerTransportPair>['client'] | null = null
	private onMsg: (m: SyncMessage) => void = () => {}
	private onCls: (r: string) => void = () => {}
	private onErr: (e: Error) => void = () => {}
	async connect(): Promise<void> {
		const pair = createServerTransportPair()
		this.inner = pair.client
		pair.client.onMessage((m) => this.onMsg(m))
		pair.client.onClose((r) => this.onCls(r))
		pair.client.onError((e) => this.onErr(e))
		server.handleConnection(pair.server)
	}
	async disconnect(): Promise<void> {
		await this.inner?.disconnect()
	}
	send(message: SyncMessage): void {
		if (!this.inner) throw new Error('not connected')
		this.inner.send(message)
	}
	onMessage(h: (m: SyncMessage) => void): void {
		this.onMsg = h
	}
	onClose(h: (r: string) => void): void {
		this.onCls = h
	}
	onError(h: (e: Error) => void): void {
		this.onErr = h
	}
	isConnected(): boolean {
		return this.inner?.isConnected() ?? false
	}
}

vi.mock('../../src/create-sync-transport', () => ({
	createSyncTransport: () => new MemoryTransport(),
}))

const { createApp } = await import('../../src/create-app')
type App = ReturnType<typeof createApp>

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

interface Notes {
	insert(data: { body: string }): Promise<{ id: string }>
	where(conditions: Record<string, unknown>): { exec(): Promise<Array<{ body: string }>> }
}
const notes = (app: App): Notes => (app as unknown as { notes: Notes }).notes

let dir: string
let locks: MockLockManager
let allocate: (dbName: string) => Promise<number>
const apps: App[] = []

function gateFor(build: string, tab: string, dbName: string): VersionGate {
	return new VersionGate({
		dbName,
		build,
		runtime: {
			browser: true,
			locks,
			createChannel: (name) => new MockBroadcastChannel(name, tab),
		},
		allocateOpenSeq: allocate,
		tabId: tab,
		heartbeatMs: 5,
		waitingReportMs: 1,
	})
}

function tab(
	build: string,
	name: string,
	extra: { sync?: boolean; onBuildSuperseded?: () => void } = {},
): { app: App; gate: VersionGate; events: KoraEvent[] } {
	const dbName = join(dir, 'shared.db')
	const gate = gateFor(build, name, dbName)
	const app = createApp({
		schema,
		build,
		store: {
			adapter: 'better-sqlite3',
			name: dbName,
			versionGate: gate,
			...(extra.onBuildSuperseded ? { onBuildSuperseded: extra.onBuildSuperseded } : {}),
		},
		...(extra.sync ? { sync: { url: 'ws://memory' } } : {}),
	})
	const events: KoraEvent[] = []
	for (const type of ['app:build-superseded', 'app:before-build-reload'] as const) {
		app.events.on(type, (event) => events.push(event))
	}
	apps.push(app)
	return { app, gate, events }
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'kora-version-gate-'))
	locks = new MockLockManager()
	allocate = createOpenSeqCounter()
	MockBroadcastChannel.reset()
	serverStore = new MemoryServerStore('version-gate')
	server = new KoraSyncServer({ store: serverStore })
})

afterEach(async () => {
	for (const app of apps.splice(0)) await app.close().catch(() => undefined)
	await server.stop()
	rmSync(dir, { recursive: true, force: true })
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
})

describe('a superseded app', () => {
	test('announces before any refusal; every write path refuses with BUILD_SUPERSEDED; reads keep working', async () => {
		const old = tab('A', 'old')
		await old.app.ready
		await notes(old.app).insert({ body: 'before' })

		const order: string[] = []
		old.app.on('app:build-superseded', (event) => {
			order.push(`announce ${event.currentBuild} -> ${event.newerBuild}`)
		})
		const fresh = tab('B', 'new')
		await fresh.app.ready
		await waitUntil(() => old.gate.getState() === 'retired', 'old tab retired')

		const attempt = async (label: string, write: () => Promise<unknown>): Promise<void> => {
			await expect(write()).rejects.toBeInstanceOf(BuildSupersededError)
			order.push(label)
		}
		await attempt('insert', () => notes(old.app).insert({ body: 'late' }))
		await attempt('transaction', () => old.app.transaction(async () => {}))
		await attempt('mutation', () => old.app.mutation('named', async () => {}))
		await attempt('blob put', () => old.app.blobs.put(new Uint8Array([1, 2, 3])))
		await attempt('blob store put', () => old.app.blobs.store.put(new Uint8Array([4])))
		await attempt('blob gc', () => old.app.blobs.gc())
		expect(order[0]).toBe('announce A -> B')
		expect(order).toHaveLength(7)

		const error = await notes(old.app)
			.insert({ body: 'x' })
			.catch((e: unknown) => e)
		expect(error).toMatchObject({ code: 'BUILD_SUPERSEDED', retriable: true, collection: 'notes' })
		expect(JSON.stringify((error as BuildSupersededError).context)).not.toContain('"x"')

		expect((await notes(old.app).where({}).exec()).map((row) => row.body)).toEqual(['before'])
		await notes(fresh.app).insert({ body: 'after' })
		expect((await notes(fresh.app).where({}).exec()).map((row) => row.body).sort()).toEqual([
			'after',
			'before',
		])
	})

	test('useMutation-style controllers see BUILD_SUPERSEDED as an error, never as a server rejection', async () => {
		const old = tab('A', 'old')
		await old.app.ready
		const fresh = tab('B', 'new')
		await fresh.app.ready
		await waitUntil(() => old.gate.getState() === 'retired', 'old tab retired')

		const controller = createMutationController<{ id: string }, [string]>({
			mutationFn: (body) => notes(old.app).insert({ body }),
			options: {},
			events: old.app.events,
		})
		await expect(controller.mutateAsync('refused')).rejects.toBeInstanceOf(BuildSupersededError)
		const state = controller.getSnapshot()
		expect(state.error).toBeInstanceOf(BuildSupersededError)
		expect(state.rejected).toBeNull()
	})

	test('sync stops, stays stopped, and the queued operation is uploaded once by the new build', async () => {
		const old = tab('A', 'old', { sync: true })
		await old.app.ready
		// Written offline: the operation is in the outbound queue.
		await notes(old.app).insert({ body: 'queued offline' })
		expect(old.app.getSyncEngine()?.getStatus().pendingOperations).toBe(1)

		const fresh = tab('B', 'new', { sync: true })
		await fresh.app.ready
		await waitUntil(() => old.gate.getState() === 'retired', 'old tab retired')
		await expect(old.app.sync?.connect()).rejects.toBeInstanceOf(BuildSupersededError)
		await expect(old.app.sync?.reconnect()).rejects.toBeInstanceOf(BuildSupersededError)
		await expect(old.app.sync?.retryNow()).rejects.toBeInstanceOf(BuildSupersededError)
		await expect(old.app.sync?.assignHeld('node', 'current-user')).rejects.toBeInstanceOf(
			BuildSupersededError,
		)

		await fresh.app.sync?.connect()
		await waitUntil(
			() => serverStore.getAllOperations().some((op) => op.data?.body === 'queued offline'),
			'uploaded by the new build',
		)
		await fresh.app.sync?.disconnect()
		const uploaded = serverStore
			.getAllOperations()
			.filter((op) => op.data?.body === 'queued offline')
		expect(uploaded).toHaveLength(1)
	})

	test('store.onBuildSuperseded is called with the builds', async () => {
		const handler = vi.fn()
		const old = tab('A', 'old', { onBuildSuperseded: handler })
		await old.app.ready
		const fresh = tab('B', 'new')
		await fresh.app.ready
		await waitUntil(() => handler.mock.calls.length === 1, 'handler called')
		expect(handler).toHaveBeenCalledWith({ currentBuild: 'A', newerBuild: 'B' })
	})

	test('app.close() while retiring with unsaved writes is refused before anything is torn down; it closes once they are saved', async () => {
		const one = tab('A', 'one')
		await one.app.ready
		let release: () => void = () => {}
		one.gate.addRetireStep('durability', async () => {
			one.gate.reportUnsavedWrites(true)
			await new Promise<void>((resolve) => {
				release = resolve
			})
			one.gate.reportUnsavedWrites(false)
		})
		const fresh = tab('B', 'new')
		await waitUntil(() => one.gate.snapshot().unsaved, 'old tab reports unsaved writes')
		await expect(one.app.close()).rejects.toMatchObject({ context: { code: 'UNSAVED_WRITES' } })
		// Nothing was torn down: the tab keeps its lock and its store.
		expect(one.gate.getState()).toBe('retiring')
		expect(await notes(one.app).where({}).exec()).toEqual([])
		release()
		await fresh.app.ready
		await one.app.close()
	})

	test('reloadForNewBuild emits app:before-build-reload synchronously, then reloads', async () => {
		const reload = vi.fn()
		vi.stubGlobal('location', { reload })
		const one = tab('A', 'one')
		await one.app.ready
		const saved: string[] = []
		one.app.on('app:before-build-reload', () => {
			saved.push('draft saved')
			expect(reload).not.toHaveBeenCalled()
		})
		const reloading = one.app.reloadForNewBuild()
		expect(saved).toEqual(['draft saved'])
		await reloading
		expect(reload).toHaveBeenCalledOnce()
		// A second call (a double click) reloads once.
		await one.app.reloadForNewBuild()
		expect(saved).toEqual(['draft saved'])
		expect(reload).toHaveBeenCalledOnce()
	})
})

describe('initialization', () => {
	test('a failure after the store opened releases the store and the tab lock', async () => {
		const dbName = join(dir, 'failing.db')
		const gate = gateFor('A', 'failing', dbName)
		let calls = 0
		const app = createApp({
			schema,
			build: 'A',
			store: { adapter: 'better-sqlite3', name: dbName, versionGate: gate },
			sync: {
				url: 'ws://memory',
				authClient: {
					auth: async () => ({ token: 't' }),
					// Called once the store is open (binding writes to the signed-in user).
					resolveUserId: async () => {
						calls += 1
						throw new Error('auth backend down')
					},
				},
			},
		})
		apps.push(app)
		await expect(app.ready).rejects.toThrow('auth backend down')
		expect(calls).toBeGreaterThan(0)
		expect(gate.getState()).toBe('closed')
		expect(locks.heldNames()).toEqual([])
	})

	test('a tab superseded while initializing never starts its sync engine', async () => {
		const dbName = join(dir, 'late-sync.db')
		const gate = gateFor('A', 'late', dbName)
		let releaseAuth: () => void = () => {}
		const authGate = new Promise<void>((resolve) => {
			releaseAuth = resolve
		})
		const app = createApp({
			schema,
			build: 'A',
			store: { adapter: 'better-sqlite3', name: dbName, versionGate: gate },
			sync: {
				url: 'ws://memory',
				autoConnect: true,
				authClient: {
					auth: async () => ({ token: 't' }),
					resolveUserId: async () => {
						await authGate
						return 'user-1'
					},
				},
			},
		})
		apps.push(app)
		await waitUntil(() => gate.getState() === 'open', 'store open')
		await gateFor('B', 'newer', dbName).open()
		await waitUntil(() => gate.getState() === 'retired', 'retired before the engine existed')
		releaseAuth()
		await app.ready
		const engine = app.getSyncEngine()
		await new Promise((resolve) => setTimeout(resolve, 20))
		expect(engine?.getState()).not.toBe('streaming')
		expect(engine?.getState()).not.toBe('connecting')
		await expect(app.sync?.connect()).rejects.toBeInstanceOf(BuildSupersededError)
	})
})

describe('gates per opening', () => {
	test('an injected gate serves one opening; a factory serves every fallback attempt', () => {
		const emitter = new SimpleEventEmitter()
		const given = gateFor('A', 'given', 'db-given')
		const config = { schema, store: { versionGate: given } }
		expect(createAppVersionGate(config, 'db-given', emitter, 'sqlite-wasm')).toBe(given)
		// Not a browser page: the fallback attempt gets no gate rather than the closed one.
		expect(createAppVersionGate(config, 'db-given', emitter, 'indexeddb')).toBeNull()
		let made = 0
		const factory = { schema, store: { versionGate: () => gateFor('A', `f${++made}`, 'db-f') } }
		const first = createAppVersionGate(factory, 'db-f', emitter, 'sqlite-wasm')
		const second = createAppVersionGate(factory, 'db-f', emitter, 'indexeddb')
		expect(first).not.toBe(second)
		expect(made).toBe(2)
	})

	test('native adapters get no gate', () => {
		vi.stubGlobal('window', {})
		vi.stubGlobal('document', {})
		const emitter = new SimpleEventEmitter()
		expect(createAppVersionGate({ schema }, 'db', emitter, 'tauri-sqlite')).toBeNull()
		expect(createAppVersionGate({ schema }, 'db', emitter, 'better-sqlite3')).toBeNull()
		expect(createAppVersionGate({ schema }, 'db', emitter, 'sqlite-wasm')).toBeInstanceOf(
			VersionGate,
		)
	})
})

describe('build id', () => {
	test('createApp({ build }) wins, then the injected global, then the meta tag', () => {
		expect(resolveAppBuild({ build: 'sha-1' })).toBe('sha-1')
		vi.stubGlobal('__KORA_BUILD__', 'plugin-2')
		expect(resolveAppBuild({})).toBe('plugin-2')
		vi.unstubAllGlobals()
		vi.stubGlobal('document', {
			querySelector: (selector: string) =>
				selector === 'meta[name="kora-build"]' ? { getAttribute: () => 'meta-3' } : null,
		})
		expect(resolveAppBuild({})).toBe('meta-3')
		vi.unstubAllGlobals()
		expect(resolveAppBuild({})).toBeUndefined()
	})
})

// === Default prompt (a minimal DOM: the prompt uses plain DOM APIs only) ===

class FakeElement {
	id = ''
	textContent = ''
	type = ''
	disabled = false
	href = ''
	download = ''
	readonly style = { cssText: '' }
	readonly children: FakeElement[] = []
	parent: FakeElement | null = null
	private readonly listeners = new Map<string, Array<() => void>>()
	private readonly attributes = new Map<string, string>()
	constructor(readonly tagName: string) {}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value)
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null
	}
	append(...nodes: FakeElement[]): void {
		for (const node of nodes) {
			node.parent = this
			this.children.push(node)
		}
	}
	remove(): void {
		if (!this.parent) return
		const siblings = this.parent.children
		siblings.splice(siblings.indexOf(this), 1)
		this.parent = null
	}
	addEventListener(type: string, listener: () => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
	}
	click(): void {
		for (const listener of this.listeners.get('click') ?? []) listener()
	}
	find(predicate: (el: FakeElement) => boolean): FakeElement | null {
		if (predicate(this)) return this
		for (const child of this.children) {
			const found = child.find(predicate)
			if (found) return found
		}
		return null
	}
	text(): string {
		return [this.textContent, ...this.children.map((child) => child.text())].join(' ').trim()
	}
}

function installDom(options: { appHandlesUpdate?: boolean } = {}): { body: FakeElement } {
	const body = new FakeElement('body')
	vi.stubGlobal('document', {
		body,
		documentElement: body,
		createElement: (tag: string) => new FakeElement(tag),
		getElementById: (id: string) => body.find((el) => el.id === id),
		querySelector: () => null,
	})
	vi.stubGlobal('window', {
		dispatchEvent: (event: { type: string; preventDefault?: () => void }) =>
			!(event.type === 'kora:update-available' && options.appHandlesUpdate),
	})
	vi.stubGlobal(
		'CustomEvent',
		class {
			constructor(
				readonly type: string,
				readonly init: unknown,
			) {}
		},
	)
	return { body }
}

function promptOf(body: FakeElement): FakeElement | null {
	return body.find((el) => el.id.startsWith('kora-version-gate-prompt'))
}

function buttonOf(prompt: FakeElement, label: string): FakeElement | null {
	return prompt.find((el) => el.tagName === 'button' && el.textContent === label)
}

function syncState(): SyncRuntimeState {
	return {
		syncEngine: null,
		syncStatusBridge: null,
		authSyncCoordinator: null,
		reconnectionManager: null,
		connectionMonitor: null,
		qualityInterval: null,
		intentionalDisconnect: false,
		removeOnlineListener: null,
		supersededBy: null,
	}
}

async function supersede(
	options: {
		onBuildSuperseded?: () => void
		prevent?: boolean
		buildPrompt?: boolean
		appHandlesUpdate?: boolean
	} = {},
): Promise<{ body: FakeElement; reload: ReturnType<typeof vi.fn>; old: VersionGate }> {
	const { body } = installDom(options)
	const emitter = new SimpleEventEmitter()
	if (options.prevent) emitter.on('app:build-superseded', (event) => event.preventDefault())
	const reload = vi.fn()
	const db = `prompt-db-${Math.random()}`
	const old = gateFor('A', 'old', db)
	wireAppVersionGate(old, {
		config: {
			schema,
			store: {
				...(options.onBuildSuperseded ? { onBuildSuperseded: options.onBuildSuperseded } : {}),
				...(options.buildPrompt === false ? { buildPrompt: false } : {}),
			},
		},
		emitter,
		syncState: syncState(),
		reloadForNewBuild: reload,
	})
	await old.open()
	await gateFor('B', 'new', db).open()
	return { body, reload, old }
}

describe('default prompt', () => {
	test('shows the reload prompt; Reload calls app.reloadForNewBuild()', async () => {
		const { body, reload } = await supersede()
		const prompt = promptOf(body)
		expect(prompt?.text()).toContain(SUPERSEDED_MESSAGE)
		const button = prompt ? buttonOf(prompt, 'Reload') : null
		button?.click()
		expect(reload).toHaveBeenCalledOnce()
	})

	test('preventDefault(), onBuildSuperseded, buildPrompt: false and an app update UI replace it', async () => {
		expect(promptOf((await supersede({ prevent: true })).body)).toBeNull()
		vi.unstubAllGlobals()
		const handler = vi.fn()
		expect(promptOf((await supersede({ onBuildSuperseded: handler })).body)).toBeNull()
		expect(handler).toHaveBeenCalledOnce()
		vi.unstubAllGlobals()
		expect(promptOf((await supersede({ buildPrompt: false })).body)).toBeNull()
		vi.unstubAllGlobals()
		expect(promptOf((await supersede({ appHandlesUpdate: true })).body)).toBeNull()
	})

	test('a failed barrier shows Retry and Export; success returns to the reload prompt', async () => {
		const { body } = installDom()
		const emitter = new SimpleEventEmitter()
		const db = `prompt-unsaved-${Math.random()}`
		const old = gateFor('A', 'old', db)
		wireAppVersionGate(old, {
			config: { schema },
			emitter,
			syncState: syncState(),
			reloadForNewBuild: () => {},
		})
		let release: () => void = () => {}
		const retry = vi.spyOn(old, 'retryNow')
		old.addRetireStep('durability', async () => {
			// Not a quota failure: the prompt must not tell the user to free space.
			emitter.emit({
				type: 'store:persistence-error',
				dbName: db,
				message: 'no worker',
				code: 'PERSISTENCE_FAILED',
			})
			old.reportUnsavedWrites(true)
			await new Promise<void>((resolve) => {
				release = resolve
			})
			old.reportUnsavedWrites(false)
		})
		await old.open()
		const opening = gateFor('B', 'new', db).open()
		await waitUntil(
			() => promptOf(body)?.text().includes(UNSAVED_MESSAGE) ?? false,
			'unsaved prompt',
		)
		const prompt = promptOf(body)
		expect(prompt?.text()).not.toContain('storage is full')
		expect(prompt && buttonOf(prompt, 'Export')).not.toBeNull()
		const retryButton = prompt ? buttonOf(prompt, 'Retry') : null
		retryButton?.click()
		expect(retry).toHaveBeenCalled()
		release()
		await opening
		expect(promptOf(body)?.text()).toContain(SUPERSEDED_MESSAGE)
	})

	test('the unsaved prompt names the failure by its code', () => {
		expect(unsavedMessage('QUOTA_EXCEEDED')).toContain('storage is full')
		expect(unsavedMessage('STORAGE_UNAVAILABLE')).toContain('lost its connection')
		expect(unsavedMessage('PERSISTENCE_FAILED')).toBe(UNSAVED_MESSAGE)
		expect(unsavedMessage(null)).toBe(UNSAVED_MESSAGE)
		expect(UNSAVED_MESSAGE).not.toContain('storage is full')
	})

	test('the newer tab shows a waiting prompt and removes it once its gate opens', async () => {
		const { body } = installDom()
		const db = `prompt-waiting-${Math.random()}`
		const old = gateFor('A', 'old', db)
		await old.open()
		let release: () => void = () => {}
		old.addRetireStep(
			'drain',
			() =>
				new Promise<void>((resolve) => {
					release = resolve
				}),
		)
		const fresh = gateFor('B', 'new', db)
		wireAppVersionGate(fresh, {
			config: { schema },
			emitter: new SimpleEventEmitter(),
			syncState: syncState(),
			reloadForNewBuild: () => {},
		})
		const opening = fresh.open()
		await waitUntil(
			() => promptOf(body)?.text().includes('still open on an older version') ?? false,
			'waiting prompt',
		)
		release()
		await opening
		expect(promptOf(body)).toBeNull()
	})
	test('two apps on one page keep their own prompt', async () => {
		const { body } = installDom()
		const make = (db: string, tab: string): VersionGate => {
			const gate = gateFor('A', tab, db)
			wireAppVersionGate(gate, {
				config: { schema },
				emitter: new SimpleEventEmitter(),
				syncState: syncState(),
				reloadForNewBuild: () => {},
			})
			return gate
		}
		const one = make('db-one', 'one')
		const two = make('db-two', 'two')
		await one.open()
		await two.open()
		await gateFor('B', 'one-new', 'db-one').open()
		await gateFor('B', 'two-new', 'db-two').open()
		const prompts = body.children.filter((el) => el.id.startsWith('kora-version-gate-prompt'))
		expect(prompts.map((el) => el.id).sort()).toEqual([
			'kora-version-gate-prompt-db-one',
			'kora-version-gate-prompt-db-two',
		])
	})
})

describe('reloadIntoNewestBuild (offline shell)', () => {
	type Listener = () => void
	function serviceWorkerContainer(registration: unknown): {
		container: {
			getRegistration: () => Promise<unknown>
			addEventListener: (type: string, fn: Listener) => void
			removeEventListener: (type: string, fn: Listener) => void
		}
		fire: (type: string) => void
	} {
		const listeners = new Map<string, Set<Listener>>()
		return {
			container: {
				getRegistration: async () => registration,
				addEventListener: (type, fn) => {
					const set = listeners.get(type) ?? new Set<Listener>()
					set.add(fn)
					listeners.set(type, set)
				},
				removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
			},
			fire: (type) => {
				for (const fn of [...(listeners.get(type) ?? [])]) fn()
			},
		}
	}

	test('a waiting worker is activated first; the page reloads only once it controls the page', async () => {
		const reload = vi.fn()
		const postMessage = vi.fn()
		const registration = {
			update: vi.fn(async () => {}),
			waiting: { postMessage },
			installing: null,
		}
		const { container, fire } = serviceWorkerContainer(registration)
		vi.stubGlobal('location', { reload })
		vi.stubGlobal('navigator', { serviceWorker: container })
		const reloading = reloadIntoNewestBuild({ timeoutMs: 60_000 })
		await waitUntil(() => postMessage.mock.calls.length === 1, 'skip waiting posted')
		expect(registration.update).toHaveBeenCalledOnce()
		expect(postMessage).toHaveBeenCalledWith({ type: 'KORA_SW_SKIP_WAITING' })
		await flushMicrotasks(20)
		// Not before the new worker took over: a reload now would be served the old build.
		expect(reload).not.toHaveBeenCalled()
		fire('controllerchange')
		await reloading
		expect(reload).toHaveBeenCalledOnce()
	})

	test('a newer worker the update check finds is waited for while it installs', async () => {
		const reload = vi.fn()
		const postMessage = vi.fn()
		const stateListeners: Listener[] = []
		const installing = {
			state: 'installing',
			postMessage,
			addEventListener: (_type: string, fn: Listener) => stateListeners.push(fn),
			removeEventListener: () => {},
		}
		const registration = {
			waiting: null,
			installing: null as typeof installing | null,
			update: vi.fn(async () => {
				registration.installing = installing
			}),
		}
		const { container, fire } = serviceWorkerContainer(registration)
		vi.stubGlobal('location', { reload })
		vi.stubGlobal('navigator', { serviceWorker: container })
		const reloading = reloadIntoNewestBuild({ timeoutMs: 60_000 })
		await waitUntil(() => stateListeners.length === 1, 'waiting for install')
		expect(postMessage).not.toHaveBeenCalled()
		installing.state = 'installed'
		for (const fn of stateListeners) fn()
		await waitUntil(() => postMessage.mock.calls.length === 1, 'skip waiting posted')
		fire('controllerchange')
		await reloading
		expect(reload).toHaveBeenCalledOnce()
	})

	test('no service worker, or no newer one: a plain reload', async () => {
		const reload = vi.fn()
		vi.stubGlobal('location', { reload })
		vi.stubGlobal('navigator', {})
		await reloadIntoNewestBuild()
		expect(reload).toHaveBeenCalledTimes(1)
		const { container } = serviceWorkerContainer({
			update: async () => {},
			waiting: null,
			installing: null,
		})
		vi.stubGlobal('navigator', { serviceWorker: container })
		await reloadIntoNewestBuild()
		expect(reload).toHaveBeenCalledTimes(2)
	})
})
