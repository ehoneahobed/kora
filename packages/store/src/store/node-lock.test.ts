import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { acquireNodeLock, isNodeLockHeld, nodeLockName, tryAcquireNodeLock } from './node-lock'
import { Store } from './store'

/** A minimal in-process Web Locks implementation (exclusive and shared modes). */
function installFakeLocks(): void {
	const held = new Map<string, { mode: 'exclusive' | 'shared'; count: number }>()
	const waiters = new Map<string, Array<() => void>>()
	const grantable = (name: string, mode: 'exclusive' | 'shared'): boolean => {
		const current = held.get(name)
		return !current || (mode === 'shared' && current.mode === 'shared')
	}
	const release = (name: string): void => {
		const current = held.get(name)
		if (!current) return
		current.count--
		if (current.count > 0) return
		held.delete(name)
		const next = waiters.get(name)?.shift()
		next?.()
	}
	const locks = {
		async request(
			name: string,
			options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
			callback: (lock: { name: string } | null) => Promise<void> | void,
		): Promise<void> {
			const mode = options.mode ?? 'exclusive'
			while (!grantable(name, mode)) {
				if (options.ifAvailable) {
					await callback(null)
					return
				}
				await new Promise<void>((resolve) => {
					const list = waiters.get(name) ?? []
					list.push(resolve)
					waiters.set(name, list)
				})
			}
			const current = held.get(name)
			if (current) current.count++
			else held.set(name, { mode, count: 1 })
			try {
				await callback({ name })
			} finally {
				release(name)
			}
		},
		async query(): Promise<{ held: Array<{ name: string }> }> {
			return { held: [...held.keys()].map((name) => ({ name })) }
		},
	}
	Object.defineProperty(globalThis, 'navigator', {
		value: { locks },
		configurable: true,
		writable: true,
	})
}

const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
afterEach(() => {
	if (original) Object.defineProperty(globalThis, 'navigator', original)
	else Reflect.deleteProperty(globalThis, 'navigator')
})

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('node locks (RT-40)', () => {
	test('a live tab holds its node; another context cannot take it until it is released', async () => {
		installFakeLocks()
		const name = nodeLockName('db', 'tab-1')
		const release = acquireNodeLock(name)
		await settle()
		expect(await isNodeLockHeld(name)).toBe(true)
		expect(await tryAcquireNodeLock(name)).toBeNull()
		release()
		await settle()
		expect(await isNodeLockHeld(name)).toBe(false)
		const adopted = await tryAcquireNodeLock(name)
		expect(adopted).not.toBeNull()
		expect(await isNodeLockHeld(name)).toBe(true)
		adopted?.()
		await settle()
		expect(await isNodeLockHeld(name)).toBe(false)
	})

	test('a tab that reopens while an adopter holds its node waits for the lock', async () => {
		installFakeLocks()
		const name = nodeLockName('db', 'tab-1')
		const adopter = await tryAcquireNodeLock(name)
		const tab = acquireNodeLock(name)
		adopter?.()
		await settle()
		await settle()
		expect(await isNodeLockHeld(name)).toBe(true)
		tab()
		await settle()
		expect(await isNodeLockHeld(name)).toBe(false)
	})

	test('without Web Locks every node is free and acquisition is a no-op', async () => {
		Object.defineProperty(globalThis, 'navigator', {
			value: {},
			configurable: true,
			writable: true,
		})
		const name = nodeLockName('db', 'tab-1')
		const release = acquireNodeLock(name)
		expect(await isNodeLockHeld(name)).toBe(false)
		const claim = await tryAcquireNodeLock(name)
		expect(typeof claim).toBe('function')
		release()
		claim?.()
	})
	test('tabs pinned to one node share its lock; a repair cannot take it while any is open', async () => {
		installFakeLocks()
		const name = nodeLockName('db', 'pinned-device')
		const first = acquireNodeLock(name, 'shared')
		const second = acquireNodeLock(name, 'shared')
		await settle()
		expect(await isNodeLockHeld(name)).toBe(true)
		expect(await tryAcquireNodeLock(name)).toBeNull()
		first()
		await settle()
		expect(await tryAcquireNodeLock(name)).toBeNull()
		second()
		await settle()
		const repair = await tryAcquireNodeLock(name)
		expect(repair).not.toBeNull()
		repair?.()
	})
	test('a store pinned to a node holds it while open', async () => {
		installFakeLocks()
		const dir = mkdtempSync(join(tmpdir(), 'node-lock-'))
		try {
			const schema = defineSchema({
				version: 1,
				collections: { todos: { fields: { title: t.string() } } },
			})
			const store = new Store({
				schema,
				adapter: new BetterSqlite3Adapter(join(dir, 'db.sqlite')),
				nodeId: 'pinned-device',
			})
			await store.open()
			await settle()
			// A repair of this node from another context (another account's database after the
			// browser moved it off the node) finds it live.
			const name = nodeLockName('kora-db', 'pinned-device')
			expect(await tryAcquireNodeLock(name)).toBeNull()
			await store.close()
			await settle()
			const free = await tryAcquireNodeLock(name)
			expect(free).not.toBeNull()
			free?.()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
