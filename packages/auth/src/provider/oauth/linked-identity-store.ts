import { randomUUID } from 'node:crypto'
import { KoraError } from '@korajs/core'
import type { LinkedIdentity } from './oauth-types'

export interface LinkedIdentityStore {
	findByProvider(provider: string, providerUserId: string): Promise<LinkedIdentity | null>
	findByUser(userId: string): Promise<LinkedIdentity[]>
	create(params: {
		userId: string
		provider: string
		providerUserId: string
		email: string | null
	}): Promise<LinkedIdentity>
	delete(userId: string, provider: string): Promise<void>
}

export class DuplicateLinkedIdentityError extends KoraError {
	constructor(provider: string) {
		super(`This ${provider} account is already linked.`, 'DUPLICATE_LINKED_IDENTITY', {
			provider,
		})
		this.name = 'DuplicateLinkedIdentityError'
	}
}

export class InMemoryLinkedIdentityStore implements LinkedIdentityStore {
	private readonly identitiesById = new Map<string, LinkedIdentity>()
	private readonly identityIdByProvider = new Map<string, string>()
	private readonly identityIdsByUser = new Map<string, Set<string>>()
	private readonly identityIdByUserProvider = new Map<string, string>()

	async findByProvider(provider: string, providerUserId: string): Promise<LinkedIdentity | null> {
		const id = this.identityIdByProvider.get(providerIdentityKey(provider, providerUserId))
		return id ? (this.identitiesById.get(id) ?? null) : null
	}

	async findByUser(userId: string): Promise<LinkedIdentity[]> {
		const ids = this.identityIdsByUser.get(userId)
		if (!ids) return []
		return [...ids]
			.map((id) => this.identitiesById.get(id))
			.filter((identity): identity is LinkedIdentity => identity !== undefined)
	}

	async create(params: {
		userId: string
		provider: string
		providerUserId: string
		email: string | null
	}): Promise<LinkedIdentity> {
		const providerKey = providerIdentityKey(params.provider, params.providerUserId)
		const userProviderKeyValue = userProviderKey(params.userId, params.provider)
		if (
			this.identityIdByProvider.has(providerKey) ||
			this.identityIdByUserProvider.has(userProviderKeyValue)
		) {
			throw new DuplicateLinkedIdentityError(params.provider)
		}

		const identity: LinkedIdentity = {
			id: randomUUID(),
			userId: params.userId,
			provider: params.provider,
			providerUserId: params.providerUserId,
			email: params.email,
			linkedAt: Date.now(),
		}

		this.identitiesById.set(identity.id, identity)
		this.identityIdByProvider.set(providerKey, identity.id)
		this.identityIdByUserProvider.set(userProviderKeyValue, identity.id)

		const userIdentities = this.identityIdsByUser.get(params.userId) ?? new Set<string>()
		userIdentities.add(identity.id)
		this.identityIdsByUser.set(params.userId, userIdentities)

		return identity
	}

	async delete(userId: string, provider: string): Promise<void> {
		const userProviderKeyValue = userProviderKey(userId, provider)
		const id = this.identityIdByUserProvider.get(userProviderKeyValue)
		if (!id) return

		const identity = this.identitiesById.get(id)
		this.identitiesById.delete(id)
		this.identityIdByUserProvider.delete(userProviderKeyValue)
		if (identity) {
			this.identityIdByProvider.delete(
				providerIdentityKey(identity.provider, identity.providerUserId),
			)
		}

		const userIdentities = this.identityIdsByUser.get(userId)
		userIdentities?.delete(id)
		if (userIdentities?.size === 0) {
			this.identityIdsByUser.delete(userId)
		}
	}
}

function providerIdentityKey(provider: string, providerUserId: string): string {
	return `${provider}:${providerUserId}`
}

function userProviderKey(userId: string, provider: string): string {
	return `${userId}:${provider}`
}
