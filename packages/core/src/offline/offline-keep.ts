/**
 * `app.offline.keep()`: pins that tell the device what to hold for offline use
 * (offline-readiness design, sections 3, 4.3 and 5).
 *
 * A pin is a single-collection `where` query, optionally with the files its records
 * reference. Pins are local to the device (a table in the database, never operations) and
 * bounded: at most {@link OFFLINE_PIN_LIMIT} per database, because they travel in the sync
 * handshake as query views.
 */
import { hashBlob } from '../blob/blob-ref'
import { KoraError } from '../errors/errors'

/** The most pins one database keeps (decision 5: pins travel in the handshake). */
export const OFFLINE_PIN_LIMIT = 64

/** Why a keep request was refused. */
export type OfflineKeepErrorCode = 'OFFLINE_KEEP_UNSUPPORTED_QUERY' | 'OFFLINE_PIN_LIMIT'

/** Thrown by `app.offline.keep()` and `useOfflineKeep()` when a pin cannot be kept. */
export class OfflineKeepError extends KoraError {
	constructor(message: string, code: OfflineKeepErrorCode, context?: Record<string, unknown>) {
		super(message, code, context)
		this.name = 'OfflineKeepError'
	}
}

/** Options of `app.offline.keep()` and `useOfflineKeep()`. */
export interface OfflineKeepOptions {
	/**
	 * Also keep the files (`blob` fields) of the matching records on this device. Default false.
	 * `ready` then waits for every file, and needs a blob store that survives a reload.
	 */
	files?: boolean
}

/**
 * The part of a query builder `keep` reads: its descriptor. Structural so a query from any
 * binding (`app.lessons.where(...)`) is accepted without importing the store package.
 */
export interface OfflineKeepQuery {
	getDescriptor(): {
		collection: string
		where: Record<string, unknown>
		limit?: number
		offset?: number
		include?: string[]
	}
}

/** Files of a pin that are on the device, and what is left. */
export interface OfflineKeepFilesProgress {
	/** Files on this device whose bytes were read back and hashed in this session. */
	done: number
	/** Distinct files the pin's records reference. */
	total: number
	bytesDone: number
	bytesTotal: number
	/** Files that could not be kept (see `failedReason`). */
	failed: number
	/** Why files failed, or null: `quota`, `unavailable`, `integrity` or `error`. */
	failedReason: OfflineFileFailureReason | null
}

/** Why a kept file could not be fetched. */
export type OfflineFileFailureReason = 'quota' | 'unavailable' | 'integrity' | 'error'

/** `handle.status()`: how far one pin is. */
export interface OfflineKeepStatus {
	/**
	 * True when every record the pin matches was delivered (a completion mark covers it) and,
	 * with `files`, every file is present. Re-derived, never read from a stored flag.
	 */
	complete: boolean
	/** Records the pin matches on this device. */
	records: number
	files: OfflineKeepFilesProgress
}

/** A pin held by `app.offline.keep()`. */
export interface OfflineKeepHandle {
	/** Stable: a hash of the collection, the `where` and `files`. Keeping again is idempotent. */
	readonly id: string
	status(): OfflineKeepStatus
	/** Call `listener` whenever the pin's status changes. Returns an unsubscribe function. */
	subscribe(listener: (status: OfflineKeepStatus) => void): () => void
	/** Resolves once the pin is complete; rejects with an `AbortError` when `signal` aborts. */
	whenComplete(options?: { signal?: AbortSignal }): Promise<void>
}

/** One entry of `app.offline.list()`. */
export interface OfflinePinInfo {
	id: string
	collection: string
	where: Record<string, unknown>
	files: boolean
	/** Kept by `keep()` (released by `release()`), as opposed to held only by components. */
	explicit: boolean
	/** Components holding the pin right now, in every open tab. */
	holders: number
	createdAt: number
	/** Wall time the pin was last seen complete (display only; completion is re-derived). */
	completedAt: number | null
}

/** The released form of a component hold (`app.offline.hold()`, used by `useOfflineKeep`). */
export type OfflineKeepRelease = () => Promise<void>

/** The `app.offline` surface for keeping data (structural twin used by the bindings). */
export interface OfflineKeepApi {
	keep(query: OfflineKeepQuery, options?: OfflineKeepOptions): Promise<OfflineKeepHandle>
	release(handle: OfflineKeepHandle | string): Promise<void>
	hold(query: OfflineKeepQuery, options?: OfflineKeepOptions): Promise<OfflineKeepRelease>
	list(): OfflinePinInfo[]
}

/** A pin as stored: the validated shape of a keep request. */
export interface OfflinePinSpec {
	collection: string
	where: Record<string, unknown>
	files: boolean
}

function canonicalValue(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalValue)
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {}
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const inner = (value as Record<string, unknown>)[key]
			// `undefined` has no JSON form; a filter on it matches nothing, like null.
			out[key] = inner === undefined ? null : canonicalValue(inner)
		}
		return out
	}
	return value
}

/**
 * Validate a query for `keep` and reduce it to a pin. A pin is one collection's `where`:
 * `limit`, `offset` and `include` are refused (a pin is a set of records to hold, and a
 * relation would make it span collections), `orderBy` is ignored.
 *
 * @throws OfflineKeepError `OFFLINE_KEEP_UNSUPPORTED_QUERY`
 */
export function toOfflinePinSpec(
	query: OfflineKeepQuery,
	options: OfflineKeepOptions = {},
): OfflinePinSpec {
	const descriptor = query?.getDescriptor?.()
	if (!descriptor || typeof descriptor.collection !== 'string') {
		throw new OfflineKeepError(
			'app.offline.keep() needs a query on one collection, for example app.lessons.where({ courseId }).',
			'OFFLINE_KEEP_UNSUPPORTED_QUERY',
			{ fix: 'Pass a collection query such as app.lessons.where({ courseId }).' },
		)
	}
	const unsupported: string[] = []
	if (descriptor.limit !== undefined) unsupported.push('limit')
	if (descriptor.offset !== undefined) unsupported.push('offset')
	if (descriptor.include !== undefined && descriptor.include.length > 0) unsupported.push('include')
	if (unsupported.length > 0) {
		throw new OfflineKeepError(
			`app.offline.keep() cannot keep a query with ${unsupported.join(', ')} (collection "${descriptor.collection}"): a pin is the set of records a where matches in one collection.`,
			'OFFLINE_KEEP_UNSUPPORTED_QUERY',
			{
				collection: descriptor.collection,
				unsupported,
				fix: 'Remove limit, offset and include, and keep each related collection with its own keep() call.',
			},
		)
	}
	return {
		collection: descriptor.collection,
		where: canonicalValue(descriptor.where ?? {}) as Record<string, unknown>,
		files: options.files === true,
	}
}

/** The canonical text a pin id is the hash of. */
export function canonicalOfflinePinKey(spec: OfflinePinSpec): string {
	return JSON.stringify([spec.collection, canonicalValue(spec.where), spec.files])
}

/**
 * The stable id of a pin: a SHA-256 of its collection, `where` and `files`. The same query
 * always gives the same id, in every tab and every session, which is what makes `keep`
 * idempotent.
 */
export async function offlinePinId(spec: OfflinePinSpec): Promise<string> {
	const bytes = new TextEncoder().encode(canonicalOfflinePinKey(spec))
	return `pin_${(await hashBlob(bytes)).slice(0, 32)}`
}
