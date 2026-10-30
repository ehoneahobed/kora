import type { SyncStatusInfo } from '@korajs/sync'
import { OFFLINE_SYNC_STATUS } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import {
	FIRST_DATA_EVENT,
	type FirstDataTarget,
	firstDataSettled,
	wireFirstDataSignal,
} from './first-data-signal'

const status = (overrides: Partial<SyncStatusInfo>): SyncStatusInfo => ({
	...OFFLINE_SYNC_STATUS,
	...overrides,
})

const connecting = status({ status: 'syncing', phase: 'connecting' })
const handshaking = status({ status: 'syncing', phase: 'handshaking' })
const applyingFirst = status({
	status: 'syncing',
	phase: 'applying',
	hasInFlightDeliveryBatch: true,
	initialSync: { complete: false, receivedBatches: 1, totalBatches: 40, progress: 0.025 },
})
const firstApplied = status({
	status: 'syncing',
	phase: 'receiving',
	initialSync: { complete: false, receivedBatches: 1, totalBatches: 40, progress: 0.025 },
})
const caughtUp = status({ status: 'synced', phase: 'streaming' })

function fakePage(): FirstDataTarget & { events: string[] } {
	const events: string[] = []
	return {
		events,
		dispatchEvent(event: Event): boolean {
			events.push(event.type)
			return true
		},
	}
}

function fakeSync(initial: SyncStatusInfo) {
	let current = initial
	const listeners = new Set<(s: SyncStatusInfo) => void>()
	return {
		status: () => current,
		subscribeStatus: (listener: (s: SyncStatusInfo) => void) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		emit(next: SyncStatusInfo): void {
			current = next
			for (const listener of [...listeners]) listener(next)
		},
		listenerCount: () => listeners.size,
	}
}

/** Lets the `ready.then` continuation run (microtasks only, no timers). */
const flush = async (): Promise<void> => {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

describe('firstDataSettled', () => {
	test.each([
		['idle before any attempt', OFFLINE_SYNC_STATUS, false, false],
		['connecting', connecting, true, false],
		['handshaking', handshaking, true, false],
		['first batch still applying', applyingFirst, true, false],
		['first batch applied', firstApplied, true, true],
		['caught up (also with nothing to deliver)', caughtUp, true, true],
		['an attempt that ended offline', OFFLINE_SYNC_STATUS, true, true],
		['signed out', status({ status: 'auth-required', phase: 'suspended' }), false, true],
		['locked keyring', status({ status: 'encryption-locked', phase: 'suspended' }), false, true],
		['schema mismatch', status({ status: 'schema-mismatch', phase: 'blocked' }), true, true],
		['clock error', status({ status: 'clock-error', phase: 'blocked' }), true, true],
		['error', status({ status: 'error', phase: 'blocked' }), true, true],
	])('%s', (_name, value, attempted, expected) => {
		expect(firstDataSettled(value, attempted)).toBe(expected)
	})
})

describe('wireFirstDataSignal', () => {
	test('publishes pending at once, then done with one event for a local-only app at ready', async () => {
		const page = fakePage()
		let resolveReady: () => void = () => {}
		const ready = new Promise<void>((resolve) => {
			resolveReady = resolve
		})
		const sync = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({ ready, syncs: false, ...sync, target: page })
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'pending' })
		await flush()
		expect(page.events).toEqual([])
		resolveReady()
		await flush()
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'done' })
		expect(page.events).toEqual([FIRST_DATA_EVENT])
	})

	test('a syncing app waits through connect and the first batch, then announces once', async () => {
		const page = fakePage()
		const sync = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({ ready: Promise.resolve(), syncs: true, ...sync, target: page })
		await flush()
		// Not connected yet: the template connects right after ready.
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'pending' })
		sync.emit(connecting)
		sync.emit(handshaking)
		sync.emit(applyingFirst)
		expect(page.events).toEqual([])
		sync.emit(firstApplied)
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'done' })
		sync.emit(caughtUp)
		expect(page.events).toEqual([FIRST_DATA_EVENT])
		expect(sync.listenerCount()).toBe(0)
	})

	test('an attempt that fails back to offline settles it (nothing is coming)', async () => {
		const page = fakePage()
		const sync = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({ ready: Promise.resolve(), syncs: true, ...sync, target: page })
		await flush()
		sync.emit(OFFLINE_SYNC_STATUS)
		expect(page.events).toEqual([])
		sync.emit(connecting)
		sync.emit(OFFLINE_SYNC_STATUS)
		expect(page.events).toEqual([FIRST_DATA_EVENT])
	})

	test('a status already settled at ready (signed out) announces right away', async () => {
		const page = fakePage()
		const sync = fakeSync(status({ status: 'auth-required', phase: 'suspended' }))
		wireFirstDataSignal({ ready: Promise.resolve(), syncs: true, ...sync, target: page })
		await flush()
		expect(page.events).toEqual([FIRST_DATA_EVENT])
		expect(sync.listenerCount()).toBe(0)
	})

	test('a failed ready announces too: the shell must still install', async () => {
		const page = fakePage()
		const sync = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({
			ready: Promise.reject(new Error('WASM fetch failed')),
			syncs: true,
			...sync,
			target: page,
		})
		await flush()
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'done' })
		expect(page.events).toEqual([FIRST_DATA_EVENT])
	})

	test('a second app on the page leaves the first one in charge', async () => {
		const page = fakePage()
		const first = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({ ready: Promise.resolve(), syncs: false, ...first, target: page })
		await flush()
		const second = fakeSync(OFFLINE_SYNC_STATUS)
		wireFirstDataSignal({ ready: Promise.resolve(), syncs: true, ...second, target: page })
		await flush()
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'done' })
		expect(page.events).toEqual([FIRST_DATA_EVENT])
		expect(second.listenerCount()).toBe(0)
	})

	test('stopping (app.close) before the first data leaves it pending and unsubscribes', async () => {
		const page = fakePage()
		const sync = fakeSync(OFFLINE_SYNC_STATUS)
		const stop = wireFirstDataSignal({
			ready: Promise.resolve(),
			syncs: true,
			...sync,
			target: page,
		})
		await flush()
		stop()
		expect(sync.listenerCount()).toBe(0)
		sync.emit(caughtUp)
		expect(page.events).toEqual([])
		expect(page.__KORA_FIRST_DATA__).toEqual({ v: 1, state: 'pending' })
	})
})
