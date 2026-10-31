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
 *  I16 the message handler did not throw after the dropper
 *  I17 no store:persistence-error after the dropper
 *  I18 an offline-ready mark is not beyond the committed prefix (nor, after a full resync, the view's watermark)
 *
 * Default run: the hops at every commit point (anchors) plus 3 seeded samples, for every scenario
 * and dropper in both modes. `KORA_HOPS_FULL=1` (`pnpm --filter @korajs/test test:hops:full`, nightly in chaos-nightly.yml) sweeps every hop;
 * `KORA_HOPS_STRIDE=n` every nth hop; `KORA_HOPS_SCEN`, `KORA_HOPS_DROP`, `KORA_HOPS_MODES`
 * (comma lists) narrow the sweep, and `KORA_HOPS_ONE=scenario,dropper,hop,mode` reproduces
 * one cell.
 */
import type { SimpleEventEmitter } from '@korajs/core/internal'
import type { OperationBatchMessage, SyncMessage } from '@korajs/sync'
import { afterAll, describe, expect, test } from 'vitest'
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
	op,
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

/** Droppers that give the device another view or user: what the old view hid is not redelivered as new. */
const CHANGES_VIEW = new Set([
	'updateScope',
	'registerSubset',
	'unsubscribe',
	'pinSubsets',
	'principal',
	'refreshPrincipal',
])

const sleepMacrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Event-loop turns without a single hop after which a cell is a deadlock (load-independent). */
const IDLE_TURNS = 5_000
/** A cell that hops this often is a livelock (the largest scenario takes about 40,000). */
const MAX_HOPS = 2_000_000

/** Calls the engine makes in the same turn as the position check in front of them. */
const SAME_TURN_AS_CHECK = new Set([
	'store.applyCollectionNarrowing:call',
	'engine.ensureOfflineUnit:call',
	// The message chain checks the session epoch and calls the handler in one synchronous turn.
	'engine.handleOperationBatch:call',
	// The retraction guard sits right before these two calls, in the same synchronous turn.
	// (applyDeliveredRetraction:call is NOT here: its awaits, deferScopeRetraction and the
	// hide, are exactly where a drop has to land.)
	'engine.applyScopeRetraction:call',
	'store.applyScopeRetraction:call',
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

/** Engine entry points the droppers call: not hops themselves. */
const DROPPER_METHODS = new Set([
	'start',
	'stop',
	'destroy',
	'reconnect',
	'bindSignedInUser',
	'refreshPrincipal',
	'retryNow',
	'resetDeliveryForFullResync',
	'retryQuarantinedOperations',
	'startInternal',
	'stopInternal',
	'reconnectInternal',
	'withPrincipalLock',
	'applyPrincipal',
	'handleMessageAsync',
])

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
	// Every async method of the engine is a hop except the ones that ARE a dropper (wrapping a
	// dropper would make the cell wait for its own cause).
	wrapNamed(
		e,
		asyncMethodNames(engine).filter((name) => !DROPPER_METHODS.has(name)),
		hopper,
		'engine.',
	)
	const syncState = engine.syncState
	wrapNamed(syncState, asyncMethodNames(syncState), hopper, 'syncState.')
	const store = engine.store
	// Every async method of the live store is a hop; the three below are wrapped by hand.
	wrapNamed(
		store,
		asyncMethodNames(store).filter(
			(name) =>
				name !== 'applyDeliveryBatch' &&
				name !== 'applyCollectionNarrowing' &&
				name !== 'beginBulkReplication',
		),
		hopper,
		'store.',
	)
	{
		// The hide itself: a retraction applied after the dropper took effect (I8). Installed
		// outside the hop, because the engine has no await between its guard and this call.
		const hide = store.applyScopeRetraction as Fn | undefined
		if (typeof hide === 'function') {
			store.applyScopeRetraction = (...args: unknown[]): unknown => {
				if (hopper.armed && hopper.fired && observed.effective()) {
					observed.staleNarrowing.push(`RETRACTION after ${hopper.firedLabel}`)
				} else {
					observed.hideRan = true
				}
				return hide(...args)
			}
		}
	}
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
				if (process.env.KORA_HOPS_TRACE)
					console.log(
						'STALE-NARROW',
						hopper.firedLabel,
						engineOf(target).state,
						new Error().stack?.split('\n').slice(2, 8).join(' | '),
					)
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
			wrapNamed(replicaSync, asyncMethodNames(replicaSync), hopper, 'replicaSync.')
			// The scratch replica's own store, too: its every async call is a hop.
			wrapNamed(
				inner,
				asyncMethodNames(inner).filter((name) => name !== 'applyDeliveryBatch'),
				hopper,
				'replicaStore.',
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
	| 'refreshPrincipal'
	| 'notifyAuth'
	| 'retryQuarantine'
	| 'destroy'
	| 'startAgain'
	| 'retryNow'
	| 'pinSubsets'
const ALL_DROPPERS: Dropper[] = [
	'updateScope',
	'registerSubset',
	'unsubscribe',
	'stop',
	'reconnect',
	'transportClose',
	'principal',
	'fullResync',
	'refreshPrincipal',
	'notifyAuth',
	'retryQuarantine',
	'destroy',
	'startAgain',
	'retryNow',
	'pinSubsets',
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

/**
 * 90 rows with one operation for a collection the device does not know in the last batch: it
 * is quarantined (and replayed by `retryQuarantinedOperations`, to no avail), and its delivery
 * sequence is part of the position.
 */
const GHOST_AFTER_ROWS = 65
const QUARANTINE_FIXTURE: OperationBatchMessage[] = (() => {
	const rows = numberedOps(90, { prefix: 'm' })
	const ghost = op('insert', 'g1', { title: 'ghost' }, { collection: 'ghosts' })
	return stream([...rows.slice(0, GHOST_AFTER_ROWS), ghost, ...rows.slice(GHOST_AFTER_ROWS)], 31)
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
	/** A quarantined operation sits in the stream once this many rows are in (it has a sequence of its own). */
	ghostAfterRows?: number
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
	quarantinedDirect: {
		staged: false,
		fixture: QUARANTINE_FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		ghostAfterRows: GHOST_AFTER_ROWS,
	},
	quarantinedStaged: {
		staged: true,
		fixture: QUARANTINE_FIXTURE,
		before: [0, 1],
		index: 2,
		total: 90,
		ghostAfterRows: GHOST_AFTER_ROWS,
	},
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
	// The node is unpinned so that a different signed-in user really moves to a node of their
	// own and syncs on (a pinned node refuses them and suspends sync, where nothing can be redelivered).
	const options: DeviceOptions = { principal: async () => user.id, unpinnedNode: true }
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
				case 'fullResync': {
					// Serialized with batch handling, as in production (the handshake response and
					// the session start run it inside / after the message chain): it queues behind
					// the batch in flight. A resync that overlapped a batch is not a state the
					// engine can be in; staged-replication.test.ts pins that structurally.
					const chained = engine as unknown as { messageChain: Promise<void> }
					chained.messageChain = chained.messageChain.then(() =>
						engine.resetDeliveryForFullResync(),
					)
					await chained.messageChain
					break
				}
				case 'refreshPrincipal':
					user.id = 'user-b'
					await target.engine.refreshPrincipal()
					break
				case 'notifyAuth':
					target.engine.notifyAuthChanged()
					await target.engine.bindSignedInUser()
					break
				case 'retryQuarantine':
					await target.engine.retryQuarantinedOperations()
					break
				case 'destroy':
					await target.engine.destroy()
					break
				case 'startAgain':
					await target.engine.start()
					break
				case 'retryNow':
					await target.engine.retryNow()
					break
				case 'pinSubsets':
					target.engine.setPinQuerySubsets([{ collection: 'lessons', where: { school: 'p' } }])
					break
			}
		})().catch(() => undefined)
	}
	// A dropper has taken effect when the position the batch was received at is gone: the
	// engine's own token of it (session, connection, view, user, drop counter) is different. A
	// sign-in or an auth change takes awaits to land, a no-op dropper never does.
	const positionToken = (): string => {
		const e = engine as unknown as Record<string, unknown>
		return [
			e.sessionEpoch,
			e.connectionGeneration,
			engine.deliverySignature(),
			e.principal,
			e.deliveryGeneration,
		].join('|')
	}
	const tokenAtStart = positionToken()
	const observed: Observed = {
		effective: () => positionToken() !== tokenAtStart,
		hideRan: false,
		staleNarrowing: [],
		acks: [],
	}
	instrument(target, hopper, observed)
	{
		// I16: the batch handler must not throw after the dropper. I17: nothing may fail to persist.
		const failure = (engine as unknown as Loose).handleMessageFailure as Fn | undefined
		if (typeof failure === 'function') {
			;(engine as unknown as Loose).handleMessageFailure = (error: unknown): unknown => {
				if (hopper.armed) {
					problems.push(
						`I16 message handling threw after ${hopper.firedLabel || 'no dropper'}: ${String(error).slice(0, 140)}`,
					)
				}
				return failure.call(engine, error)
			}
		}
		target.emitter.on('store:persistence-error', (event) => {
			if (hopper.armed && hopper.fired) {
				problems.push(
					`I17 persistence-error ${(event as { code: string }).code} after ${hopper.firedLabel}`,
				)
			}
		})
	}
	if (process.env.KORA_HOPS_TRACE) {
		const holder = engine.holdingEmitter as unknown as { hold(e: { type: string }): void }
		const realHold = holder.hold.bind(holder)
		holder.hold = (event): void => {
			console.log(
				'HOLD',
				event.type,
				'staging',
				engine.staging !== null,
				new Error().stack?.split('\n').slice(2, 9).join(' | '),
			)
			realHold(event)
		}
		const disc = engine.holdingEmitter as unknown as { discard(): void }
		const realDisc = disc.discard.bind(disc)
		disc.discard = (): void => {
			console.log('DISCARD', new Error().stack?.split('\n').slice(2, 6).join(' | '))
			realDisc()
		}
	}
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
	// A deadlock fails the cell. It is declared by progress, not by wall time: no hop and no
	// completion for IDLE_TURNS consecutive event-loop turns (a loaded machine runs the same
	// number of turns, only slower), or a run that never stops hopping.
	let idleTurns = 0
	let lastCount = -1
	while (!finished) {
		await sleepMacrotask()
		if (hopper.count !== lastCount) {
			lastCount = hopper.count
			idleTurns = 0
		} else if (++idleTurns >= IDLE_TURNS) {
			problems.push(`deliver made no progress for ${IDLE_TURNS} event-loop turns (deadlock)`)
			break
		}
		if (hopper.count > MAX_HOPS) {
			problems.push(`deliver did not finish within ${MAX_HOPS} hops (livelock)`)
			break
		}
	}
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
	const ghostSequences =
		scenario.ghostAfterRows !== undefined && rows >= scenario.ghostAfterRows ? 1 : 0
	const prefix =
		(rows >= scenario.total ? rows + spare : rows + (spare > 0 && rows > 60 ? 1 : 0)) +
		ghostSequences
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
		const heldNow = (engine.holdingEmitter as unknown as { held: Array<{ type: string }> }).held
		problems.push(
			`I6 held events with no replica: ${heldNow
				.map((event) => event.type)
				.join(',')
				.slice(0, 120)}`,
		)
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

	// I18: an offline-ready mark claims its view complete at a watermark; the persisted
	// watermark of that view and the data must both have reached it.
	{
		const syncState = engine.syncState as unknown as {
			loadOfflineMarks?: () => Promise<{
				marks: Array<{ signature: string; watermark: number }>
			}>
		}
		const snapshot = await syncState.loadOfflineMarks?.()
		for (const mark of snapshot?.marks ?? []) {
			const persisted = await target.store.loadDeliveryWatermark(mark.signature)
			// A full resync resets the watermark and must take the mark with it. Any other drop
			// may leave the view's watermark below its mark: a durable write of the previous view
			// queued behind the batch's transaction lands after it, the data is all there, and a
			// lower watermark only costs a redelivery of rows that are duplicates.
			if (dropper === 'fullResync' && mark.watermark > persisted) {
				problems.push(
					`I18 offline mark at ${mark.watermark} but the view's watermark is ${persisted} (${JSON.stringify(mark.signature).slice(0, 24)})`,
				)
			}
			if (mark.watermark > prefix) {
				problems.push(`I18 offline mark at ${mark.watermark} beyond the committed prefix ${prefix}`)
			}
		}
	}

	if (dropper === 'destroy') {
		// A destroyed engine has nothing to redeliver to; its persisted state was checked above.
		return { problems, hops, label: hopper.firedLabel, labels: hopper.labels }
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
	if (dropper === 'principal' || dropper === 'refreshPrincipal') {
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
		// The rest (redelivery, I4, I9, I15) runs for the new user too: the position they were
		// handed is theirs, and the stream they get from it must be complete.
	}
	const staleNarrowing = observed.staleNarrowing.length > 0
	// The stream is redelivered as the server would: the narrowing message stands in for the
	// plain one at its place. (After a stale narrowing the plain one is sent, to see whether
	// the hide was undone: I9.)
	for (const [at, fixtureMessage] of scenario.fixture.entries()) {
		const sent = at === scenario.index && !staleNarrowing ? message : fixtureMessage
		if ((sent.baseDeliverySequence ?? 0) >= from) {
			await deliver(target, sent).catch((error: unknown) => {
				problems.push(`redeliver threw ${String(error).slice(0, 80)}`)
			})
		}
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
	// A stale hide is I9's finding; every other run must hold every row (a hide that ran for the
	// view in force hides rows of that view, which are still rows of the table).
	const hiddenForOldView = observed.hideRan && CHANGES_VIEW.has(dropper ?? '')
	if (after.lessons.length !== wanted && !staleNarrowing && !hiddenForOldView) {
		problems.push(`I4 after redelivery from ${from}: ${after.lessons.length}/${wanted} rows`)
	}
	if (new Set(after.logLessons).size !== after.logLessons.length) {
		problems.push('I4 duplicate log rows')
	}
	if (!staleNarrowing && !hiddenForOldView && extra.localAt === undefined) {
		let reference = references.get(scenarioName)
		if (reference === undefined) {
			const direct = await device(false)
			for (const [at, fixtureMessage] of scenario.fixture.entries()) {
				await deliver(direct, at === scenario.index ? message : fixtureMessage)
			}
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

afterAll(closeDevices)

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

/** A small deterministic generator, so the sampled hops of a default run are the same every run. */
function seeded(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

/** Hops sampled (seeded) on top of the commit points in a default run. */
const SAMPLE = Number(process.env.KORA_HOPS_SAMPLE ?? '3')
const SEED = Number(process.env.KORA_HOPS_SEED ?? '20261031')

/**
 * The default run: the hops next to every commit point plus a small seeded sample of the rest.
 * `KORA_HOPS_FULL=1` is the exhaustive sweep (every hop of every scenario), run nightly by
 * `.github/workflows/hops-nightly.yml` and by `pnpm --filter @korajs/test test:hops:full`.
 */
function hopsToTry(baseline: CellResult, salt: string): number[] {
	const hops = new Set<number>()
	if (FULL) {
		for (let hop = 1; hop <= baseline.hops; hop++) hops.add(hop)
	} else {
		if (process.env.KORA_HOPS_STRIDE !== undefined) {
			for (let hop = 1; hop <= baseline.hops; hop += STRIDE) hops.add(hop)
		}
		baseline.labels.forEach((label, index) => {
			if (!ANCHOR.test(label) || label.startsWith('engine.applyInbound')) return
			hops.add(index + 1)
		})
		let mix = SEED
		for (const char of salt) mix = Math.imul(mix ^ char.charCodeAt(0), 16777619) >>> 0
		const next = seeded(mix)
		for (let i = 0; i < SAMPLE; i++) hops.add(1 + Math.floor(next() * baseline.hops))
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
					for (const hop of hopsToTry(baseline, `${scenarioName}/${dropper}/${mode}`)) {
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
