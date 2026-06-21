import type { Operation, VersionVector } from '@korajs/core'
import { mergeVersionVectors } from '@korajs/store'
import type { Store } from '@korajs/store'
import { decodeDeltaCursor, encodeDeltaCursor, operationMatchesScope } from '@korajs/sync'
import type { DeltaCursor, SyncScopeMap, SyncStatePersistence } from '@korajs/sync'

/**
 * Persists and queries sync acknowledgment state via the local Store.
 */
export class StoreSyncStatePersistence implements SyncStatePersistence {
	constructor(
		private readonly store: Store,
		private readonly scope?: SyncScopeMap,
	) {}

	loadLastAckedServerVector(): Promise<VersionVector> {
		return this.store.loadLastAckedServerVector()
	}

	saveLastAckedServerVector(vector: VersionVector): Promise<void> {
		return this.store.saveLastAckedServerVector(vector)
	}

	mergeServerVectors(a: VersionVector, b: VersionVector): VersionVector {
		return this.store.mergeServerVectors(a, b)
	}

	async countUnsyncedOperations(serverVector: VersionVector): Promise<number> {
		const ops = await this.getUnsyncedOperations(serverVector)
		return ops.length
	}

	async getUnsyncedOperations(serverVector: VersionVector): Promise<Operation[]> {
		const ops = await this.store.getUnsyncedOperations(serverVector)
		return ops.filter((op) => operationMatchesScope(op, this.scope))
	}

	loadDeltaCursor(): Promise<DeltaCursor | null> {
		return this.store.loadDeltaCursor().then((encoded) => decodeDeltaCursor(encoded))
	}

	async saveDeltaCursor(cursor: DeltaCursor | null): Promise<void> {
		await this.store.saveDeltaCursor(cursor ? encodeDeltaCursor(cursor) : null)
	}
}
