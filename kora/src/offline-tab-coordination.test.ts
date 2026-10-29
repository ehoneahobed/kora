import { type VersionGateSnapshot, type VersionGateState, tabLockName } from '@korajs/store'
import { describe, expect, test, vi } from 'vitest'
import { FakeLockManager } from '../tests/support/fake-lock-manager'
import {
	type PageLifecycleSource,
	type TabCoordinationGate,
	createTabCoordination,
} from './offline-tab-coordination'

const identity = { build: 'b1', format: 1, openSeq: 4, tabId: 'tab-4' }

function fakeGate(mode: TabCoordinationGate['mode'], state: VersionGateState = 'open') {
	let current = state
	const listeners = new Set<(snapshot: VersionGateSnapshot) => void>()
	const gate: TabCoordinationGate = {
		mode,
		getIdentity: () => identity,
		getState: () => current,
		onChange: (listener) => {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	}
	return {
		gate,
		listeners,
		move(next: VersionGateState) {
			current = next
			for (const listener of [...listeners]) {
				listener({ state: next, identity, newer: null, unsaved: false, waiting: null })
			}
		},
	}
}

function fakePage() {
	const handlers = new Set<(event: { persisted?: boolean }) => void>()
	const page: PageLifecycleSource = {
		addEventListener: (_type, listener) => {
			handlers.add(listener)
		},
		removeEventListener: (_type, listener) => {
			handlers.delete(listener)
		},
	}
	return {
		page,
		handlers,
		show: (persisted: boolean) => {
			for (const handler of [...handlers]) handler({ persisted })
		},
	}
}

describe('createTabCoordination', () => {
	test.each([
		['full', 'locks'],
		['exclusive', 'exclusive'],
		['off', 'explicit'],
		['uncoordinated', 'explicit'],
		['unavailable', 'explicit'],
		['insecure-context', 'explicit'],
	] as const)('gate mode %s holds as %s', (gateMode, expected) => {
		const coordination = createTabCoordination(fakeGate(gateMode).gate, {
			dbName: 'db',
			locks: new FakeLockManager(),
			page: null,
		})
		expect(coordination.mode).toBe(expected)
	})

	test('without a gate or without Web Locks holds are explicit, with a random tab id', () => {
		const a = createTabCoordination(null, {
			dbName: 'db',
			locks: new FakeLockManager(),
			page: null,
		})
		const b = createTabCoordination(fakeGate('full').gate, {
			dbName: 'db',
			locks: null,
			page: null,
		})
		expect(a.mode).toBe('explicit')
		expect(b.mode).toBe('explicit')
		expect(a.tabId).not.toBe(createTabCoordination(null, { dbName: 'db', page: null }).tabId)
	})

	test('names this tab by its version-gate tab lock', () => {
		const coordination = createTabCoordination(fakeGate('full').gate, {
			dbName: 'db',
			locks: new FakeLockManager(),
			page: null,
		})
		expect(coordination.tabId).toBe('tab-4')
		expect(coordination.tabLock()).toBe(tabLockName('db', identity))
		expect(coordination.parseTabLock(tabLockName('db', identity))).toBe('tab-4')
		expect(coordination.parseTabLock('kora-db:db')).toBeNull()
		expect(coordination.parseTabLock(tabLockName('other', identity))).toBeNull()
	})

	test('a resume is a suspended gate that opens again, not the first open', () => {
		const fake = fakeGate('full', 'opening')
		const coordination = createTabCoordination(fake.gate, {
			dbName: 'db',
			locks: new FakeLockManager(),
			page: null,
		})
		const resumed = vi.fn()
		const off = coordination.onResume(resumed)
		fake.move('open')
		expect(resumed).not.toHaveBeenCalled()
		fake.move('suspended')
		fake.move('opening')
		expect(resumed).not.toHaveBeenCalled()
		fake.move('open')
		expect(resumed).toHaveBeenCalledTimes(1)
		fake.move('open')
		expect(resumed).toHaveBeenCalledTimes(1)
		off()
		expect(fake.listeners.size).toBe(0)
	})

	test('a page restored from the back-forward cache records holds once the gate is open', () => {
		const fake = fakeGate('full')
		const page = fakePage()
		const coordination = createTabCoordination(fake.gate, {
			dbName: 'db',
			locks: new FakeLockManager(),
			page: page.page,
		})
		const resumed = vi.fn()
		const off = coordination.onResume(resumed)
		page.show(false)
		expect(resumed).not.toHaveBeenCalled()
		page.show(true)
		expect(resumed).toHaveBeenCalledTimes(1)
		fake.move('suspended')
		page.show(true)
		expect(resumed).toHaveBeenCalledTimes(1)
		off()
		expect(page.handlers.size).toBe(0)
	})
})
