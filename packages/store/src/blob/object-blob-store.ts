import {
	type BlobRef,
	type BlobRefMetadata,
	KoraError,
	createBlobRef,
	hashBlob,
} from '@korajs/core'
import { BlobIntegrityError, type ContentAddressedBlobStore } from './content-addressed-blob-store'

/** Hashes can arrive from clients. Only this shape is ever turned into a key, so none can escape the store. */
const CONTENT_HASH = /^[a-f0-9]{64}$/
const DEFAULT_MAX_ATTEMPTS = 5
const RETRY_BASE_MS = 250
const REQUEST_TIMEOUT_MS = 60_000

export class ObjectStoreError extends KoraError {
	constructor(
		message: string,
		public readonly status: number | null,
	) {
		super(message, 'OBJECT_STORE_ERROR', { status })
	}
}

export interface ObjectProperties {
	readonly etag: string
	readonly bytes: number
	readonly writtenAt: number
}

/**
 * The few operations a cloud object store must offer. Everything that decides whether data is safe
 * lives in {@link ObjectBlobStore}, so a new provider is only this translation.
 */
export interface ObjectStorageBackend {
	/** Where the bytes live, for logs. Must not contain a credential. */
	readonly location: string
	/** Writes atomically unless the key exists, and must never replace existing bytes. */
	putIfAbsent(key: string, bytes: Uint8Array): Promise<'created' | 'exists'>
	/** Makes an existing object count as just written. */
	touch(key: string): Promise<void>
	head(key: string): Promise<ObjectProperties | null>
	get(key: string): Promise<Uint8Array | null>
	/** With `ifEtag`, deletes only that exact version. False when the condition failed. */
	delete(key: string, ifEtag?: string): Promise<boolean>
	list(): Promise<readonly { readonly key: string; readonly bytes: number }[]>
}

/**
 * A durable {@link ContentAddressedBlobStore} on any object store.
 *
 * Objects use the `<hash[0:2]>/<hash>` layout of the filesystem store, so a store moves between
 * providers by copying paths. Reads verify the bytes hash to the requested key. Beyond the base
 * contract it reports write times and total bytes, which a server needs to bound the store and
 * collect unreferenced content safely.
 */
export class ObjectBlobStore implements ContentAddressedBlobStore {
	readonly durable = true
	readonly location: string
	private totalCache: number | null = null
	private capacityQueue: Promise<unknown> = Promise.resolve()

	constructor(private readonly backend: ObjectStorageBackend) {
		this.location = backend.location
	}

	async put(bytes: Uint8Array, metadata: BlobRefMetadata = {}): Promise<BlobRef> {
		const ref = await createBlobRef(bytes, metadata)
		await this.write(ref.hash, bytes)
		return ref
	}

	/**
	 * {@link put}, unless the content is new and would take the store past `maxTotalBytes`. Serialized
	 * within this process. Separate processes can overshoot by what they upload at the same moment.
	 */
	putWithinCapacity(
		bytes: Uint8Array,
		maxTotalBytes: number,
	): Promise<'stored' | 'refreshed' | 'full'> {
		const run = this.capacityQueue.then(async () => {
			const hash = await hashBlob(bytes)
			if (!(await this.has(hash)) && (await this.totalBytes()) + bytes.byteLength > maxTotalBytes) {
				return 'full' as const
			}
			return this.write(hash, bytes)
		})
		this.capacityQueue = run.catch(() => undefined)
		return run
	}

	async get(hash: string): Promise<Uint8Array | null> {
		if (!CONTENT_HASH.test(hash)) return null
		const bytes = await this.backend.get(keyFor(hash))
		if (!bytes) return null
		const actual = await hashBlob(bytes)
		if (actual !== hash) throw new BlobIntegrityError(hash, actual)
		return bytes
	}

	async has(hash: string): Promise<boolean> {
		return (await this.properties(hash)) !== null
	}

	async delete(hash: string): Promise<boolean> {
		const known = await this.properties(hash)
		if (!known || !(await this.backend.delete(keyFor(hash)))) return false
		this.adjustTotal(-known.bytes)
		return true
	}

	/** When the bytes behind `hash` were last written or uploaded again, in ms, or null when absent. */
	async lastWrittenAt(hash: string): Promise<number | null> {
		return (await this.properties(hash))?.writtenAt ?? null
	}

	/** Deletes only if not written since `cutoffMs`. A re-upload racing the delete wins. */
	async deleteIfWrittenBefore(hash: string, cutoffMs: number): Promise<boolean> {
		const known = await this.properties(hash)
		if (!known || known.writtenAt >= cutoffMs) return false
		if (!(await this.backend.delete(keyFor(hash), known.etag))) return false
		this.adjustTotal(-known.bytes)
		return true
	}

	async size(): Promise<number> {
		return (await this.backend.list()).length
	}

	async list(): Promise<string[]> {
		return (await this.backend.list()).map(({ key }) => key.slice(key.lastIndexOf('/') + 1))
	}

	async totalBytes(): Promise<number> {
		if (this.totalCache === null) {
			this.totalCache = (await this.backend.list()).reduce((sum, entry) => sum + entry.bytes, 0)
		}
		return this.totalCache
	}

	private async write(hash: string, bytes: Uint8Array): Promise<'stored' | 'refreshed'> {
		if ((await this.backend.putIfAbsent(keyFor(hash), bytes)) === 'created') {
			this.adjustTotal(bytes.byteLength)
			return 'stored'
		}
		// Garbage collection spares recent uploads, so an upload of existing content must count as one.
		await this.backend.touch(keyFor(hash))
		return 'refreshed'
	}

	private async properties(hash: string): Promise<ObjectProperties | null> {
		return CONTENT_HASH.test(hash) ? this.backend.head(keyFor(hash)) : null
	}

	private adjustTotal(delta: number): void {
		if (this.totalCache !== null) this.totalCache += delta
	}
}

function keyFor(hash: string): string {
	return `${hash.slice(0, 2)}/${hash}`
}

export interface RetryOptions {
	readonly fetch?: typeof globalThis.fetch
	readonly maxAttempts?: number
	readonly sleep?: (ms: number) => Promise<void>
}

/** Sends a request, retrying what is safe to retry. `prepare` runs per attempt so signatures stay fresh. */
export async function sendWithRetry(
	url: string,
	prepare: () => Promise<RequestInit>,
	options: RetryOptions = {},
): Promise<Response> {
	const send = options.fetch ?? globalThis.fetch
	const attempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
	let failure: unknown
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		try {
			const init = await prepare()
			const response = await send(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
			if (response.status !== 408 && response.status !== 429 && response.status < 500)
				return response
			failure = new ObjectStoreError(
				`The object store returned ${response.status}`,
				response.status,
			)
			await response.body?.cancel()
		} catch (error) {
			// A status of null means configuration is wrong, which no retry will fix.
			if (error instanceof ObjectStoreError && error.status === null) throw error
			failure = error
		}
		if (attempt < attempts) await sleep(RETRY_BASE_MS * 2 ** (attempt - 1))
	}
	throw failure
}
