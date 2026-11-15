import { MemoryBlobStore } from '@korajs/store'
import { afterEach, describe, expect, test } from 'vitest'
import { defaultBlobDirectory, deleteDefaultBlobStore } from './resolve-blob-store'

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

function fakeOpfs(directories: Set<string>) {
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value: {
			storage: {
				getDirectory: async () => ({
					async removeEntry(name: string, options: { recursive: boolean }) {
						expect(options.recursive).toBe(true)
						if (!directories.delete(name)) {
							throw Object.assign(new Error('not found'), { name: 'NotFoundError' })
						}
					},
				}),
			},
		},
	})
}

afterEach(() => {
	if (realNavigator) Object.defineProperty(globalThis, 'navigator', realNavigator)
	else Reflect.deleteProperty(globalThis, 'navigator')
})

describe("deleting a database's default blob store", () => {
	test("removes the database's own blob directory and nothing else", async () => {
		const directories = new Set([defaultBlobDirectory('kora-db'), defaultBlobDirectory('other')])
		fakeOpfs(directories)
		await expect(deleteDefaultBlobStore(undefined, 'kora-db')).resolves.toBe(true)
		expect([...directories]).toEqual(['other-blobs'])
	})

	test('a database that never stored a blob has nothing to remove', async () => {
		fakeOpfs(new Set())
		await expect(deleteDefaultBlobStore(undefined, 'kora-db')).resolves.toBe(false)
	})

	test("an app's own blob store is left to the app", async () => {
		const directories = new Set([defaultBlobDirectory('kora-db')])
		fakeOpfs(directories)
		await expect(deleteDefaultBlobStore({ store: new MemoryBlobStore() }, 'kora-db')).resolves.toBe(
			false,
		)
		expect(directories.size).toBe(1)
	})

	test('other failures are not hidden', async () => {
		Object.defineProperty(globalThis, 'navigator', {
			configurable: true,
			value: {
				storage: {
					getDirectory: async () => ({
						async removeEntry() {
							throw Object.assign(new Error('locked'), { name: 'NoModificationAllowedError' })
						},
					}),
				},
			},
		})
		await expect(deleteDefaultBlobStore(undefined, 'kora-db')).rejects.toThrow('locked')
	})
})
