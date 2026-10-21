import 'fake-indexeddb/auto'
import type { KoraEvent } from '@korajs/core'
import { SimpleEventEmitter } from '@korajs/core/internal'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
	MockBroadcastChannel,
	MockLockManager,
	createOpenSeqCounter,
	flushMicrotasks,
	waitUntil,
} from '../../tests/fixtures/browser-sim'
import { gatedLeaderLockName, leaderLockName } from '../adapters/opfs-names'
import {
	BuildSupersededError,
	TabCoordinationUnavailableError,
	VersionGateClosedError,
} from '../errors'
import { allocateOpenSeq } from './open-seq'
import {
	BUILD_HELLO,
	type RetirePhase,
	VersionGate,
	type VersionGateOptions,
	compareTabKeys,
	parseTabLockName,
	schemaFingerprint,
	tabLockName,
} from './version-gate'

const DB = 'gate-db'

let locks: MockLockManager
let allocate: (dbName: string) => Promise<number>
let events: KoraEvent[]
let emitter: SimpleEventEmitter

function gate(build: string, tag: string, extra: Partial<VersionGateOptions> = {}): VersionGate {
	return new VersionGate({
		dbName: DB,
		build,
		emitter,
		runtime: {
			browser: true,
			locks,
			createChannel: (name) => new MockBroadcastChannel(name, tag),
		},
		allocateOpenSeq: allocate,
		tabId: tag,
		...extra,
	})
}

function eventsOf<T extends KoraEvent['type']>(type: T): Array<Extract<KoraEvent, { type: T }>> {
	return events.filter((event): event is Extract<KoraEvent, { type: T }> => event.type === type)
}

function settled(promise: Promise<unknown>): () => 'pending' | 'resolved' | 'rejected' {
	let state: 'pending' | 'resolved' | 'rejected' = 'pending'
	promise.then(
		() => {
			state = 'resolved'
		},
		() => {
			state = 'rejected'
		},
	)
	return () => state
}

beforeEach(() => {
	locks = new MockLockManager()
	allocate = createOpenSeqCounter()
	MockBroadcastChannel.reset()
	emitter = new SimpleEventEmitter()
	events = []
	const original = emitter.emit.bind(emitter)
	vi.spyOn(emitter, 'emit').mockImplementation((event) => {
		events.push(event as KoraEvent)
		original(event)
	})
})

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('identity and ordering', () => {
	test('format orders before openSeq; tab lock names round-trip', () => {
		const a = { build: 'a', format: 1, openSeq: 9, tabId: 'x' }
		const b = { build: 'b', format: 2, openSeq: 1, tabId: 'y' }
		expect(compareTabKeys(b, a)).toBeGreaterThan(0)
		expect(compareTabKeys({ ...a, openSeq: 10 }, a)).toBeGreaterThan(0)
		expect(parseTabLockName(DB, tabLockName(DB, a))).toEqual(a)
		expect(parseTabLockName(DB, 'kora-leader-gate-db')).toBeNull()
		expect(parseTabLockName('other', tabLockName(DB, a))).toBeNull()
	})

	test('schema fingerprints differ when the schema differs and never use the package version', () => {
		const one = schemaFingerprint({
			version: 1,
			collections: { todos: { fields: { title: { kind: 'string' } } } },
			relations: {},
		} as never)
		const two = schemaFingerprint({
			version: 1,
			collections: { todos: { fields: { title: { kind: 'string' }, done: { kind: 'boolean' } } } },
			relations: {},
		} as never)
		expect(one).not.toBe(two)
		expect(one).toMatch(/^schema-1-1-[0-9a-f]{16}$/)
	})

	test('openSeq comes from an IndexedDB counter: unique and increasing across concurrent opens', async () => {
		const values = await Promise.all(
			Array.from({ length: 8 }, () => allocateOpenSeq('seq-db-concurrent')),
		)
		expect(new Set(values).size).toBe(8)
		const next = await allocateOpenSeq('seq-db-concurrent')
		expect(next).toBeGreaterThan(Math.max(...values))
		// Independent per database name.
		expect(await allocateOpenSeq('seq-db-other')).toBe(1)
	})

	test('the later-opened tab wins even when the wall clock moved backwards between opens', async () => {
		const now = vi.spyOn(Date, 'now')
		now.mockReturnValue(2_000_000)
		const older = gate('A', 'a')
		await older.open()
		now.mockReturnValue(1_000_000) // clock moved backwards (NTP, VM resume)
		const newer = gate('B', 'b')
		const opened = newer.open()
		await waitUntil(() => older.getState() === 'retired', 'older tab retired')
		await opened
		expect(newer.getState()).toBe('open')
		expect(older.isSuperseded()).toBe(true)
	})

	test('two opens in the same millisecond: the later allocation wins', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(5)
		const first = gate('A', 'a')
		const second = gate('B', 'b')
		const opens = [first.open(), second.open()]
		// The first tab may still be opening when it learns of the second: it then retires.
		opens[0]?.catch(() => undefined)
		await waitUntil(() => first.getState() === 'retired', 'first tab retired')
		await expect(opens[1]).resolves.toBeUndefined()
		expect(first.getIdentity()?.openSeq).toBeLessThan(second.getIdentity()?.openSeq ?? 0)
	})

	test('concurrent opens with interleaved allocations: the higher openSeq wins either way', async () => {
		let release: (value: number) => void = () => {}
		const slowFirst = new Promise<number>((resolve) => {
			release = resolve
		})
		const a = gate('A', 'a', { allocateOpenSeq: () => slowFirst })
		const b = gate('B', 'b', { allocateOpenSeq: async () => 1 })
		const openA = a.open()
		const openB = b.open()
		await waitUntil(() => b.getState() === 'open', 'b open (no other tab yet)')
		release(2) // a was allocated after b
		await expect(openA).resolves.toBeUndefined()
		await waitUntil(() => b.getState() === 'retired', 'b retired for the later a')
		await openB
	})

	test('a higher storage format wins over a later open', async () => {
		const newFormat = gate('B', 'b', { format: 2 })
		await newFormat.open()
		const oldFormat = gate('A', 'a', { format: 1 })
		await expect(oldFormat.open()).rejects.toBeInstanceOf(BuildSupersededError)
		await waitUntil(() => oldFormat.getState() === 'retired', 'old format retired')
		expect(newFormat.getState()).toBe('open')
	})

	test('rollback: build B open, build A reopened later retires B', async () => {
		const b = gate('B', 'b')
		await b.open()
		const a = gate('A', 'a2')
		await a.open()
		expect(b.getState()).toBe('retired')
		expect(a.getState()).toBe('open')
	})
})

describe('retirement protocol', () => {
	test('same build in two tabs: no retirement, no waiting, no prompt', async () => {
		const one = gate('A', 'one')
		const two = gate('A', 'two')
		const superseded = vi.fn()
		one.onSuperseded(superseded)
		two.onSuperseded(superseded)
		await one.open()
		await two.open()
		await flushMicrotasks()
		expect(superseded).not.toHaveBeenCalled()
		expect(one.getState()).toBe('open')
		expect(two.getState()).toBe('open')
		expect(eventsOf('store:build-gate-waiting')).toHaveLength(0)
	})

	test('listeners run before any step, steps run in phase order, the lock goes last', async () => {
		const older = gate('A', 'a')
		await older.open()
		const order: string[] = []
		older.onSuperseded(({ newer }) => order.push(`announce:${newer.build}`))
		for (const phase of ['roles', 'sync', 'durability', 'drain'] as RetirePhase[]) {
			older.addRetireStep(phase, async () => {
				order.push(phase)
				expect(locks.heldNames().some((name) => name.includes('"tabId":"a"'))).toBe(true)
			})
		}
		const newer = gate('B', 'b')
		await newer.open()
		expect(order).toEqual(['announce:B', 'drain', 'durability', 'sync', 'roles'])
		expect(locks.heldNames().some((name) => name.includes('"tabId":"a"'))).toBe(false)
		const retired = MockBroadcastChannel.posted.find(
			(entry) => (entry.data as { type?: string }).type === 'kora-build-retired',
		)
		expect(retired?.from).toBe('a')
	})

	test('an older tab that has not processed the hello is still found through query()', async () => {
		const older = gate('A', 'a')
		await older.open()
		MockBroadcastChannel.hold('a')
		const newer = gate('B', 'b')
		const opening = newer.open()
		const state = settled(opening)
		await flushMicrotasks(200)
		expect(state()).toBe('pending')
		expect(newer.getState()).toBe('waiting')
		expect(older.getState()).toBe('open')
		MockBroadcastChannel.release('a')
		await opening
		expect(older.getState()).toBe('retired')
	})

	test('a slow retirement keeps the gate closed for 60 s; waiting is reported at 10 s; no deadline', async () => {
		vi.useFakeTimers()
		const older = gate('A', 'a')
		await older.open()
		let finish: () => void = () => {}
		older.addRetireStep(
			'durability',
			() =>
				new Promise<void>((resolve) => {
					finish = resolve
				}),
		)
		const newer = gate('B', 'b')
		const opening = newer.open()
		const state = settled(opening)
		await vi.advanceTimersByTimeAsync(9_999)
		expect(eventsOf('store:build-gate-waiting')).toHaveLength(0)
		await vi.advanceTimersByTimeAsync(1)
		const waiting = eventsOf('store:build-gate-waiting')
		expect(waiting).toHaveLength(1)
		expect(waiting[0]?.reason).toBe('live-writer')
		expect(waiting[0]?.waitingFor.map((tab) => tab.build)).toEqual(['A'])
		await vi.advanceTimersByTimeAsync(50_000)
		expect(state()).toBe('pending')
		finish()
		await vi.advanceTimersByTimeAsync(0)
		await opening
		expect(state()).toBe('resolved')
	})

	test('an older tab with unsaved writes makes the waiting reason unsaved-writes', async () => {
		vi.useFakeTimers()
		const older = gate('A', 'a')
		await older.open()
		let finish: () => void = () => {}
		older.addRetireStep('durability', async () => {
			older.reportUnsavedWrites(true)
			await new Promise<void>((resolve) => {
				finish = resolve
			})
			older.reportUnsavedWrites(false)
		})
		const newer = gate('B', 'b')
		const opening = newer.open()
		await vi.advanceTimersByTimeAsync(10_000)
		const waiting = eventsOf('store:build-gate-waiting')
		expect(waiting.at(-1)?.reason).toBe('unsaved-writes')
		expect(newer.snapshot().waiting?.reason).toBe('unsaved-writes')
		expect(older.snapshot().unsaved).toBe(true)
		finish()
		await vi.advanceTimersByTimeAsync(0)
		await opening
	})

	test('mayLead() refuses and retires when a newer build is listed', async () => {
		const older = gate('A', 'a')
		await older.open()
		MockBroadcastChannel.hold('a')
		const newer = gate('B', 'b')
		void newer.open()
		await waitUntil(() => newer.getState() === 'waiting', 'newer waiting')
		expect(older.getState()).toBe('open')
		await expect(older.mayLead()).resolves.toBe(false)
		expect(older.isSuperseded()).toBe(true)
		await expect(older.mayLead()).resolves.toBe(false)
	})

	test('a heartbeat with a newer identity retires the tab', async () => {
		const older = gate('A', 'a')
		await older.open()
		const leaderChannel = new MockBroadcastChannel('kora-storage-gate-db')
		leaderChannel.postMessage({
			type: 'kora-leader-heartbeat',
			epoch: 'e',
			source: 'worker',
			identity: { build: 'B', format: 1, openSeq: 99, tabId: 'zz' },
		})
		await waitUntil(() => older.getState() === 'retired', 'retired by heartbeat')
	})

	test('a hello from a lower key or the same build never retires a tab', async () => {
		const tab = gate('A', 'a')
		await tab.open()
		const channel = new MockBroadcastChannel('kora-storage-gate-db')
		channel.postMessage({
			type: BUILD_HELLO,
			identity: { build: 'B', format: 1, openSeq: 0, tabId: 'old' },
		})
		channel.postMessage({
			type: BUILD_HELLO,
			identity: { build: 'A', format: 1, openSeq: 99, tabId: 'same' },
		})
		await flushMicrotasks()
		expect(tab.getState()).toBe('open')
	})

	test('a tab back from the back/forward cache that missed every hello retires on resume', async () => {
		const older = gate('A', 'a')
		await older.open()
		older.suspend()
		expect(older.getState()).toBe('suspended')
		const newer = gate('B', 'b')
		await newer.open() // the suspended tab released its lock: nothing to wait for
		await expect(older.resume()).resolves.toBe(false)
		await waitUntil(() => older.getState() === 'retired', 'retired after resume')
		expect(newer.getState()).toBe('open')
	})

	test('a resumed tab of the same build reopens', async () => {
		const tab = gate('A', 'a')
		await tab.open()
		tab.suspend()
		await expect(tab.resume()).resolves.toBe(true)
		expect(tab.getState()).toBe('open')
	})

	test('waitForPeersToRetire waits for superseded peers only, never for the winner', async () => {
		const leader = gate('A', 'leader')
		await leader.open()
		const follower = gate('A', 'follower')
		await follower.open()
		let finishFollower: () => void = () => {}
		follower.addRetireStep(
			'drain',
			() =>
				new Promise<void>((resolve) => {
					finishFollower = resolve
				}),
		)
		let peersDone = false
		leader.addRetireStep('roles', async () => {
			await leader.waitForPeersToRetire()
			peersDone = true
		})
		const newer = gate('B', 'b')
		const opening = newer.open()
		await waitUntil(() => follower.getState() === 'retiring', 'follower retiring')
		await flushMicrotasks(100)
		expect(peersDone).toBe(false)
		finishFollower()
		await opening
		expect(peersDone).toBe(true)
	})
})

describe('closing and failing steps', () => {
	test('closing a gate while it waits rejects its open and never reaches open', async () => {
		const older = gate('A', 'a')
		await older.open()
		MockBroadcastChannel.hold('a')
		const newer = gate('B', 'b')
		const opening = newer.open()
		await waitUntil(() => newer.getState() === 'waiting', 'newer waiting')
		newer.close()
		await expect(opening).rejects.toBeInstanceOf(VersionGateClosedError)
		expect(newer.getState()).toBe('closed')
		expect(locks.heldNames().some((name) => name.includes('"tabId":"b"'))).toBe(false)
		MockBroadcastChannel.release('a')
	})

	test('closing a gate whose exclusive lock is queued withdraws the request', async () => {
		const first = gate('A', 'one', { runtime: { browser: true, locks, createChannel: null } })
		await first.open()
		const second = gate('A', 'two', { runtime: { browser: true, locks, createChannel: null } })
		const opening = second.open()
		await waitUntil(() => eventsOf('store:tab-exclusive').length === 1, 'second queued')
		second.close()
		await expect(opening).rejects.toBeInstanceOf(VersionGateClosedError)
		first.close()
		await flushMicrotasks(50)
		expect(locks.heldNames()).toEqual([])
	})

	test('a failing retirement step keeps the tab lock and runs again until it succeeds', async () => {
		const older = gate('A', 'a', { retryBackoffMs: { initial: 1, max: 1 } })
		await older.open()
		let failures = 2
		older.addRetireStep('roles', async () => {
			if (failures > 0) {
				failures -= 1
				throw new Error('query failed')
			}
		})
		const error = vi.spyOn(console, 'error').mockImplementation(() => {})
		const newer = gate('B', 'b')
		const opening = newer.open()
		await waitUntil(() => failures === 1, 'first failure')
		expect(locks.heldNames().some((name) => name.includes('"tabId":"a"'))).toBe(true)
		expect(newer.getState()).toBe('waiting')
		await opening
		expect(failures).toBe(0)
		expect(error).toHaveBeenCalledWith(
			expect.stringContaining('retirement step "roles" failed'),
			expect.any(Error),
		)
	})
})

describe('coordination APIs (fail closed)', () => {
	test('no window: the gate does not apply', async () => {
		const offGate = gate('A', 'a', { runtime: { browser: false, locks, createChannel: null } })
		await offGate.open()
		expect(offGate.mode).toBe('off')
		expect(locks.heldNames()).toEqual([])
	})

	test('no Web Locks: open refuses with TAB_COORDINATION_UNAVAILABLE', async () => {
		const noLocks = gate('A', 'a', { runtime: { browser: true, locks: null } })
		await expect(noLocks.open()).rejects.toBeInstanceOf(TabCoordinationUnavailableError)
		expect(eventsOf('store:tab-coordination-unavailable')).toHaveLength(1)
	})

	test('plain HTTP (not a secure context, so no Web Locks): no gate, as before it, with one warning per page', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const first = gate('A', 'a', {
			runtime: { browser: true, locks: null, insecureContext: true },
		})
		await first.open()
		expect(first.mode).toBe('insecure-context')
		expect(first.getState()).toBe('open')
		const second = new VersionGate({
			dbName: 'other-db',
			build: 'B',
			runtime: { browser: true, locks: null, createChannel: null, insecureContext: true },
		})
		await second.open()
		const warnings = warn.mock.calls.filter((call) => String(call[0]).includes('HTTPS'))
		expect(warnings).toHaveLength(1)
		expect(eventsOf('store:tab-coordination-unavailable')).toHaveLength(0)
	})

	test('a lock request rejected for another reason (SecurityError in a sandboxed frame) reports that error, not VERSION_GATE_CLOSED', async () => {
		const securityError = Object.assign(new Error('The request was denied.'), {
			name: 'SecurityError',
		})
		const denying = {
			request: () => Promise.reject(securityError),
			query: () => Promise.resolve({ held: [], pending: [] }),
		}
		const tab = gate('A', 'a', {
			runtime: {
				browser: true,
				locks: denying as unknown as MockLockManager,
				createChannel: (name) => new MockBroadcastChannel(name, 'a'),
			},
		})
		await expect(tab.open()).rejects.toBe(securityError)
	})

	test('no Web Locks with allowUncoordinatedTabs: opens single-tab with a warning', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const tab = gate('A', 'a', {
			runtime: { browser: true, locks: null },
			allowUncoordinatedTabs: true,
		})
		await tab.open()
		expect(tab.mode).toBe('uncoordinated')
		expect(warn).toHaveBeenCalledWith(expect.stringContaining('allowUncoordinatedTabs'))
	})

	test('no BroadcastChannel: exclusive single tab; the second waits and opens when the first closes', async () => {
		const first = gate('A', 'one', { runtime: { browser: true, locks, createChannel: null } })
		await first.open()
		expect(first.mode).toBe('exclusive')
		const second = gate('A', 'two', { runtime: { browser: true, locks, createChannel: null } })
		const opening = second.open()
		const state = settled(opening)
		await flushMicrotasks(200)
		expect(state()).toBe('pending')
		const exclusive = eventsOf('store:tab-exclusive')
		expect(exclusive).toHaveLength(1)
		expect(exclusive[0]?.heldBy?.tabId).toBe('one')
		first.close()
		await opening
		expect(second.getState()).toBe('open')
	})

	test('no BroadcastChannel: a newer build waiting behind an older one reports the build gate', async () => {
		const older = gate('A', 'one', { runtime: { browser: true, locks, createChannel: null } })
		await older.open()
		const newer = gate('B', 'two', { runtime: { browser: true, locks, createChannel: null } })
		const opening = newer.open()
		await waitUntil(() => eventsOf('store:build-gate-waiting').length === 1, 'gate waiting')
		expect(older.getState()).toBe('open') // cannot be told to retire without a channel
		older.close()
		await opening
	})
})

describe('builds from before the gate', () => {
	test('a pre-gate leader (leader lock, no tab lock) holds the gate until its lock is released', async () => {
		let releaseLegacy: () => void = () => {}
		void locks.request(
			leaderLockName(DB),
			{ mode: 'exclusive' },
			() =>
				new Promise<void>((resolve) => {
					releaseLegacy = resolve
				}),
		)
		await flushMicrotasks()
		const tab = gate('B', 'b', { heartbeatMs: 1 })
		const opening = tab.open()
		const state = settled(opening)
		await waitUntil(() => tab.getState() === 'waiting', 'waiting for the legacy leader')
		expect(state()).toBe('pending')
		expect(eventsOf('store:legacy-build-detected')).toHaveLength(1)
		releaseLegacy()
		await opening
		expect(tab.getState()).toBe('open')
	})

	test('a pre-gate leader next to gated tabs is told apart by the missing gated-leader marker', async () => {
		const sameBuild = gate('B', 'peer', { heartbeatMs: 1 })
		await sameBuild.open()
		let releaseLegacy: () => void = () => {}
		void locks.request(
			leaderLockName(DB),
			{ mode: 'exclusive' },
			() =>
				new Promise<void>((resolve) => {
					releaseLegacy = resolve
				}),
		)
		const tab = gate('B', 'b', { heartbeatMs: 1 })
		const opening = tab.open()
		await waitUntil(() => tab.getState() === 'waiting', 'waiting for the legacy leader')
		expect(tab.snapshot().waiting?.reason).toBe('legacy-build')
		releaseLegacy()
		await opening
	})

	test('a gated leader (marker held) is never mistaken for a pre-gate one', async () => {
		const leader = gate('B', 'leader', { heartbeatMs: 1 })
		await leader.open()
		void locks.request(leaderLockName(DB), { mode: 'exclusive' }, () => new Promise<void>(() => {}))
		void locks.request(
			gatedLeaderLockName(DB),
			{ mode: 'exclusive' },
			() => new Promise<void>(() => {}),
		)
		const tab = gate('B', 'b', { heartbeatMs: 1 })
		await tab.open()
		expect(eventsOf('store:legacy-build-detected')).toHaveLength(0)
	})
})

test('build-unidentified is reported once per open when no build is given', async () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
	const tab = new VersionGate({
		dbName: DB,
		emitter,
		runtime: { browser: true, locks, createChannel: (name) => new MockBroadcastChannel(name, 'u') },
		allocateOpenSeq: allocate,
	})
	tab.useSchemaFingerprint({ version: 3, collections: {}, relations: {} } as never)
	await tab.open()
	const reported = eventsOf('store:build-unidentified')
	expect(reported).toHaveLength(1)
	expect(reported[0]?.fingerprint).toMatch(/^schema-1-3-/)
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('createApp({ build })'))
})
