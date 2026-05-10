import { describe, expect, it } from 'vitest'
import { DuplicateLinkedIdentityError, InMemoryLinkedIdentityStore } from './linked-identity-store'

describe('InMemoryLinkedIdentityStore', () => {
	it('creates, finds, lists, and deletes linked identities', async () => {
		const store = new InMemoryLinkedIdentityStore()

		const identity = await store.create({
			userId: 'user-1',
			provider: 'google',
			providerUserId: 'google-1',
			email: 'alice@example.com',
		})

		await expect(store.findByProvider('google', 'google-1')).resolves.toEqual(identity)
		await expect(store.findByUser('user-1')).resolves.toEqual([identity])

		await store.delete('user-1', 'google')

		await expect(store.findByProvider('google', 'google-1')).resolves.toBeNull()
		await expect(store.findByUser('user-1')).resolves.toEqual([])
	})

	it('prevents duplicate provider identities and duplicate provider links per user', async () => {
		const store = new InMemoryLinkedIdentityStore()
		await store.create({
			userId: 'user-1',
			provider: 'github',
			providerUserId: 'github-1',
			email: null,
		})

		await expect(
			store.create({
				userId: 'user-2',
				provider: 'github',
				providerUserId: 'github-1',
				email: null,
			}),
		).rejects.toBeInstanceOf(DuplicateLinkedIdentityError)

		await expect(
			store.create({
				userId: 'user-1',
				provider: 'github',
				providerUserId: 'github-2',
				email: null,
			}),
		).rejects.toBeInstanceOf(DuplicateLinkedIdentityError)
	})
})
