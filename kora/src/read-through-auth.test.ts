import type { AuthSyncBinding, AuthSyncState } from '@korajs/core/bindings'
import { ReadThroughError } from '@korajs/sync/read'
import { describe, expect, test, vi } from 'vitest'
import { readThroughAuthFor } from './read-through-auth'

function binding(state: AuthSyncState | undefined, token = 'tok'): AuthSyncBinding {
	return {
		auth: vi.fn(async () => ({ token })),
		...(state !== undefined ? { resolveSyncState: async () => state } : {}),
	}
}
const signedIn: AuthSyncState = { state: 'authenticated', userId: 'u1', token: 'tok' }

describe('readThroughAuthFor', () => {
	test('gives the binding token while a user is signed in', async () => {
		const auth = readThroughAuthFor(binding(signedIn), ReadThroughError)
		await expect(auth()).resolves.toEqual({ token: 'tok' })
	})

	test('passes forceRefresh to the binding so a 401 refreshes the token', async () => {
		const b = binding(signedIn)
		await readThroughAuthFor(b, ReadThroughError)({ forceRefresh: true })
		expect(b.auth).toHaveBeenCalledWith({ forceRefresh: true })
	})

	test('stands aside, without retrying, when nobody is signed in', async () => {
		const b = binding({ state: 'signed-out', mayConnectAnonymously: false })
		const error = await readThroughAuthFor(b, ReadThroughError)().catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ReadThroughError)
		expect((error as ReadThroughError).retriable).toBe(false)
		expect(b.auth).not.toHaveBeenCalled()
	})

	test('asks to be retried while the session is still being restored', async () => {
		const b = binding({ state: 'loading' })
		const error = await readThroughAuthFor(b, ReadThroughError)().catch((e: unknown) => e)
		expect((error as ReadThroughError).retriable).toBe(true)
		expect(b.auth).not.toHaveBeenCalled()
	})

	test('stands aside when the signed-in session has no token', async () => {
		const b = binding(signedIn, '')
		const error = await readThroughAuthFor(b, ReadThroughError)().catch((e: unknown) => e)
		expect((error as ReadThroughError).retriable).toBe(false)
	})

	test('a binding without a state reader is trusted for its token', async () => {
		const auth = readThroughAuthFor(binding(undefined), ReadThroughError)
		await expect(auth()).resolves.toEqual({ token: 'tok' })
	})
})
