/**
 * Version gate: one build of the app writes a database at a time
 * (`docs/design/version-gate.md`).
 *
 * Every tab of an origin that opens a database declares an identity
 * `{ build, format, openSeq, tabId }` and holds an exclusive Web Lock named after it (its
 * tab lock) for its life. The set of held tab locks is the roster: `navigator.locks.query()`
 * lists every tab, including silent followers and tabs that have not processed any message.
 *
 * - The ordering key is `(format, openSeq)`: a newer storage format always wins, and within
 *   a format the later-opened tab wins (a deployment, or the rollback of one). `openSeq`
 *   comes from an IndexedDB counter ({@link allocateOpenSeq}), never from the clock.
 * - A tab RETIRES as soon as it learns of a tab of a different build with a higher key:
 *   it refuses new writes, drains the writes it started, makes them durable, stops sync,
 *   gives up its storage roles, and releases its tab lock. Retirement's steps are
 *   registered by the layers that own them ({@link VersionGate.addRetireStep}).
 * - A tab's write gate OPENS (its storage opens) only when no tab of another build with a
 *   lower key holds a tab lock: it waits for each one's release, with no deadline.
 *
 * Runtimes without a window (Node, native adapters) do not apply the gate: one process
 * owns the database file. A browser without `BroadcastChannel` gets an exclusive single
 * tab; a browser without Web Locks refuses to open unless `allowUncoordinatedTabs` is set.
 */

import type { KoraEventEmitter, SchemaDefinition, VersionGateTabIdentity } from '@korajs/core'
import { KORA_STORAGE_FORMAT } from '@korajs/core'
import {
	fnv1a32Hex,
	gatedLeaderLockName,
	leaderLockName,
	storageChannelName,
} from '../adapters/opfs-names'
import {
	BuildSupersededError,
	type BuildSupersededInfo,
	TabCoordinationUnavailableError,
	VersionGateClosedError,
} from '../errors'
import { allocateOpenSeq } from './open-seq'

/** The identity a tab declares to the gate. */
export type TabIdentity = VersionGateTabIdentity

/** Message a tab posts after acquiring its tab lock, and while its gate waits. */
export const BUILD_HELLO = 'kora-build-hello'
/** Message a retiring tab posts just before it releases its tab lock. */
export const BUILD_RETIRED = 'kora-build-retired'
/**
 * Message a retiring tab posts when its durability barrier failed (`unsaved: true`) or
 * succeeded again (`unsaved: false`), so waiting tabs can tell the user which tab needs
 * attention (`store:build-gate-waiting` reason `unsaved-writes`).
 */
export const BUILD_UNSAVED = 'kora-build-unsaved'
/** The storage leader's heartbeat (multi-tab storage); carries the leader's identity. */
const LEADER_HEARTBEAT = 'kora-leader-heartbeat'

const DEFAULT_HEARTBEAT_MS = 1000
const DEFAULT_WAITING_REPORT_MS = 10_000
const DEFAULT_RETRY_INITIAL_MS = 1000
const DEFAULT_RETRY_MAX_MS = 30_000

/**
 * Compare two tabs' ordering keys `(format, openSeq)`: positive when `a` wins. `openSeq` is
 * unique per database, so ties do not occur; `tabId` decides one deterministically anyway.
 */
export function compareTabKeys(a: TabIdentity, b: TabIdentity): number {
	if (a.format !== b.format) return a.format - b.format
	if (a.openSeq !== b.openSeq) return a.openSeq - b.openSeq
	return a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0
}

/** Prefix of every tab lock of `dbName`. */
export function tabLockPrefix(dbName: string): string {
	return `kora-tab:${dbName}:`
}

/** The tab lock name of `identity`: the prefix followed by the identity as JSON. */
export function tabLockName(dbName: string, identity: TabIdentity): string {
	return `${tabLockPrefix(dbName)}${JSON.stringify({
		build: identity.build,
		format: identity.format,
		openSeq: identity.openSeq,
		tabId: identity.tabId,
	})}`
}

/** The identity in a tab lock name of `dbName`, or null for any other lock. */
export function parseTabLockName(dbName: string, name: string): TabIdentity | null {
	const prefix = tabLockPrefix(dbName)
	if (!name.startsWith(prefix)) return null
	try {
		const value: unknown = JSON.parse(name.slice(prefix.length))
		return isTabIdentity(value) ? value : null
	} catch {
		return null
	}
}

/** Lock a tab holds while it has writes no stored snapshot holds yet (retiring or freezing). */
export function unsavedLockName(dbName: string, tabId: string): string {
	return `kora-tab-unsaved:${dbName}:${tabId}`
}

/** Lock a tab holds for its life when the browser has no `BroadcastChannel` (4.1.1). */
export function exclusiveDatabaseLockName(dbName: string): string {
	return `kora-db:${dbName}`
}

/** Whether `value` is a complete {@link TabIdentity}. */
export function isTabIdentity(value: unknown): value is TabIdentity {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.build === 'string' &&
		typeof candidate.format === 'number' &&
		Number.isSafeInteger(candidate.format) &&
		typeof candidate.openSeq === 'number' &&
		Number.isSafeInteger(candidate.openSeq) &&
		typeof candidate.tabId === 'string'
	)
}

/**
 * A build id derived from the storage format and the schema (collections, fields, version),
 * used only when the app supplies none (version gate, section 3): it still tells apart two
 * deployments whose schemas differ. Never the `korajs` package version.
 */
export function schemaFingerprint(schema: SchemaDefinition, format = KORA_STORAGE_FORMAT): string {
	const text = stableStringify({ format, version: schema.version, collections: schema.collections })
	return `schema-${format}-${schema.version}-${fnv1a32Hex(text)}${fnv1a32Hex(`${text.length}:${text}`)}`
}

function stableStringify(value: unknown): string {
	if (typeof value === 'function' || value === undefined) return 'null'
	if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
	const entries = Object.entries(value as Record<string, unknown>)
		.filter(([, entry]) => typeof entry !== 'function' && entry !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`
}

// === Runtime seams ===

/** The part of a Web Lock the gate uses. */
export interface GateLock {
	name: string
}

/** Options of a Web Locks request, as the gate uses them. */
export interface GateLockRequestOptions {
	mode?: 'exclusive' | 'shared'
	ifAvailable?: boolean
	signal?: AbortSignal
}

/** The part of `navigator.locks` the gate uses (injected in tests). */
export interface GateLockManager {
	request(
		name: string,
		options: GateLockRequestOptions,
		callback: (lock: GateLock | null) => unknown,
	): Promise<unknown>
	query(): Promise<{ held?: ReadonlyArray<{ name?: string }> }>
}

/** The part of a `BroadcastChannel` the gate uses (injected in tests). */
export interface GateChannel {
	postMessage(message: unknown): void
	addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
	removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
	close(): void
}

/** What the runtime offers the gate. Detected from globals unless injected. */
export interface VersionGateRuntime {
	/** A browser page (a `window` and a `document`): the gate applies. */
	browser: boolean
	locks: GateLockManager | null
	createChannel: ((name: string) => GateChannel) | null
}

function detectRuntime(): VersionGateRuntime {
	const browser = typeof window !== 'undefined' && typeof document !== 'undefined'
	const nav = typeof navigator !== 'undefined' ? navigator : undefined
	const locks =
		nav?.locks && typeof nav.locks.request === 'function' && typeof nav.locks.query === 'function'
			? (nav.locks as unknown as GateLockManager)
			: null
	const createChannel =
		typeof BroadcastChannel !== 'undefined'
			? (name: string): GateChannel => new BroadcastChannel(name) as unknown as GateChannel
			: null
	return { browser, locks, createChannel }
}

// === Gate ===

/** How the gate coordinates in this runtime (section 4.1.1). */
export type VersionGateMode =
	/** Not a browser: one process owns the database; nothing to coordinate. */
	| 'off'
	/** Web Locks and `BroadcastChannel`: the full protocol. */
	| 'full'
	/** Web Locks, no `BroadcastChannel`: one tab at a time. */
	| 'exclusive'
	/** No Web Locks: refused, unless the app allowed uncoordinated tabs. */
	| 'unavailable'
	/** No Web Locks, `allowUncoordinatedTabs`: single-tab as before the gate. */
	| 'uncoordinated'

/** Lifecycle of a gate. */
export type VersionGateState =
	| 'idle'
	| 'opening'
	| 'waiting'
	| 'open'
	| 'suspended'
	| 'retiring'
	| 'retired'
	| 'closed'

/** Phases of retirement, run in this order (section 5, steps 3 to 6). */
export type RetirePhase = 'drain' | 'durability' | 'sync' | 'roles'
const RETIRE_PHASES: readonly RetirePhase[] = ['drain', 'durability', 'sync', 'roles']

/** Passed to supersede listeners and retirement steps. */
export interface SupersededInfo {
	/** This tab. */
	current: TabIdentity
	/** The tab of a different build whose key is higher. */
	newer: TabIdentity
}

/** A change listeners of {@link VersionGate.onChange} hear about. */
export interface VersionGateSnapshot {
	state: VersionGateState
	identity: TabIdentity | null
	/** Set once this tab is superseded. */
	newer: TabIdentity | null
	/** This tab's retirement is held because its latest writes are not saved yet. */
	unsaved: boolean
	/** While waiting: the tabs this one waits for, and why. */
	waiting: {
		waitingFor: TabIdentity[]
		reason: 'live-writer' | 'unsaved-writes' | 'legacy-build'
	} | null
}

/** Options of {@link VersionGate}. */
export interface VersionGateOptions {
	/** The Kora database name the gate guards. */
	dbName: string
	/**
	 * The app's build id (`createApp({ build })`, or injected by the `@korajs/cli/vite`
	 * plugins). When absent, the adapter derives one from the schema before opening
	 * ({@link VersionGate.useSchemaFingerprint}) and `store:build-unidentified` is reported.
	 */
	build?: string
	/** Kora storage format of this code. Defaults to `KORA_STORAGE_FORMAT`. */
	format?: number
	emitter?: KoraEventEmitter
	/** Open single-tab in a browser without Web Locks (test environments). */
	allowUncoordinatedTabs?: boolean
	/** @internal Test seam: the runtime's coordination APIs. */
	runtime?: Partial<VersionGateRuntime>
	/** @internal Test seam: the open-order counter. */
	allocateOpenSeq?: (dbName: string) => Promise<number>
	/** Interval of re-sent hellos while waiting. Default 1000 ms. */
	heartbeatMs?: number
	/** Waiting time before `store:build-gate-waiting` is reported. Default 10 s. */
	waitingReportMs?: number
	/** Backoff of a failed durability barrier's retries. Default 1 s doubling to 30 s. */
	retryBackoffMs?: { initial: number; max: number }
	/** @internal Test seam: this tab's random id. */
	tabId?: string
}

interface HeldLock {
	release(): void
}

/**
 * The version gate of one database in one tab. See the module documentation.
 *
 * @example
 * ```typescript
 * const gate = new VersionGate({ dbName: 'my-app', build: import.meta.env.VITE_COMMIT_SHA })
 * gate.onSuperseded(({ newer }) => showReloadBanner(newer.build))
 * await gate.open() // resolves once no tab of another build writes this database
 * ```
 */
export class VersionGate {
	readonly dbName: string
	readonly format: number
	private build: string | null
	private buildUnidentified = false
	private readonly emitter: KoraEventEmitter | undefined
	private readonly runtime: VersionGateRuntime
	private readonly allocate: (dbName: string) => Promise<number>
	private readonly heartbeatMs: number
	private readonly waitingReportMs: number
	private readonly retryBackoff: { initial: number; max: number }
	private readonly tabId: string
	private readonly allowUncoordinatedTabs: boolean
	private currentMode: VersionGateMode

	private state: VersionGateState = 'idle'
	private identity: TabIdentity | null = null
	private openedAt: number | null = null
	private openPromise: Promise<void> | null = null
	private tabLock: HeldLock | null = null
	private exclusiveLock: HeldLock | null = null
	private channel: GateChannel | null = null
	private readonly onMessage = (event: { data: unknown }): void => this.handleMessage(event.data)

	private newer: TabIdentity | null = null
	private retirement: Promise<void> | null = null
	private retiredSignal: () => void = () => {}
	private readonly retiredPromise: Promise<void>
	private supersededSignal: () => void = () => {}
	private readonly supersededPromise: Promise<void>
	private readonly supersededListeners = new Set<(info: SupersededInfo) => void>()
	private readonly changeListeners = new Set<(snapshot: VersionGateSnapshot) => void>()
	private readonly steps = new Map<RetirePhase, Array<(info: SupersededInfo) => Promise<void>>>()

	private unsaved = false
	private pendingSave = false
	private unsavedMarker: HeldLock | null = null
	/** Unsaved marker locks seen at the last discovery. */
	private unsavedHeld = new Set<string>()
	private readonly unsavedPeers = new Set<string>()
	private waiting: VersionGateSnapshot['waiting'] = null
	private waitingReported: string | null = null
	private waitingTimers: Array<ReturnType<typeof setTimeout>> = []
	private readonly waitAborts = new Set<AbortController>()
	private legacyReported = false
	private retryWake: (() => void) | null = null
	private recoveryExporter: (() => Promise<unknown>) | null = null
	/** Aborts lock requests still queued when the gate closes. */
	private readonly closeAbort = new AbortController()

	constructor(options: VersionGateOptions) {
		this.dbName = options.dbName
		this.format = options.format ?? KORA_STORAGE_FORMAT
		this.build = options.build ?? null
		this.emitter = options.emitter
		this.runtime = { ...detectRuntime(), ...options.runtime }
		this.allocate = options.allocateOpenSeq ?? allocateOpenSeq
		this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
		this.waitingReportMs = options.waitingReportMs ?? DEFAULT_WAITING_REPORT_MS
		this.retryBackoff = options.retryBackoffMs ?? {
			initial: DEFAULT_RETRY_INITIAL_MS,
			max: DEFAULT_RETRY_MAX_MS,
		}
		this.tabId = options.tabId ?? createTabId()
		this.allowUncoordinatedTabs = options.allowUncoordinatedTabs === true
		this.currentMode = !this.runtime.browser
			? 'off'
			: this.runtime.locks === null
				? 'unavailable'
				: this.runtime.createChannel === null
					? 'exclusive'
					: 'full'
		this.retiredPromise = new Promise<void>((resolve) => {
			this.retiredSignal = resolve
		})
		this.supersededPromise = new Promise<void>((resolve) => {
			this.supersededSignal = resolve
		})
	}

	/** How the gate coordinates in this runtime. */
	get mode(): VersionGateMode {
		return this.currentMode
	}

	/** Whether tabs are coordinated at all (`full` or `exclusive`). */
	isCoordinating(): boolean {
		return this.currentMode === 'full' || this.currentMode === 'exclusive'
	}

	/** This tab's identity, once the gate allocated its `openSeq`. */
	getIdentity(): TabIdentity | null {
		return this.identity ? { ...this.identity } : null
	}

	/** The build this gate declares (null until set). */
	getBuild(): string | null {
		return this.build
	}

	/** DevTools: identity, open time (display only) and state. */
	getInfo(): { identity: TabIdentity | null; openedAt: number | null; state: VersionGateState } {
		return { identity: this.getIdentity(), openedAt: this.openedAt, state: this.state }
	}

	getState(): VersionGateState {
		return this.state
	}

	/** True once this tab is superseded (retiring or retired). */
	isSuperseded(): boolean {
		return this.newer !== null
	}

	/** The builds of a supersession, for {@link BuildSupersededError}. */
	supersededInfo(): BuildSupersededInfo | null {
		if (!this.newer) return null
		return { currentBuild: this.build ?? 'unknown', newerBuild: this.newer.build }
	}

	/**
	 * Use a fingerprint of the storage format and the schema as the build, when the app gave
	 * none. Reported as `store:build-unidentified` at open.
	 */
	useSchemaFingerprint(schema: SchemaDefinition): void {
		if (this.build !== null) return
		this.build = schemaFingerprint(schema, this.format)
		this.buildUnidentified = true
	}

	/**
	 * Called synchronously when this tab is superseded, before any write is refused
	 * (section 5, steps 1 and 2). Listeners close their write gates and show the prompt.
	 */
	onSuperseded(listener: (info: SupersededInfo) => void): () => void {
		this.supersededListeners.add(listener)
		if (this.newer && this.identity) {
			listener({ current: { ...this.identity }, newer: { ...this.newer } })
		}
		return () => {
			this.supersededListeners.delete(listener)
		}
	}

	/** Listen to state changes (prompts: waiting, unsaved writes, retired). */
	onChange(listener: (snapshot: VersionGateSnapshot) => void): () => void {
		this.changeListeners.add(listener)
		return () => {
			this.changeListeners.delete(listener)
		}
	}

	/** Current state, as {@link onChange} reports it. */
	snapshot(): VersionGateSnapshot {
		return {
			state: this.state,
			identity: this.getIdentity(),
			newer: this.newer ? { ...this.newer } : null,
			unsaved: this.unsaved,
			waiting: this.waiting
				? {
						waitingFor: this.waiting.waitingFor.map((t) => ({ ...t })),
						reason: this.waiting.reason,
					}
				: null,
		}
	}

	/**
	 * Register a retirement step. Steps run once, in phase order (`drain`, `durability`,
	 * `sync`, `roles`), each awaited; then the tab posts `kora-build-retired` and releases
	 * its tab lock, which opens the newer tab's gate.
	 */
	addRetireStep(phase: RetirePhase, step: (info: SupersededInfo) => Promise<void>): () => void {
		const list = this.steps.get(phase) ?? []
		list.push(step)
		this.steps.set(phase, list)
		return () => {
			const current = this.steps.get(phase)
			if (current)
				this.steps.set(
					phase,
					current.filter((entry) => entry !== step),
				)
		}
	}

	/**
	 * Open the write gate: allocate `openSeq`, take the tab lock, discover the other tabs and
	 * wait until no tab of another build with a lower key holds its lock. Resolves when this
	 * tab may open storage. Rejects with {@link BuildSupersededError} when a tab of another
	 * build with a higher key exists (this tab retires instead), and with
	 * {@link TabCoordinationUnavailableError} in a browser without Web Locks.
	 */
	open(): Promise<void> {
		if (!this.openPromise) this.openPromise = this.doOpen()
		return this.openPromise
	}

	private async doOpen(): Promise<void> {
		if (this.currentMode === 'off') {
			this.setState('open')
			return
		}
		if (this.currentMode === 'unavailable') {
			if (!this.allowUncoordinatedTabs) {
				const error = new TabCoordinationUnavailableError(this.dbName)
				this.emitter?.emit({
					type: 'store:tab-coordination-unavailable',
					dbName: this.dbName,
					message: error.message,
				})
				throw error
			}
			this.currentMode = 'uncoordinated'
			console.warn(
				`[kora] store.allowUncoordinatedTabs: database "${this.dbName}" opens without tab coordination (no Web Locks). Two tabs of the app can overwrite each other's writes; use this only in test environments.`,
			)
			this.setState('open')
			return
		}
		this.setState('opening')
		if (this.build === null) {
			// The adapter derives a fingerprint before opening; reaching here without one is a
			// direct gate user that set neither.
			this.build = 'unidentified'
			this.buildUnidentified = true
		}
		if (this.buildUnidentified) this.reportUnidentified()
		const openSeq = await this.allocate(this.dbName)
		this.throwIfClosed()
		this.identity = { build: this.build, format: this.format, openSeq, tabId: this.tabId }
		this.openedAt = Date.now()
		this.tabLock = await this.acquire(tabLockName(this.dbName, this.identity))
		if (this.currentMode === 'exclusive') {
			await this.acquireExclusive()
			this.throwIfClosed()
			this.setState('open')
			return
		}
		this.startChannel()
		this.postHello()
		await this.settle()
		this.throwIfClosed()
		this.setState('open')
	}

	/**
	 * A gate closed while it opened or resumed never reaches `open`: its tab lock and channel
	 * are gone, so storage must not open behind it.
	 */
	private throwIfClosed(): void {
		if (this.state === 'closed') throw new VersionGateClosedError(this.dbName)
	}

	/**
	 * Called by a tab granted the storage leader lock (first open or promotion) before it
	 * opens a worker (rule 4). False when a tab of another build with a higher key is listed
	 * (this tab retires) or this tab is already retiring: the caller releases the leader lock
	 * unopened.
	 */
	async mayLead(): Promise<boolean> {
		if (this.currentMode !== 'full') return true
		if (this.newer !== null || this.state === 'closed') return false
		const me = this.identity
		if (!me) return true
		const newer = (await this.discover()).find((tab) => this.supersedes(tab, me))
		if (newer) {
			void this.retire(newer)
			return false
		}
		return this.newer === null
	}

	/**
	 * Page lifecycle (`freeze`, bfcache `pagehide`): release the tab lock. The caller has
	 * already made every committed write durable and released the storage leader lock (the
	 * lifecycle rule of section 4.1). No-op unless the gate is open.
	 */
	suspend(): void {
		if (this.state !== 'open' || !this.isCoordinating()) return
		this.releaseHeldLocks()
		this.setState('suspended')
	}

	/**
	 * Page lifecycle (`resume`, `pageshow`): re-acquire the tab lock and run discovery before
	 * anything else (rule 5). False when this tab must not use storage again: it is retired,
	 * retiring, or a newer build appeared meanwhile (it retires now).
	 */
	async resume(): Promise<boolean> {
		if (this.state === 'open') return true
		if (this.state !== 'suspended') return false
		const me = this.identity
		if (!me) return false
		this.setState('opening')
		try {
			this.tabLock = await this.acquire(tabLockName(this.dbName, me))
			if (this.currentMode === 'exclusive') {
				await this.acquireExclusive()
			} else {
				this.postHello()
				await this.settle()
			}
			this.throwIfClosed()
		} catch (error) {
			if (error instanceof BuildSupersededError || error instanceof VersionGateClosedError) {
				return false
			}
			throw error
		}
		this.setState('open')
		return true
	}

	/**
	 * Report whether this retiring tab's durability barrier is failing, so waiting tabs can
	 * name it (`unsaved-writes`) and this tab's prompt can offer Retry and Export.
	 */
	reportUnsavedWrites(unsaved: boolean): void {
		if (this.unsaved === unsaved) return
		this.unsaved = unsaved
		this.updateUnsavedMarker()
		this.notifyChange()
	}

	/**
	 * Wait before the next durability retry: the backoff for `attempt`, or until
	 * {@link retryNow} (the user's Retry, `visibilitychange`), whichever is first.
	 */
	waitForRetry(attempt: number): Promise<void> {
		const delay = Math.min(this.retryBackoff.max, this.retryBackoff.initial * 2 ** attempt)
		return new Promise<void>((resolve) => {
			const timer = setTimeout(done, delay)
			const wake = (): void => done()
			function done(): void {
				clearTimeout(timer)
				resolve()
			}
			this.retryWake = wake
		}).finally(() => {
			this.retryWake = null
		})
	}

	/** Retry a failed durability barrier now (the prompt's Retry button). */
	retryNow(): void {
		this.retryWake?.()
	}

	/** Set by the IndexedDB adapter: a download of the in-memory database (Export button). */
	setRecoveryExporter(exporter: (() => Promise<unknown>) | null): void {
		this.recoveryExporter = exporter
	}

	/**
	 * The explicit recovery path while a failed barrier holds retirement: the in-memory
	 * database as a dump. Null when no adapter offers one (OPFS: committed is durable).
	 */
	async exportRecoveryDump(): Promise<unknown> {
		return this.recoveryExporter ? this.recoveryExporter() : null
	}

	/** Resolves once this tab has retired (its tab lock released). */
	whenRetired(): Promise<void> {
		return this.retiredPromise
	}

	/**
	 * Leader, retiring: wait until every other tab that is itself superseded (a tab of a
	 * different build with a higher key is present) has released its tab lock, so their
	 * retirement, which may still need this worker to finish a write or save a snapshot,
	 * completes before the worker stops. Tabs that will not retire (the winning build's)
	 * are never waited for, so this cannot wait on the tab that waits for this one.
	 */
	async waitForPeersToRetire(): Promise<void> {
		const me = this.identity
		if (!me || !this.newer || this.currentMode !== 'full') return
		for (;;) {
			const others = await this.discover()
			const everyone = [me, ...others]
			const retiring = others.filter((tab) =>
				everyone.some((other) => other.build !== tab.build && compareTabKeys(other, tab) > 0),
			)
			if (retiring.length === 0) return
			await Promise.all(retiring.map((tab) => this.waitForRelease(tabLockName(this.dbName, tab))))
		}
	}

	/**
	 * Tell waiting tabs that this tab holds its tab lock only until a snapshot of its latest
	 * writes is stored (a page lifecycle suspend with a pending flush, section 4.1), so they
	 * report `unsaved-writes`. Posted synchronously: the page may be frozen right after.
	 */
	announcePendingSave(pending: boolean): void {
		if (this.pendingSave === pending) return
		this.pendingSave = pending
		this.updateUnsavedMarker()
	}

	/**
	 * While this tab holds writes not yet in a stored snapshot (a failed barrier, a pending
	 * lifecycle save), it holds an unsaved marker lock and tells the channel. The lock is
	 * what a tab that opens later finds (`query()`): it may never see the message.
	 */
	private updateUnsavedMarker(): void {
		const me = this.identity
		if (!me) return
		const unsaved = this.unsaved || this.pendingSave
		if (unsaved && !this.unsavedMarker && this.runtime.locks) {
			let release: () => void = () => {}
			const held = new Promise<void>((resolve) => {
				release = resolve
			})
			void this.runtime.locks
				.request(unsavedLockName(this.dbName, me.tabId), { mode: 'exclusive' }, () => held)
				.catch(() => undefined)
			this.unsavedMarker = { release }
		} else if (!unsaved && this.unsavedMarker) {
			this.unsavedMarker.release()
			this.unsavedMarker = null
		}
		this.post({ type: BUILD_UNSAVED, identity: me, unsaved })
	}

	/** Normal close: release the locks and leave the channel. A pending open fails. */
	close(): void {
		if (this.state === 'closed') return
		const retired = this.state === 'retired'
		if (!retired) this.setState('closed')
		this.closeAbort.abort()
		this.stopWaitingTimers()
		for (const controller of this.waitAborts) controller.abort()
		this.waitAborts.clear()
		this.releaseHeldLocks()
		this.stopChannel()
	}

	// === Protocol ===

	private supersedes(tab: TabIdentity, me: TabIdentity): boolean {
		return tab.tabId !== me.tabId && tab.build !== me.build && compareTabKeys(tab, me) > 0
	}

	/**
	 * Wait until no tab of another build with a lower key holds its tab lock (rule 2), or
	 * throw {@link BuildSupersededError} when one with a higher key exists (rule 1).
	 */
	private async settle(): Promise<void> {
		for (;;) {
			this.throwIfClosed()
			this.throwIfSuperseded()
			const me = this.identity
			if (!me) return
			const others = await this.discover()
			this.throwIfClosed()
			this.throwIfSuperseded()
			const newer = others.find((tab) => this.supersedes(tab, me))
			if (newer) {
				void this.retire(newer)
				this.throwIfSuperseded()
			}
			const older = others.filter(
				(tab) => tab.build !== me.build && compareTabKeys(tab, me) < 0 && tab.tabId !== me.tabId,
			)
			const legacy = await this.legacyLeaderPresent()
			if (older.length === 0 && !legacy) {
				this.waiting = null
				return
			}
			if (legacy) this.reportLegacy()
			this.waiting = {
				waitingFor: older,
				reason: legacy ? 'legacy-build' : this.waitingReason(older),
			}
			this.setState('waiting')
			this.postHello()
			this.startWaitingTimers()
			try {
				const releases = older.map((tab) => this.waitForRelease(tabLockName(this.dbName, tab)))
				if (legacy) {
					releases.push(this.waitForRelease(leaderLockName(this.dbName)))
				}
				await Promise.race([Promise.all(releases), this.supersededPromise])
			} finally {
				this.stopWaitingTimers()
			}
		}
	}

	/**
	 * A pre-gate build is the storage leader when the leader lock is held without the gated
	 * leader marker (every gated leader takes {@link gatedLeaderLockName} right after it is
	 * granted the leader lock, and releases it after the leader lock). The marker is checked
	 * twice, one heartbeat apart, so a gated leader between its two grants is not mistaken
	 * for a pre-gate one.
	 */
	private async legacyLeaderPresent(): Promise<boolean> {
		const locks = this.runtime.locks
		if (!locks) return false
		for (let check = 0; check < 2; check += 1) {
			const held = new Set((await locks.query()).held?.map((lock) => lock.name) ?? [])
			if (!held.has(leaderLockName(this.dbName))) return false
			if (held.has(gatedLeaderLockName(this.dbName))) return false
			if (check === 0) {
				await new Promise<void>((resolve) => setTimeout(resolve, this.heartbeatMs))
			}
		}
		return true
	}

	private waitingReason(older: TabIdentity[]): 'live-writer' | 'unsaved-writes' {
		return older.some((tab) => this.unsavedPeers.has(tab.tabId) || this.unsavedHeld.has(tab.tabId))
			? 'unsaved-writes'
			: 'live-writer'
	}

	private async discover(): Promise<TabIdentity[]> {
		const locks = this.runtime.locks
		if (!locks) return []
		const snapshot = await locks.query()
		const tabs: TabIdentity[] = []
		const seen = new Set<string>()
		const unsavedPrefix = unsavedLockName(this.dbName, '')
		this.unsavedHeld = new Set()
		for (const lock of snapshot.held ?? []) {
			if (typeof lock.name !== 'string') continue
			if (lock.name.startsWith(unsavedPrefix)) {
				this.unsavedHeld.add(lock.name.slice(unsavedPrefix.length))
				continue
			}
			const identity = parseTabLockName(this.dbName, lock.name)
			if (!identity || identity.tabId === this.tabId || seen.has(identity.tabId)) continue
			seen.add(identity.tabId)
			tabs.push(identity)
		}
		return tabs
	}

	private handleMessage(data: unknown): void {
		if (typeof data !== 'object' || data === null) return
		const message = data as {
			type?: unknown
			identity?: unknown
			unsaved?: unknown
			epoch?: unknown
		}
		if (message.type === BUILD_HELLO && isTabIdentity(message.identity)) {
			this.consider(message.identity)
			return
		}
		if (message.type === BUILD_UNSAVED && isTabIdentity(message.identity)) {
			if (message.unsaved === true) this.unsavedPeers.add(message.identity.tabId)
			else this.unsavedPeers.delete(message.identity.tabId)
			this.refreshWaitingReason()
			return
		}
		if (message.type === BUILD_RETIRED && isTabIdentity(message.identity)) {
			this.unsavedPeers.delete(message.identity.tabId)
			return
		}
		if (message.type === LEADER_HEARTBEAT && isTabIdentity(message.identity)) {
			this.consider(message.identity)
		}
	}

	/** Rule 1: retire as soon as a tab of another build with a higher key is known. */
	private consider(other: TabIdentity): void {
		const me = this.identity
		if (!me || this.newer !== null) return
		if (this.state === 'closed' || this.state === 'idle' || this.state === 'suspended') return
		if (this.supersedes(other, me)) void this.retire(other)
	}

	/** Section 5: announce, refuse writes, then run the registered steps in phase order. */
	private retire(newer: TabIdentity): Promise<void> {
		if (this.retirement) return this.retirement
		const me = this.identity
		if (!me) return Promise.resolve()
		this.newer = { ...newer }
		this.waiting = null
		this.stopWaitingTimers()
		for (const controller of this.waitAborts) controller.abort()
		this.waitAborts.clear()
		this.setState('retiring')
		const info: SupersededInfo = { current: { ...me }, newer: { ...newer } }
		// Steps 1 and 2 in this task: every listener (prompt, write gates) runs before any
		// write can be refused.
		for (const listener of [...this.supersededListeners]) {
			try {
				listener(info)
			} catch (error) {
				console.error('[kora] version gate: a build-superseded listener failed:', error)
			}
		}
		this.supersededSignal()
		this.retirement = this.runRetirement(info)
		return this.retirement
	}

	private async runRetirement(info: SupersededInfo): Promise<void> {
		for (const phase of RETIRE_PHASES) {
			for (const step of [...(this.steps.get(phase) ?? [])]) {
				// A failed step keeps the tab lock: the step runs again (backoff, or the user's
				// Retry) until it completes. Releasing early would let the newer build open while
				// this tab may still hold a worker, the leader lock or unsaved writes.
				for (let attempt = 0; ; attempt += 1) {
					if (this.state === 'closed') return
					try {
						await step(info)
						break
					} catch (error) {
						console.error(
							`[kora] version gate: retirement step "${phase}" failed; retrying:`,
							error,
						)
						await this.waitForRetry(attempt)
					}
				}
			}
		}
		if (this.state === 'closed') return
		this.post({ type: BUILD_RETIRED, identity: info.current })
		this.releaseHeldLocks()
		this.stopChannel()
		this.setState('retired')
		this.retiredSignal()
	}

	private throwIfSuperseded(): void {
		const info = this.supersededInfo()
		if (info) throw new BuildSupersededError({ operation: 'open' }, info)
	}

	private refreshWaitingReason(): void {
		if (!this.waiting || this.waiting.reason === 'legacy-build') return
		const reason = this.waitingReason(this.waiting.waitingFor)
		if (reason === this.waiting.reason) return
		this.waiting = { ...this.waiting, reason }
		if (this.waitingReported !== null) this.reportWaiting()
		else this.notifyChange()
	}

	private startWaitingTimers(): void {
		this.stopWaitingTimers()
		this.waitingTimers.push(setTimeout(() => this.reportWaiting(), this.waitingReportMs))
		const rehello = (): void => {
			if (this.state !== 'waiting') return
			this.postHello()
			this.waitingTimers.push(setTimeout(rehello, this.heartbeatMs))
		}
		this.waitingTimers.push(setTimeout(rehello, this.heartbeatMs))
	}

	private stopWaitingTimers(): void {
		for (const timer of this.waitingTimers) clearTimeout(timer)
		this.waitingTimers = []
		this.waitingReported = null
	}

	private reportWaiting(): void {
		const waiting = this.waiting
		if (!waiting || this.state !== 'waiting') return
		this.waitingReported = waiting.reason
		const message =
			waiting.reason === 'unsaved-writes'
				? 'Another tab of this app is on an older version and cannot save its latest changes (storage is full). Switch to that tab to resolve it.'
				: waiting.reason === 'legacy-build'
					? 'Another tab of this app is open on an older version. Close other tabs of this app, then reload.'
					: 'Another tab of this app is still open on an older version. Close it to continue.'
		this.emitter?.emit({
			type: 'store:build-gate-waiting',
			dbName: this.dbName,
			waitingFor: waiting.waitingFor.map((tab) => ({ ...tab })),
			reason: waiting.reason,
			message,
		})
		this.notifyChange()
	}

	private reportUnidentified(): void {
		const message = `Database "${this.dbName}" has no build id, so tabs of two deployments are told apart only by a schema fingerprint (${this.build}); a deployment that changes only application code is not gated. Pass createApp({ build }) (a commit SHA or CI build number) or use koraBuildId() / koraServiceWorker() from @korajs/cli/vite.`
		this.emitter?.emit({
			type: 'store:build-unidentified',
			dbName: this.dbName,
			fingerprint: this.build ?? 'unidentified',
			message,
		})
		console.warn(`[kora] ${message}`)
	}

	private reportLegacy(): void {
		if (this.legacyReported) return
		this.legacyReported = true
		this.emitter?.emit({
			type: 'store:legacy-build-detected',
			dbName: this.dbName,
			message:
				'A tab running an older version of this app (from before the version gate) is still open. Close other tabs of this app, then reload.',
		})
	}

	private postHello(): void {
		if (this.identity) this.post({ type: BUILD_HELLO, identity: this.identity })
	}

	private post(message: unknown): void {
		try {
			this.channel?.postMessage(message)
		} catch (error) {
			console.warn('[kora] version gate: could not post to the storage channel:', error)
		}
	}

	private startChannel(): void {
		if (this.channel || !this.runtime.createChannel) return
		this.channel = this.runtime.createChannel(storageChannelName(this.dbName))
		this.channel.addEventListener('message', this.onMessage)
	}

	private stopChannel(): void {
		if (!this.channel) return
		this.channel.removeEventListener('message', this.onMessage)
		this.channel.close()
		this.channel = null
	}

	// === Locks ===

	/** Request an exclusive lock and hold it until released. */
	private acquire(name: string, ifAvailable = false): Promise<HeldLock> {
		const locks = this.requireLocks()
		if (this.state === 'closed') return Promise.reject(new VersionGateClosedError(this.dbName))
		return new Promise<HeldLock>((resolve, reject) => {
			let release: () => void = () => {}
			const held = new Promise<void>((done) => {
				release = done
			})
			locks
				.request(
					name,
					ifAvailable
						? { mode: 'exclusive', ifAvailable: true }
						: { mode: 'exclusive', signal: this.closeAbort.signal },
					(lock) => {
						if (lock === null) {
							reject(new LockUnavailable())
							return undefined
						}
						if (this.state === 'closed') {
							// Granted after close: hand it straight back.
							reject(new VersionGateClosedError(this.dbName))
							return undefined
						}
						resolve({ release })
						return held
					},
				)
				.catch(() => reject(new VersionGateClosedError(this.dbName)))
		})
	}

	/** Exclusive single tab (no `BroadcastChannel`): hold `kora-db:<db>` for the tab's life. */
	private async acquireExclusive(): Promise<void> {
		const name = exclusiveDatabaseLockName(this.dbName)
		try {
			this.exclusiveLock = await this.acquire(name, true)
			return
		} catch (error) {
			if (!(error instanceof LockUnavailable)) throw error
		}
		const me = this.identity
		const holder = me
			? ((await this.discover()).find((tab) => tab.tabId !== me.tabId) ?? null)
			: null
		if (me && holder && this.supersedes(holder, me)) {
			// The database is held by a tab of another build that opened later: this tab never
			// opened storage, so it retires at once.
			void this.retire(holder)
			this.throwIfSuperseded()
		}
		this.emitter?.emit({
			type: 'store:tab-exclusive',
			dbName: this.dbName,
			heldBy: holder ? { ...holder } : null,
			message: 'This app is open in another tab. Close it to continue here.',
		})
		if (me && holder && holder.build !== me.build && compareTabKeys(holder, me) < 0) {
			this.waiting = { waitingFor: [holder], reason: 'live-writer' }
			this.setState('waiting')
			this.reportWaiting()
		}
		this.exclusiveLock = await this.acquire(name)
		this.waiting = null
	}

	/** Resolves once no tab holds `name` (a shared request is granted only then). */
	private waitForRelease(name: string): Promise<void> {
		const locks = this.requireLocks()
		const controller = new AbortController()
		this.waitAborts.add(controller)
		return locks
			.request(name, { mode: 'shared', signal: controller.signal }, () => undefined)
			.then(
				() => undefined,
				() => undefined,
			)
			.finally(() => {
				this.waitAborts.delete(controller)
			})
	}

	private releaseHeldLocks(): void {
		this.unsavedMarker?.release()
		this.unsavedMarker = null
		// The exclusive database lock (no-channel mode) first: it is the storage role.
		this.exclusiveLock?.release()
		this.exclusiveLock = null
		this.tabLock?.release()
		this.tabLock = null
	}

	private requireLocks(): GateLockManager {
		const locks = this.runtime.locks
		if (!locks) throw new TabCoordinationUnavailableError(this.dbName)
		return locks
	}

	private setState(state: VersionGateState): void {
		if (this.state === state) return
		this.state = state
		this.notifyChange()
	}

	private notifyChange(): void {
		const snapshot = this.snapshot()
		for (const listener of [...this.changeListeners]) {
			try {
				listener(snapshot)
			} catch (error) {
				console.error('[kora] version gate: a change listener failed:', error)
			}
		}
	}
}

class LockUnavailable extends Error {}

function createTabId(): string {
	if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
		return crypto.randomUUID()
	}
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
