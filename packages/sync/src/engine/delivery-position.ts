/**
 * The delivery position of a sync engine: the watermark the live view has applied, the
 * watermark of every view seen (the per-view cache), and the access-rules key the device was
 * last scoped under (docs/design/first-visit-parity.md, S3 review round 6).
 *
 * Four review rounds found the same bug four times (a write of the position after an await
 * with no re-check that the position the batch was received at still exists), and the fifth
 * and sixth showed that policing spellings of that write in the engine's source is a game of
 * catch-up. So the position is not a set of engine fields at all: it lives in `#private` state
 * of this class, which no cast, bracket access, destructuring, `Reflect` or `Object.assign` of
 * the engine can reach. What can change it is a method call, and there are two surfaces:
 *
 *  - the owner methods (`moveTo`, `adoptRulesKey`, `recordView`, `forgetView`) are used by the
 *    code that owns a position that is not a batch's: start, view switches, a full resync,
 *    dropping a replica;
 *  - the `writer` is used by `SyncEngine.commitDeliveryProgress` only, which re-validates the
 *    batch's context synchronously before it advances anything.
 *
 * `delivery-progress-writers.test.ts` pins which engine members call which surface.
 */

/** What a delivery batch's single writer can change. */
export class PositionWriter {
	readonly #position: DeliveryPosition

	constructor(position: DeliveryPosition) {
		this.#position = position
	}

	/** The live view applied a batch (or a replica merged): its watermark. */
	advance(watermark: number): void {
		this.#position.moveTo(watermark)
	}

	/** The batch announced the rules the device is now scoped under. */
	adoptKey(key: string): void {
		this.#position.adoptRulesKey(key)
	}
}

/** The delivery position of one engine. See the module comment. */
export class DeliveryPosition {
	#watermark = 0
	#rulesKey: string | null = null
	readonly #views = new Map<string, number>()
	readonly #writer: PositionWriter

	constructor() {
		this.#writer = new PositionWriter(this)
	}

	/** The watermark of the live view. */
	get watermark(): number {
		return this.#watermark
	}

	/** The access-rules key the device was last scoped under, if any. */
	get rulesKey(): string | null {
		return this.#rulesKey
	}

	/** A copy of the per-view cache (the position is changed through methods, not through this). */
	get views(): ReadonlyMap<string, number> {
		return new Map(this.#views)
	}

	/** The cached watermark of a view. */
	viewWatermark(signature: string): number | undefined {
		return this.#views.get(signature)
	}

	/** Number of views in the cache. */
	get viewCount(): number {
		return this.#views.size
	}

	/** The views in least-recently-used order. */
	viewSignatures(): string[] {
		return [...this.#views.keys()]
	}

	/** Owner: the live watermark moves for a reason that is not a batch's. */
	moveTo(watermark: number): void {
		this.#watermark = watermark
	}

	/** Owner: the key loaded at start, or announced by a batch (through the writer). */
	adoptRulesKey(key: string | null): void {
		this.#rulesKey = key
	}

	/** Owner: a view's watermark becomes the most recently used entry of the cache. */
	recordView(signature: string, watermark: number): void {
		this.#views.delete(signature)
		this.#views.set(signature, watermark)
	}

	/** Owner: a view preloaded at start (no recency change). */
	preloadView(signature: string, watermark: number): void {
		this.#views.set(signature, watermark)
	}

	/** Owner: a cold view leaves the cache. */
	forgetView(signature: string): void {
		this.#views.delete(signature)
	}

	/** The capability of the batch writer: held by `commitDeliveryProgress` only. */
	get writer(): PositionWriter {
		return this.#writer
	}
}
