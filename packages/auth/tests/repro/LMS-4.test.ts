/**
 * LMS-4 — durable-storage request policy.
 *
 * Contrary to the report, Kora already calls `navigator.storage.persist()` on every
 * browser `createApp()` with OPFS: initialize-app.ts:153 -> resolveBlobStore ->
 * createOpfsBlobStore -> createOpfsBlobDirectory (packages/store/src/blob/opfs-blob-store.ts:151-157),
 * and it AWAITS the result before `app.ready`, then discards it.
 *
 * In Firefox persist() shows a permission prompt and resolves only when the user
 * answers. A state-of-the-art framework never puts a permission prompt on the
 * critical startup path. These tests FAIL at HEAD.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBlobStore } from '../../../../kora/src/blob/resolve-blob-store'
import { createOpfsBlobDirectory } from '../../../store/src/blob/opfs-blob-store'

function fakeDirectory(): unknown {
	const dir = {
		getDirectoryHandle: async () => dir,
		getFileHandle: async () => {
			throw Object.assign(new Error('nf'), { name: 'NotFoundError' })
		},
		removeEntry: async () => {},
		keys: async function* () {},
	}
	return dir
}

/** Firefox: persist() opens a doorhanger; the promise stays pending until the user answers. */
function stubFirefoxPendingPrompt(): { persistCalls: () => number } {
	let calls = 0
	vi.stubGlobal('navigator', {
		storage: {
			persist: () => {
				calls++
				return new Promise<boolean>(() => {})
			},
			persisted: async () => false,
			getDirectory: async () => fakeDirectory(),
		},
	})
	return { persistCalls: () => calls }
}

async function settlesWithoutUserAction(promise: Promise<unknown>): Promise<boolean> {
	let settled = false
	promise.then(
		() => {
			settled = true
		},
		() => {
			settled = true
		},
	)
	// Drain the macrotask queue a few times; no user will ever answer the prompt.
	for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
	return settled
}

afterEach(() => {
	vi.unstubAllGlobals()
})

describe('LMS-4: persist() must never block app startup', () => {
	it('createOpfsBlobDirectory resolves while a persist() prompt is pending', async () => {
		stubFirefoxPendingPrompt()
		expect(await settlesWithoutUserAction(createOpfsBlobDirectory('kora-blobs'))).toBe(true)
	})

	it('createApp blob-store resolution (initialize-app.ts:153) resolves while a persist() prompt is pending', async () => {
		stubFirefoxPendingPrompt()
		expect(await settlesWithoutUserAction(resolveBlobStore(undefined, 'lms'))).toBe(true)
	})
})
