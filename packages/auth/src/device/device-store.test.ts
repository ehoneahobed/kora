import { describe, expect, it } from 'vitest'
import { generateDeviceKeyPair } from './device-identity'
import {
	InMemoryDeviceKeyStore,
	IndexedDBDeviceKeyStore,
	createDeviceKeyStore,
} from './device-store'

describe('device-store', () => {
	describe('InMemoryDeviceKeyStore', () => {
		it('saves and loads a key pair', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPair = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPair)
			const loaded = await store.loadKeyPair('device-1')

			expect(loaded).not.toBeNull()
			expect(loaded).toBe(keyPair)
		})

		it('returns null when loading a nonexistent key pair', async () => {
			const store = new InMemoryDeviceKeyStore()

			const loaded = await store.loadKeyPair('nonexistent-device')

			expect(loaded).toBeNull()
		})

		it('overwrites a previously stored key pair', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPairA)
			await store.saveKeyPair('device-1', keyPairB)
			const loaded = await store.loadKeyPair('device-1')

			expect(loaded).toBe(keyPairB)
		})

		it('deletes a stored key pair', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPair = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPair)
			await store.deleteKeyPair('device-1')
			const loaded = await store.loadKeyPair('device-1')

			expect(loaded).toBeNull()
		})

		it('delete is a no-op for nonexistent key pair', async () => {
			const store = new InMemoryDeviceKeyStore()

			// Should not throw
			await store.deleteKeyPair('nonexistent-device')
		})

		it('hasKeyPair returns true when key pair exists', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPair = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPair)

			expect(await store.hasKeyPair('device-1')).toBe(true)
		})

		it('hasKeyPair returns false when key pair does not exist', async () => {
			const store = new InMemoryDeviceKeyStore()

			expect(await store.hasKeyPair('nonexistent-device')).toBe(false)
		})

		it('hasKeyPair returns false after deletion', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPair = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPair)
			await store.deleteKeyPair('device-1')

			expect(await store.hasKeyPair('device-1')).toBe(false)
		})

		it('stores key pairs independently for different device IDs', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()

			await store.saveKeyPair('device-a', keyPairA)
			await store.saveKeyPair('device-b', keyPairB)

			const loadedA = await store.loadKeyPair('device-a')
			const loadedB = await store.loadKeyPair('device-b')

			expect(loadedA).toBe(keyPairA)
			expect(loadedB).toBe(keyPairB)
		})

		it('deleting one device does not affect another', async () => {
			const store = new InMemoryDeviceKeyStore()
			const keyPairA = await generateDeviceKeyPair()
			const keyPairB = await generateDeviceKeyPair()

			await store.saveKeyPair('device-a', keyPairA)
			await store.saveKeyPair('device-b', keyPairB)

			await store.deleteKeyPair('device-a')

			expect(await store.hasKeyPair('device-a')).toBe(false)
			expect(await store.hasKeyPair('device-b')).toBe(true)
			expect(await store.loadKeyPair('device-b')).toBe(keyPairB)
		})
	})

	describe('createDeviceKeyStore', () => {
		it('returns an InMemoryDeviceKeyStore in Node.js (no IndexedDB)', () => {
			// Node.js does not provide globalThis.indexedDB, so the factory
			// should fall back to the in-memory implementation.
			const store = createDeviceKeyStore()

			expect(store).toBeInstanceOf(InMemoryDeviceKeyStore)
		})

		it('returned store is functional', async () => {
			const store = createDeviceKeyStore()
			const keyPair = await generateDeviceKeyPair()

			await store.saveKeyPair('device-1', keyPair)
			const loaded = await store.loadKeyPair('device-1')

			expect(loaded).not.toBeNull()
		})
	})

	describe('IndexedDBDeviceKeyStore', () => {
		it('is exported and can be instantiated', () => {
			// Verify the class is exported and constructable, even though
			// IndexedDB is not available in Node.js. The constructor does not
			// access IndexedDB; the connection is lazy (opened on first use).
			const store = new IndexedDBDeviceKeyStore()

			expect(store).toBeInstanceOf(IndexedDBDeviceKeyStore)
		})
	})
})
