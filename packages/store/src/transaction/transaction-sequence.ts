import { readSequenceNumber } from '../store/sequence-allocator'
import type { StorageAdapter } from '../types'

/**
 * Allocates monotonic sequence numbers for a single open transaction.
 * Loads the current DB watermark once, then increments in memory until commit.
 */
export class TransactionSequenceAllocator {
	private loaded = false
	private watermark = 0

	constructor(
		private readonly adapter: StorageAdapter,
		private readonly nodeId: string,
	) {}

	async allocate(): Promise<number> {
		if (!this.loaded) {
			this.watermark = await readSequenceNumber(this.adapter, this.nodeId)
			this.loaded = true
		}
		this.watermark++
		return this.watermark
	}

	getHighWaterMark(): number {
		return this.watermark
	}
}
