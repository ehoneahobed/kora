import { afterEach, describe, expect, test } from 'vitest'
import { acquireNodeLock, isNodeLockHeld, nodeLockName, tryAcquireNodeLock } from './node-lock'

/** A minimal in-process Web Locks implementation (exclusive locks only). */
function installFakeLocks(): void {
	const held = new Set<string>()
	const waiters = new Map<string, Array<() => void>>()
	const release = (name: string): void => {
		held.delete(name)
		const next = waiters.get(name)?.shift()
		next?.()
	}
	const locks = {
		async request(
			name: string,
			options: { ifAvailable?: boolean },
			callback: (lock: { name: string } | null) => Promise<void> | void,
		): Promise<void> {
			if (held.has(name)) {
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
			held.add(name)
			try {
				await callback({ name })
			} finally {
				release(name)
			}
		},
		async query(): Promise<{ held: Array<{ name: string }> }> {
			return { held: [...held].map((name) => ({ name })) }
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
})
