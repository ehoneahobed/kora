import type { Operation, VersionVector } from '@korajs/core'
import { mergeVersionVectors } from '@korajs/store'
import type { Store } from '@korajs/store'
import { decodeDeltaCursor, encodeDeltaCursor, operationMatchesScope } from '@korajs/sync'
import type {
	AdoptionScheduleInfo,
	DeltaCursor,
	LocalNodeInfo,
	QuarantinedOperation,
	SyncScopeMap,
	SyncStatePersistence,
	TerminalRejectionRecord,
} from '@korajs/sync'

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

	loadDeliveryWatermark(signature: string): Promise<number> {
		return this.store.loadDeliveryWatermark(signature)
	}

	async saveDeliveryWatermark(signature: string, watermark: number): Promise<void> {
		await this.store.saveDeliveryWatermark(signature, watermark)
	}

	loadAllDeliveryWatermarks(): Promise<Record<string, number>> {
		return this.store.loadAllDeliveryWatermarks()
	}

	async deleteDeliveryWatermark(signature: string): Promise<void> {
		await this.store.deleteDeliveryWatermark(signature)
	}

	loadNodeToken(nodeId?: string): Promise<string | null> {
		return this.store.loadNodeToken(nodeId)
	}

	async saveNodeToken(token: string, nodeId?: string): Promise<void> {
		await this.store.saveNodeToken(token, nodeId)
	}

	loadAuthoritativeNodeIds(): Promise<string[] | null> {
		return this.store.loadAuthoritativeNodeIds()
	}

	async saveAuthoritativeNodeIds(nodeIds: string[]): Promise<void> {
		await this.store.saveAuthoritativeNodeIds(nodeIds)
	}

	loadOwnAckedThrough(nodeId: string): Promise<number | null> {
		return this.store.loadOwnAckedThrough(nodeId)
	}

	async saveOwnAckedThrough(nodeId: string, sequence: number): Promise<void> {
		await this.store.saveOwnAckedThrough(nodeId, sequence)
	}

	/** Quarantine rows and the watermark advance commit in one store transaction (W4). */
	async saveQuarantine(
		entries: QuarantinedOperation[],
		watermark?: { signature: string; watermark: number },
	): Promise<void> {
		await this.store.saveInboundQuarantine(entries, watermark)
	}

	loadQuarantine(): Promise<QuarantinedOperation[]> {
		return this.store.loadInboundQuarantine()
	}

	async removeQuarantine(operationIds: string[]): Promise<void> {
		await this.store.removeInboundQuarantine(operationIds)
	}

	loadAcceptedDownlinkScope(): Promise<SyncScopeMap | null> {
		return this.store.loadAcceptedDownlinkScope()
	}

	async saveAcceptedDownlinkScope(scope: SyncScopeMap | null): Promise<void> {
		await this.store.saveAcceptedDownlinkScope(scope)
	}

	/** Durable terminal-rejection markers (RT-36); the app cannot clear them. */
	async recordTerminalRejections(entries: TerminalRejectionRecord[]): Promise<void> {
		await this.store.recordTerminalRejections(entries)
	}

	findTerminalRejections(operationIds: string[]): Promise<Set<string>> {
		return this.store.findTerminalRejections(operationIds)
	}

	/** The node ids this database authored under (RT-38, RT-40). */
	async listLocalNodes(): Promise<LocalNodeInfo[]> {
		const nodes = await this.store.listLocalNodes()
		return nodes.map(
			({ nodeId, accepted, held, refusedCycle, principal, binding, refusedPrincipals }) => ({
				nodeId,
				accepted,
				held,
				refusedCycle,
				principal,
				binding,
				refusedPrincipals,
			}),
		)
	}

	/** An accepted handshake binds the node to the session's user (RT-50). */
	async confirmLocalNodePrincipal(nodeId: string, principal: string): Promise<void> {
		await this.store.confirmNodePrincipal(nodeId, principal)
	}

	/** The server refused the node for this user (RT-50). */
	async recordLocalNodeRefusedFor(nodeId: string, principal: string): Promise<void> {
		await this.store.recordNodeRefusedFor(nodeId, principal)
	}

	/** The app assigned a held node's writes to this user (RT-50). */
	assignLocalNodePrincipal(nodeId: string, principal: string): Promise<boolean> {
		return this.store.assignNodePrincipal(nodeId, principal)
	}

	/** Forget a local node whose held writes were discarded (RT-50). */
	async dropLocalNode(nodeId: string): Promise<void> {
		await this.store.dropLocalNode(nodeId)
	}

	/** Parked adoptions and the upload-progress counter (RT-46). */
	loadAdoptionSchedule(): Promise<AdoptionScheduleInfo> {
		return this.store.loadAdoptionSchedule()
	}

	async saveAdoptionSchedule(schedule: AdoptionScheduleInfo): Promise<void> {
		await this.store.saveAdoptionSchedule(schedule)
	}

	async markLocalNodeAccepted(nodeId: string): Promise<void> {
		await this.store.markLocalNodeAccepted(nodeId)
	}

	async markLocalNodeRefused(nodeId: string, held: boolean): Promise<void> {
		await this.store.markLocalNodeRefused(nodeId, held)
	}

	loadAcceptedCycle(): Promise<number> {
		return this.store.loadAcceptedCycle()
	}

	async forgetLocalNode(nodeId: string): Promise<void> {
		await this.store.forgetLocalNode(nodeId)
	}
}
