import type { KoraEventEmitter } from '@korajs/core'

/**
 * Durable-storage state of this origin, as far as Kora knows (NEW-STORE-4).
 * - `unknown`: not checked yet (the boot check runs in the background).
 * - `persisted`: the browser granted persistent storage; it will not evict this
 *   origin's data under storage pressure.
 * - `best-effort`: storage may be evicted under pressure (the browser default).
 * - `unsupported`: the runtime has no StorageManager persistence API (Node,
 *   older browsers, some WebViews).
 * - `error`: the check or request threw; `lastError` says why.
 */
export type StoragePersistenceState =
	| 'unknown'
	| 'persisted'
	| 'best-effort'
	| 'unsupported'
	| 'error'

/** Snapshot returned by `app.storage.persistence.status()`. */
export interface StoragePersistenceStatus {
	state: StoragePersistenceState
	/** True only when the browser reported persistent storage. */
	persisted: boolean
	/** True once `persist()` was asked for (explicitly or by an automatic trigger). */
	requested: boolean
	/** Message of the last failure, when `state` is `error`. */
	lastError?: string
}

/** Why an automatic (background) persistence request was made. */
export type PersistenceRequestReason = 'explicit' | 'sign-in' | 'first-write' | 'installed-app'

/** The subset of `navigator.storage` used here. */
export interface PersistenceStorageManager {
	persist?: () => Promise<boolean>
	persisted?: () => Promise<boolean>
}

/** Options for {@link StoragePersistence}. */
export interface StoragePersistenceOptions {
	/** Receives `storage:persistence` events. */
	emitter?: KoraEventEmitter | null
	/**
	 * The StorageManager to use. Defaults to `globalThis.navigator.storage`,
	 * resolved on each call so tests and late polyfills are honoured.
	 */
	storage?: PersistenceStorageManager | null
}

function defaultStorageManager(): PersistenceStorageManager | null {
	const nav = (globalThis as { navigator?: { storage?: PersistenceStorageManager } }).navigator
	return nav?.storage ?? null
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

/**
 * Tracks and requests durable storage (`navigator.storage.persist()`) without ever
 * putting it on the startup path (NEW-STORE-4).
 *
 * In Firefox `persist()` opens a permission prompt and its promise stays pending
 * until the user answers, so awaiting it inside startup could hang `app.ready`
 * forever. Kora therefore:
 * - checks `persisted()` at boot, which never prompts, in the background;
 * - requests persistence only on an explicit `request()` or, without awaiting,
 *   after a meaningful moment (sign-in, the first local write, running as an
 *   installed app);
 * - surfaces every result through `status()` and the `storage:persistence` event,
 *   never by blocking.
 */
export class StoragePersistence {
	private current: StoragePersistenceStatus = {
		state: 'unknown',
		persisted: false,
		requested: false,
	}
	private inFlightRequest: Promise<StoragePersistenceStatus> | null = null
	private readonly emitter: KoraEventEmitter | null
	private readonly storageOverride: PersistenceStorageManager | null | undefined

	constructor(options: StoragePersistenceOptions = {}) {
		this.emitter = options.emitter ?? null
		this.storageOverride = options.storage
	}

	/** Synchronous snapshot of the last known state. Never prompts. */
	status(): StoragePersistenceStatus {
		return { ...this.current }
	}

	/**
	 * Read whether storage is already persistent (`navigator.storage.persisted()`).
	 * Never prompts and never throws: a failure becomes `state: 'error'`.
	 */
	async check(): Promise<StoragePersistenceStatus> {
		const storage = this.storage()
		if (!storage || typeof storage.persisted !== 'function') {
			this.update({ state: 'unsupported', persisted: false })
			if (storage) this.emit('unsupported', false)
			return this.status()
		}
		try {
			const persisted = (await storage.persisted()) === true
			// A grant observed by a concurrent request() is never downgraded here.
			if (!this.current.persisted) {
				this.update({ state: persisted ? 'persisted' : 'best-effort', persisted })
			}
			this.emit('checked', this.current.persisted)
		} catch (error) {
			this.update({ state: 'error', persisted: false, lastError: errorMessage(error) })
			this.emit('error', false, errorMessage(error))
		}
		return this.status()
	}

	/**
	 * Ask the browser for persistent storage (`navigator.storage.persist()`).
	 * May show a permission prompt (Firefox), so call it from a user gesture or a
	 * meaningful moment, and do not block rendering on it. Concurrent calls share
	 * one request. Never throws: a failure becomes `state: 'error'`.
	 *
	 * @returns The state after the browser answered
	 */
	request(): Promise<StoragePersistenceStatus> {
		if (this.inFlightRequest) return this.inFlightRequest
		const storage = this.storage()
		if (!storage || typeof storage.persist !== 'function') {
			this.update({ state: 'unsupported', persisted: false })
			if (storage) this.emit('unsupported', false)
			return Promise.resolve(this.status())
		}
		if (this.current.persisted) return Promise.resolve(this.status())
		const persist = storage.persist.bind(storage)
		this.current = { ...this.current, requested: true }
		const pending = (async (): Promise<StoragePersistenceStatus> => {
			try {
				const persisted = (await persist()) === true
				this.update({ state: persisted ? 'persisted' : 'best-effort', persisted })
				this.emit('requested', persisted)
			} catch (error) {
				this.update({ state: 'error', persisted: false, lastError: errorMessage(error) })
				this.emit('error', false, errorMessage(error))
			} finally {
				this.inFlightRequest = null
			}
			return this.status()
		})()
		this.inFlightRequest = pending
		return pending
	}

	/**
	 * Fire-and-forget `request()` for an automatic trigger. Never awaited by Kora,
	 * so a pending prompt cannot block anything; the outcome arrives as a
	 * `storage:persistence` event. Skipped when storage is already persistent or a
	 * request was already made this session.
	 *
	 * @param _reason - Which trigger fired (kept for tracing at call sites)
	 */
	requestInBackground(_reason: PersistenceRequestReason): void {
		if (this.current.persisted || this.current.requested) return
		void this.request()
	}

	private storage(): PersistenceStorageManager | null {
		return this.storageOverride === undefined ? defaultStorageManager() : this.storageOverride
	}

	private update(next: Omit<StoragePersistenceStatus, 'requested'>): void {
		this.current = { ...next, requested: this.current.requested }
	}

	private emit(
		state: 'checked' | 'requested' | 'unsupported' | 'error',
		persisted: boolean,
		message?: string,
	): void {
		this.emitter?.emit({
			type: 'storage:persistence',
			state,
			persisted,
			...(message !== undefined ? { message } : {}),
		})
	}
}
