/**
 * First-visit parity S3, review round 6: a dropper at every await of a delivery batch.
 *
 * Four review rounds each found one more await at which something that moves the delivery
 * position (a scope change, a query subset, a stop, a reconnect, a closed transport, a sign-in
 * of another user, a full resync) could land between a batch's check and its write. A hand
 * written test per hole is the wrong tool for that class, so this suite counts the awaits.
 *
 * A `Hopper` wraps every async call of the engine, its sync state, the live store's delivery
 * batch, the scratch replica and the holding emitter. Hop N of a scenario fires one dropper
 * (`micro`: one microtask later; `macro`: one macrotask later), then the scenario finishes and
 * the invariants of the position are read (docs/design/first-visit-parity.md, round 6):
 *
 *  I1  no persisted watermark is beyond the committed prefix of the data
 *  I2  the next handshake asks for the recorded position, and not beyond the prefix
 *  I3  no acknowledgment is beyond the prefix (unless a live replica holds the data)
 *  I4  redelivery from the asked position yields every row and no duplicate log row
 *  I5  no view-cache entry is beyond the prefix
 *  I6  no held events without a replica; events only for operations in the log
 *  I7  after a full resync the next handshake asks for 0
 *  I8  no access narrowing or scope retraction is applied once the position moved
 *  I9  a narrowing or retraction of a dropped batch does not hide data for good
 *  I10 a local write made mid-stream survives
 *  I12 rows of the previous user are not committed after the user changed
 *  I13 no acknowledgment is sent after the position was dropped
 *  I14 the in-memory watermark equals the active view's cache entry
 *  I15 the state after redelivery equals the direct path's
 *
 * Default run: the hops around every commit point (anchors, plus or minus 3) for every scenario
 * and dropper in both modes. `KORA_HOPS_FULL=1` sweeps every hop (a few minutes);
 * `KORA_HOPS_STRIDE=n` every nth hop; `KORA_HOPS_SCEN`, `KORA_HOPS_DROP`, `KORA_HOPS_MODES`
 * (comma lists) narrow the sweep, and `KORA_HOPS_ONE=scenario,dropper,hop,mode` reproduces
 * one cell.
 */
import type { SimpleEventEmitter } from '@korajs/core/internal'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import {
	stream,
	type Device,
	type DeviceOptions,
	type DeviceState,
	batch,
	deliver,
	device,
	devices,
	numberedOps,
	settle,
	state,
} from './staged-replication-fixtures'

type Fn = (...args: unknown[]) => unknown
type Loose = Record<string, unknown>

/** The engine parts the injector reads and wraps (white-box, like the other staged suites). */
interface HopEngine {
	state: string
	staging: unknown
	deliveryWatermark: number
	deliverySignatureWatermarks: Map<string, number>
	holdingEmitter: { heldCount: number } & Loose
	syncState: Loose
	store: Loose
	transport: { send(message: SyncMessage): unknown }
	deliverySignature(): string
	resetDeliveryForFullResync(): Promise<void>
}

function engineOf(target: Device): HopEngine {
	return target.engine as unknown as HopEngine
}

const sleepMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Calls the engine makes in the same turn as the position check in front of them. */
const SAME_TURN_AS_CHECK = new Set([
	'store.applyCollectionNarrowing:call',
	'engine.ensureOfflineUnit:call',
	'engine.applyDeliveredRetraction:call',
])

class Hopper {
	count = 0
	target = -1
	fired = false
	firedLabel = ''
	fireIndex = -1
	armed = true
	mode: 'micro' | 'macro' = 'micro'
	labels: string[] = []
	onFire: () => void = () => undefined
	localAt = -1
	onLocal: () => void = () => undefined
	firstApply = -1

	async hop(label: string): Promise<void> {
		this.count++
		if (
			this.firstApply < 0 &&
			(label === 'liveStore.applyDeliveryBatch:call' ||
				label === 'replica.merge:call' ||
				label === 'store.applyCollectionNarrowing:call')
		) {
			this.firstApply = this.count
		}
		if (this.count === this.localAt) this.onLocal()
		if (this.labels.length < 6000) this.labels.push(label)
		if (this.armed && !this.fired && this.count === this.target) {
			// The wrapper's own await sits between the engine's synchronous check and the call it
			// guards; the engine has no such await, so the dropper lands one hop later.
			if (SAME_TURN_AS_CHECK.has(label)) {
				this.target++
				return
			}
			this.fired = true
			this.fireIndex = this.count
			this.firedLabel = label
			this.onFire()
			if (this.mode === 'macro') await sleepMacrotask()
			else await Promise.resolve()
		}
	}
}

/** Wraps the async methods `names` of `owner` so a hop precedes and follows each call. */
function wrapNamed(owner: Loose, names: string[], hopper: Hopper, prefix: string): void {
	for (const name of names) {
		const original = owner[name]
		if (typeof original !== 'function') continue
		const bound = (original as Fn).bind(owner)
		owner[name] = async (...args: unknown[]): Promise<unknown> => {
			await hopper.hop(`${prefix}${name}:call`)
			const result = await bound(...args)
			await hopper.hop(`${prefix}${name}:ret`)
			return result
		}
	}
}

function asyncMethodNames(object: object): string[] {
	const names = new Set<string>()
	for (let proto: object | null = object; proto && proto !== Object.prototype; ) {
		for (const key of Object.getOwnPropertyNames(proto)) {
			if (key === 'constructor') continue
			const descriptor = Object.getOwnPropertyDescriptor(proto, key)
			const value: unknown = descriptor?.value
			if (typeof value === 'function' && value.constructor.name === 'AsyncFunction') names.add(key)
		}
		proto = Object.getPrototypeOf(proto) as object | null
	}
	return [...names]
}

const ENGINE_METHODS = [
	'prepareInboundBatch',
	'applyBatchIntoStaging',
	'beginStaging',
	'mergeStagedPrefix',
	'mergeStaging',
	'mergeAndSettle',
	'replayQuarantineAfterMerge',
	'replicaTooLarge',
	'applyBatchInOneTransaction',
	'applyBatchPerOperation',
	'applyInbound',
	'ensureOfflineUnit',
	'clearOfflineMarks',
	'commitDeliveryProgress',
	'recordReceivedBatch',
	'refreshPendingCount',
	'settleAfterCatchUp',
	'applyDeliveredRetraction',
	'persistDeliveryWatermark',
]

const BATCH_METHODS = [
	'prefetch',
	'applyRemoteOperation',
	'applyScopeRetraction',
	'saveQuarantine',
	'saveDeliveryWatermark',
]

/** Wraps the methods of a store's delivery batch with hops, and adds one before its commit. */
function hopBatch(batchObject: Loose, hopper: Hopper, prefix: string, names: string[]): Loose {
	const wrapped: Loose = { ...batchObject }
	for (const name of names) {
		const original = batchObject[name]
		if (typeof original !== 'function') continue
		wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
			await hopper.hop(`${prefix}.${name}:call`)
			const value = await (original as Fn).apply(batchObject, args)
			await hopper.hop(`${prefix}.${name}:ret`)
			return value
		}
	}
	return wrapped
}

/** What the injector saw the engine do after the dropper fired. */
interface Observed {
	/** Whether the dropper's effect is in place (a sign-in of another user takes awaits to land). */
	effective: () => boolean
	/** A narrowing or retraction ran before the dropper took effect (it is true of the old view and stays). */
	hideRan: boolean
	/** Narrowings or retractions applied after the dropper fired (I8). */
	staleNarrowing: string[]
	/** Acknowledgments sent, with whether a live replica held the data and whether after the drop. */
	acks: Array<{ sequence: number; staged: boolean; afterDrop: boolean }>
}

function instrument(target: Device, hopper: Hopper, observed: Observed): void {
	const engine = engineOf(target)
	const e = engine as unknown as Loose
	wrapNamed(e, ENGINE_METHODS, hopper, 'engine.')
	{
		const inner = e.applyDeliveredRetraction as Fn
		e.applyDeliveredRetraction = (...args: unknown[]): unknown => {
			if (hopper.armed && hopper.fired && observed.effective()) {
				observed.staleNarrowing.push(`RETRACTION after ${hopper.firedLabel}`)
			} else {
				observed.hideRan = true
			}
			return inner(...args)
		}
	}
	const syncState = engine.syncState
	wrapNamed(
		syncState,
		asyncMethodNames(syncState).filter((name) =>
			/^(save|load|delete|remove|open|clear)/.test(name),
		),
		hopper,
		'syncState.',
	)
	const store = engine.store
	const applyDeliveryBatch = (store.applyDeliveryBatch as Fn).bind(store)
	store.applyDeliveryBatch = async (fn: (b: Loose) => Promise<unknown>): Promise<unknown> => {
		await hopper.hop('liveStore.applyDeliveryBatch:call')
		const result = await applyDeliveryBatch(async (b: Loose) => {
			const value = await fn(hopBatch(b, hopper, 'liveBatch', BATCH_METHODS))
			await hopper.hop('liveBatch:pre-commit')
			return value
		})
		await hopper.hop('liveStore.applyDeliveryBatch:ret')
		return result
	}
	const narrowing = store.applyCollectionNarrowing
	if (typeof narrowing === 'function') {
		const bound = (narrowing as Fn).bind(store)
		store.applyCollectionNarrowing = async (...args: unknown[]): Promise<unknown> => {
			if (hopper.armed && hopper.fired && observed.effective()) {
				observed.staleNarrowing.push(hopper.firedLabel)
			} else {
				observed.hideRan = true
			}
			await hopper.hop('store.applyCollectionNarrowing:call')
			const value = await bound(...args)
			await hopper.hop('store.applyCollectionNarrowing:ret')
			return value
		}
	}
	const begin = store.beginBulkReplication
	if (typeof begin === 'function') {
		const bound = (begin as Fn).bind(store)
		store.beginBulkReplication = async (...args: unknown[]): Promise<Loose | null> => {
			await hopper.hop('store.beginBulkReplication:call')
			const replica = (await bound(...args)) as Loose | null
			if (replica === null) return null
			const inner = replica.store as Loose
			const replicaStore: Loose = Object.create(inner) as Loose
			const innerApply = (inner.applyDeliveryBatch as Fn).bind(inner)
			replicaStore.applyDeliveryBatch = async (
				fn: (b: Loose) => Promise<unknown>,
			): Promise<unknown> => {
				await hopper.hop('replicaStore.applyDeliveryBatch:call')
				const result = await innerApply(async (b: Loose) => {
					const value = await fn(
						hopBatch(
							b,
							hopper,
							'replicaBatch',
							BATCH_METHODS.filter((n) => n !== 'applyScopeRetraction'),
						),
					)
					await hopper.hop('replicaBatch:pre-commit')
					return value
				})
				await hopper.hop('replicaStore.applyDeliveryBatch:ret')
				return result
			}
			const replicaSync = replica.syncState as Loose
			wrapNamed(
				replicaSync,
				asyncMethodNames(replicaSync).filter((name) => /^(save|load|delete|remove)/.test(name)),
				hopper,
				'replicaSync.',
			)
			const merge = replica.merge as Fn
			const sizeBytes = replica.sizeBytes as Fn | undefined
			await hopper.hop('store.beginBulkReplication:ret')
			return {
				...replica,
				store: replicaStore,
				merge: async (...a: unknown[]): Promise<unknown> => {
					await hopper.hop('replica.merge:call')
					const value = await merge(...a)
					await hopper.hop('replica.merge:ret')
					return value
				},
				...(sizeBytes
					? {
							sizeBytes: async (): Promise<unknown> => {
								await hopper.hop('replica.sizeBytes:call')
								return sizeBytes()
							},
						}
					: {}),
			}
		}
	}
	const holding = engine.holdingEmitter
	if (holding) wrapNamed(holding, ['release'], hopper, 'holding.')
	// Handshakes and acknowledgments are read where they leave the engine.
	const transport = engine.transport
	const realSend = transport.send.bind(transport)
	transport.send = (message: SyncMessage): unknown => {
		const sequence = (message as unknown as { deliverySequence?: number }).deliverySequence
		if (message.type === 'acknowledgment' && sequence !== undefined) {
			observed.acks.push({
				sequence,
				staged: engine.staging !== null,
				afterDrop: hopper.armed && hopper.fired,
			})
		}
		return realSend(message)
	}
}

type Dropper =
	| 'updateScope'
	| 'registerSubset'
	| 'unsubscribe'
	| 'stop'
	| 'reconnect'
	| 'transportClose'
	| 'principal'
	| 'fullResync'
const ALL_DROPPERS: Dropper[] = [
	'updateScope',
	'registerSubset',
	'unsubscribe',
	'stop',
	'reconnect',
	'transportClose',
	'principal',
	'fullResync',
]

const FIXTURE = stream(numberedOps(90, { prefix: 'm' }), 30).map((message, index) =>
	index === 2 ? { ...message, accessRulesKey: 'K1' } : message,
)
const BIG = numberedOps(1100, { prefix: 'm' })
const BIG_FIXTURE = [batch('B0', 0, BIG.slice(0, 600)), batch('B1', 600, BIG.slice(600), true)]
const LAST = FIXTURE[2] as OperationBatchMessage
const NARROW: OperationBatchMessage = {
	...LAST,
	accessNarrowing: { lessons: { school: 's' } },
	isFinal: true,
}
const NARROW_HIDE: OperationBatchMessage = {
	...LAST,
	accessNarrowing: { lessons: { school: 'nomatch' } },
	isFinal: true,
}
/** The last batch with two retractions (of m000 before its operations, of m001 after). */
const NARROW_RETRACT: OperationBatchMessage = (() => {
	const base = LAST.baseDeliverySequence ?? 0
	return {
		...LAST,
		accessNarrowing: { lessons: { school: 's' } },
		isFinal: true,
		maxDeliverySequence: (LAST.maxDeliverySequence ?? 0) + 2,
		retractions: [
			{ collection: 'lessons', recordId: 'm000', afterOperations: 0, deliverySequence: base + 1 },
			{
				collection: 'lessons',
				recordId: 'm001',
				afterOperations: LAST.operations.length,
				deliverySequence: base + LAST.operations.length + 2,
			},
		],
	}
})()

interface Scenario {
	staged: boolean
	fixture: OperationBatchMessage[]
	/** Indexes of the fixture delivered before the injected batch. */
	before: number[]
	index: number
	total: number
	bulk?: DeviceOptions['bulk']
	message?: OperationBatchMessage
	/** Delivery sequences beyond the operations (a retraction takes one): the position at `total` rows. */
	extraSequences?: number
}

const SCENARIOS: Record<string, Scenario> = {
	stagedFinal: { staged: true, fixture: FIXTURE, before: [0, 1], index: 2, total: 90 },
	stagedMid: { staged: true, fixture: FIXTURE, before: [0], index: 1, total: 90 },
	tooLarge: {
		staged: true,
		fixture: FIXTURE,
		before: [0],
		index: 1,
		total: 90,
		bulk: { minOperations: 0, maxOperations: 45 },
	},
	stagedNarrow: {
		staged: true,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW,
	},
	directMid: { staged: false, fixture: FIXTURE, before: [0], index: 1, total: 90 },
	directFinal: { staged: false, fixture: FIXTURE, before: [0, 1], index: 2, total: 90 },
	directMulti: { staged: false, fixture: BIG_FIXTURE, before: [], index: 0, total: 1100 },
	directMulti2: { staged: false, fixture: BIG_FIXTURE, before: [0], index: 1, total: 1100 },
	staleNarrowDirect: {
		staged: false,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW_HIDE,
	},
	staleNarrowStaged: {
		staged: true,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW_HIDE,
	},
	staleRetractDirect: {
		staged: false,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW_RETRACT,
		extraSequences: 2,
	},
	staleRetractStaged: {
		staged: true,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW_RETRACT,
		extraSequences: 2,
	},
	perOpNarrow: {
		staged: false,
		fixture: FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		message: NARROW,
	},
	stagedMulti: { staged: true, fixture: BIG_FIXTURE, before: [0], index: 1, total: 1100 },
}

function idOf(index: number): string {
	return `m${String(index).padStart(3, '0')}`
}

/** The contiguous prefix m000.. of the stream that is in the live database. */
async function committedPrefix(target: Device, total: number): Promise<number> {
	const rows = await target.adapter.query<{ id: string }>('SELECT id FROM lessons')
	const ids = new Set(rows.map((row) => row.id))
	let prefix = 0
	while (prefix < total && ids.has(idOf(prefix))) prefix++
	return prefix
}

interface CellResult {
	problems: string[]
	hops: number
	label: string
	labels: string[]
}

const references = new Map<string, DeviceState>()

/** One cell: `scenario`, `dropper` fired at hop `targetHop` in `mode`; `null` is the baseline. */
async function runCell(
	scenarioName: string,
	dropper: Dropper | null,
	targetHop: number,
	mode: 'micro' | 'macro',
	extra: { localAt?: number } = {},
): Promise<CellResult> {
	const scenario = SCENARIOS[scenarioName] as Scenario
	const user = { id: 'user-a' }
	const options: DeviceOptions = { principal: async () => user.id }
	if (scenario.bulk !== undefined) options.bulk = scenario.bulk
	const target = await device(scenario.staged, undefined, false, options)
	const engine = engineOf(target)
	const problems: string[] = []
	let unsubscribe: (() => void) | null = null
	if (dropper === 'unsubscribe') {
		unsubscribe = target.engine.registerQuerySubset({
			collection: 'lessons',
			where: { school: 's' },
		})
		await settle(target)
	}
	const streamSignature = engine.deliverySignature()
	const appliedIds = new Set<string>()
	const applied = target.emitter as SimpleEventEmitter
	applied.on('operation:applied', (event) => {
		appliedIds.add(event.operation.id)
	})
	for (const index of scenario.before) {
		await deliver(target, scenario.fixture[index] as OperationBatchMessage)
	}
	const hopper = new Hopper()
	hopper.target = targetHop
	hopper.mode = mode
	let dropped: Promise<unknown> = Promise.resolve()
	hopper.onFire = (): void => {
		if (dropper === null) return
		dropped = (async (): Promise<void> => {
			switch (dropper) {
				case 'updateScope':
					target.engine.updateScope({ lessons: { school: 't' } })
					break
				case 'registerSubset':
					target.engine.registerQuerySubset({ collection: 'lessons', where: { school: 'x' } })
					break
				case 'unsubscribe':
					unsubscribe?.()
					break
				case 'stop':
					await target.engine.stop()
					break
				case 'reconnect':
					await target.engine.reconnect()
					break
				case 'transportClose':
					;(
						engine.transport as unknown as { simulateDisconnect(reason: string): void }
					).simulateDisconnect('injected')
					break
				case 'principal':
					user.id = 'user-b'
					await target.engine.bindSignedInUser()
					break
				case 'fullResync':
					await engine.resetDeliveryForFullResync()
					break
			}
		})().catch(() => undefined)
	}
	const observed: Observed = {
		effective: () =>
			dropper === 'principal'
				? (engine as unknown as { principal?: string | null }).principal === 'user-b'
				: true,
		hideRan: false,
		staleNarrowing: [],
		acks: [],
	}
	instrument(target, hopper, observed)
	const message = scenario.message ?? (scenario.fixture[scenario.index] as OperationBatchMessage)
	let localId: string | null = null
	let localPromise: Promise<unknown> = Promise.resolve()
	if (extra.localAt !== undefined) {
		hopper.localAt = extra.localAt
		hopper.onLocal = (): void => {
			localPromise = (
				target.store
					.collection('lessons')
					.insert({ title: 'local-mid-stream', school: 's' }) as Promise<{
					id: string
				}>
			)
				.then((row) => {
					localId = row.id
				})
				.catch((error: unknown) => {
					problems.push(`local write threw ${String(error).slice(0, 80)}`)
				})
		}
	}
	let finished = false
	const delivering = deliver(target, message)
		.catch((error: unknown) => {
			problems.push(`deliver threw: ${String(error).slice(0, 120)}`)
		})
		.then(() => {
			finished = true
		})
	// A deadlock fails the cell; it is not a timing assertion of a passing run.
	const guard = new Promise<void>((resolve) => {
		setTimeout(() => {
			if (!finished) problems.push('deliver timed out')
			resolve()
		}, 15_000)
	})
	await Promise.race([delivering, guard])
	await localPromise
	const hops = hopper.count
	if (observed.staleNarrowing.length > 0) {
		problems.push(
			`I8 stale access-narrowing applied after the dropper fired at ${observed.staleNarrowing[0]}`,
		)
	}
	hopper.armed = false
	await dropped
	await settle(target)
	await settle(target)
	const revive = async (): Promise<void> => {
		if (engine.state === 'disconnected' || engine.state === 'error') {
			await target.engine.start().catch(() => undefined)
			await settle(target)
			await settle(target)
		}
	}
	await revive()

	// ---- invariants before any redelivery
	const rows = await committedPrefix(target, scenario.total)
	// The position that data is at: a retraction rides on a delivery sequence of its own.
	const spare = scenario.extraSequences ?? 0
	const prefix = rows >= scenario.total ? rows + spare : rows + (spare > 0 && rows > 60 ? 1 : 0)
	const signatureNow = engine.deliverySignature()
	const signatures = new Set<string>([
		streamSignature,
		signatureNow,
		...engine.deliverySignatureWatermarks.keys(),
	])
	for (const signature of signatures) {
		const persisted = await target.store.loadDeliveryWatermark(signature)
		if (persisted > prefix) {
			problems.push(
				`I1 persisted watermark ${persisted} of ${JSON.stringify(signature).slice(0, 24)} > committed prefix ${prefix}`,
			)
		}
	}
	for (const [signature, watermark] of engine.deliverySignatureWatermarks) {
		if (watermark > prefix) {
			problems.push(
				`I5 cache ${watermark} of ${JSON.stringify(signature).slice(0, 24)} > prefix ${prefix}`,
			)
		}
	}
	const positionDropping =
		dropper === 'updateScope' ||
		dropper === 'registerSubset' ||
		dropper === 'unsubscribe' ||
		dropper === 'transportClose'
	for (const ack of observed.acks) {
		if (positionDropping && ack.afterDrop) {
			problems.push(
				`I13 ack ${ack.sequence} sent after the position was dropped (${hopper.firedLabel})`,
			)
		}
		if (ack.sequence > prefix && !ack.staged) {
			problems.push(`I3 ack ${ack.sequence} > prefix ${prefix} (no live replica)`)
		}
	}
	if ((engine.holdingEmitter?.heldCount ?? 0) > 0 && engine.staging === null) {
		problems.push('I6 held events with no replica')
	}
	if (
		engine.staging === null &&
		engine.state !== 'disconnected' &&
		engine.state !== 'error' &&
		(dropper === 'updateScope' || dropper === 'registerSubset' || dropper === 'unsubscribe')
	) {
		const cached = engine.deliverySignatureWatermarks.get(engine.deliverySignature()) ?? 0
		if (engine.deliveryWatermark !== cached) {
			problems.push(
				`I14 in-memory watermark ${engine.deliveryWatermark} != the active view's cache entry ${cached}`,
			)
		}
	}
	const logIds = new Set((await state(target)).logLessons)
	for (const id of appliedIds) {
		if (!logIds.has(id)) problems.push(`I6 event published for op ${id} not in log`)
	}

	// ---- the next handshake
	target.handshakes.length = 0
	await target.engine.reconnect().catch(() => undefined)
	await settle(target)
	await revive()
	const asked = target.handshakes[target.handshakes.length - 1]
	const recorded = await target.store.loadDeliveryWatermark(engine.deliverySignature())
	if (dropper === 'fullResync' && asked !== undefined && asked !== 0) {
		problems.push(`I7 full resync lost: handshake asks ${asked}, not 0`)
	}
	if (asked !== undefined && asked > prefix) {
		problems.push(`I2 handshake asks ${asked} > prefix ${prefix}`)
	}
	if (asked !== undefined && asked !== recorded && engine.staging === null) {
		problems.push(`I2 handshake asks ${asked} != recorded ${recorded}`)
	}

	// ---- redelivery from the asked position
	const from = asked ?? 0
	if (dropper === 'principal') {
		const base = message.baseDeliverySequence ?? 0
		const rows = (await target.adapter.query<{ id: string }>('SELECT id FROM lessons')).filter(
			(row) => Number(row.id.slice(1)) >= base,
		).length
		if (
			rows > 0 &&
			hopper.firstApply > 0 &&
			hopper.fireIndex > 0 &&
			hopper.fireIndex < hopper.firstApply
		) {
			problems.push(
				`I12 batch of the previous user committed ${rows} rows after the user changed (user switched at hop ${hopper.fireIndex}, apply began at hop ${hopper.firstApply})`,
			)
		}
		return { problems, hops, label: hopper.firedLabel, labels: hopper.labels }
	}
	for (const fixtureMessage of scenario.fixture) {
		if ((fixtureMessage.baseDeliverySequence ?? 0) >= from) {
			await deliver(target, fixtureMessage).catch((error: unknown) => {
				problems.push(`redeliver threw ${String(error).slice(0, 80)}`)
			})
		}
	}
	const staleNarrowing = observed.staleNarrowing.length > 0
	if (scenario.message !== undefined && !staleNarrowing) {
		await deliver(target, scenario.message).catch(() => undefined)
	}
	await settle(target)
	await settle(target)
	await revive()
	const after = await state(target)
	if (extra.localAt !== undefined && hopper.count >= extra.localAt) {
		const rows = await target.adapter.query<{ id: string; _deleted: number }>(
			'SELECT id, _deleted FROM lessons WHERE title = ?',
			['local-mid-stream'],
		)
		const logged =
			localId === null
				? []
				: await target.adapter.query('SELECT id FROM _kora_ops_lessons WHERE record_id = ?', [
						localId,
					])
		if (rows.length !== 1 || rows[0]?._deleted !== 0) {
			problems.push(`I10 local write lost: rows=${JSON.stringify(rows)}`)
		}
		if (localId !== null && logged.length < 1) problems.push('I10 local write has no log row')
	}
	if (staleNarrowing) {
		const visible = (
			await target.adapter.query<{ c: number }>(
				'SELECT count(*) AS c FROM lessons WHERE _deleted = 0',
			)
		)[0]?.c
		if (visible !== scenario.total) {
			problems.push(
				`I9 stale narrowing/retraction hid data for good: ${visible}/${scenario.total} visible after redelivery from ${from}`,
			)
		}
	}
	// A local write made mid-stream is one more row (I10 checks that it is there).
	const wanted = scenario.total + (extra.localAt !== undefined && localId !== null ? 1 : 0)
	// What a narrowing or retraction legitimately hid for the old view is not redelivered as new.
	if (after.lessons.length !== wanted && !observed.hideRan) {
		problems.push(`I4 after redelivery from ${from}: ${after.lessons.length}/${wanted} rows`)
	}
	if (new Set(after.logLessons).size !== after.logLessons.length) {
		problems.push('I4 duplicate log rows')
	}
	if (!staleNarrowing && scenario.message === undefined && extra.localAt === undefined) {
		let reference = references.get(scenarioName)
		if (reference === undefined) {
			const direct = await device(false)
			for (const fixtureMessage of scenario.fixture) await deliver(direct, fixtureMessage)
			reference = await state(direct)
			references.set(scenarioName, reference)
		}
		for (const field of [
			'lessons',
			'logLessons',
			'foldStates',
			'foldBase',
			'quarantine',
			'versionVector',
			'provisional',
		] as const) {
			if (JSON.stringify(after[field]) !== JSON.stringify(reference[field])) {
				problems.push(`I15 ${field} differs from the direct-path reference`)
			}
		}
	}
	return { problems, hops, label: hopper.firedLabel, labels: hopper.labels }
}

async function closeDevices(): Promise<void> {
	for (const created of devices.splice(0)) await created.close().catch(() => undefined)
}

function list(name: string, fallback: string[]): string[] {
	const value = process.env[name]
	return value ? value.split(',') : fallback
}

const FULL = process.env.KORA_HOPS_FULL === '1'
const STRIDE = Number(process.env.KORA_HOPS_STRIDE ?? '1')
const SELECTED = list('KORA_HOPS_SCEN', Object.keys(SCENARIOS))
const DROPPERS = list('KORA_HOPS_DROP', ALL_DROPPERS) as Dropper[]
const MODES = list('KORA_HOPS_MODES', ['micro', 'macro']) as Array<'micro' | 'macro'>
/** Labels whose neighbours are the commit points of the position. */
const ANCHOR =
	/pre-commit|applyDeliveryBatch:(call|ret)|merge:(call|ret)|commitDeliveryProgress|syncState\.save|applyCollectionNarrowing|applyScopeRetraction/

function hopsToTry(baseline: CellResult): number[] {
	const hops = new Set<number>()
	if (FULL) {
		for (let hop = 1; hop <= baseline.hops; hop++) hops.add(hop)
	} else {
		// A stride covers the stream's long stretches of identical hops; the anchors, the hops
		// around every commit point, are always tried.
		if (process.env.KORA_HOPS_STRIDE !== undefined) {
			for (let hop = 1; hop <= baseline.hops; hop += STRIDE) hops.add(hop)
		}
		baseline.labels.forEach((label, index) => {
			if (!ANCHOR.test(label) || label.startsWith('engine.applyInbound')) return
			for (let near = -3; near <= 3; near++) hops.add(index + 1 + near)
		})
	}
	return [...hops].filter((hop) => hop >= 1 && hop <= baseline.hops).sort((a, b) => a - b)
}

describe('the delivery position survives every dropper at every await (hop-level fault injection)', () => {
	for (const scenarioName of SELECTED) {
		test(`${scenarioName}: the undisturbed run is clean`, async () => {
			const baseline = await runCell(scenarioName, null, -1, 'micro')
			expect(baseline.problems).toEqual([])
			expect(baseline.hops).toBeGreaterThan(10)
		}, 60_000)
		for (const dropper of DROPPERS) {
			for (const mode of MODES) {
				test(`${scenarioName}: ${dropper} (${mode}) at every commit point`, async () => {
					const baseline = await runCell(scenarioName, null, -1, 'micro')
					const failures: string[] = []
					for (const hop of hopsToTry(baseline)) {
						let result: CellResult
						try {
							result = await runCell(scenarioName, dropper, hop, mode)
						} catch (error) {
							result = {
								problems: [`THROW ${String(error).slice(0, 150)}`],
								hops: 0,
								label: '?',
								labels: [],
							}
						}
						for (const problem of result.problems) {
							failures.push(`hop ${hop} (${result.label}): ${problem}`)
						}
						await closeDevices()
					}
					expect(failures).toEqual([])
				}, 3_000_000)
			}
		}
	}
	test('a dropper made on every hop leaves a local write mid-stream intact (I10)', async () => {
		const baseline = await runCell('stagedFinal', null, -1, 'micro')
		const failures: string[] = []
		for (let at = 1; at <= baseline.hops; at += 6) {
			for (const dropper of [
				null,
				'reconnect',
				'updateScope',
				'stop',
				'unsubscribe',
			] as Array<Dropper | null>) {
				const result = await runCell(
					'stagedFinal',
					dropper,
					dropper === null ? -1 : at + 1,
					'micro',
					{
						localAt: at,
					},
				)
				for (const problem of result.problems)
					failures.push(`${dropper} local at ${at}: ${problem}`)
				await closeDevices()
			}
		}
		expect(failures).toEqual([])
	}, 3_000_000)
})

if (process.env.KORA_HOPS_ONE) {
	test('one cell (KORA_HOPS_ONE=scenario,dropper,hop,mode)', async () => {
		const [scenarioName, dropper, hop, mode] = process.env.KORA_HOPS_ONE?.split(',') ?? []
		const result = await runCell(
			scenarioName as string,
			dropper === 'null' ? null : (dropper as Dropper),
			Number(hop),
			mode as 'micro' | 'macro',
		)
		console.log(
			'ONE',
			JSON.stringify({ label: result.label, problems: result.problems, hops: result.hops }),
		)
		expect(result.problems).toEqual([])
	}, 60_000)
}
