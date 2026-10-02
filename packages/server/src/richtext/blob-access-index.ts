import { hashBlob, isBlobRef } from '@korajs/core'
import {
	type ScopeMap,
	recordMatchesScopes,
	splitScopeForQuery,
} from '../scopes/server-scope-filter'
import type { ServerStore } from '../store/server-store'
import type { ResolveBlobChunk } from './blob-chunk-relay'

/** How long a scope's referenced-hash set is reused before it is rebuilt. */
export const DEFAULT_BLOB_ACCESS_CACHE_TTL_MS = 5_000
/** Most chunk lists remembered from manifests. */
const MAX_KNOWN_MANIFESTS = 10_000
/** Most blob owners remembered when the store cannot persist them. */
const MAX_MEMORY_BLOB_OWNERS = 100_000
const HEX_HASH = /^[0-9a-f]{64}$/

interface ScopeEntry {
	/** Blob and manifest hashes referenced by live records in the scope. */
	direct: Set<string>
	builtAtMs: number
	/** The invalidation generations this set was built against. */
	stamp: GenerationStamp
}

interface GenerationStamp {
	global: number
	/** Generation of every blob collection the build scanned. */
	collections: Map<string, number>
}

/** Input to {@link BlobAccessIndex.authorizeReference}. */
export interface BlobReferenceRequest {
	/** The content hash (blob, manifest or chunk) the writer wants to reference. */
	hash: string
	/** The writer's download scope, or undefined for an unscoped writer. */
	scopes: ScopeMap | undefined
	/**
	 * Stable ownership key of the writer: the user id for a signed-in principal, the
	 * node-claim owner for an anonymous device, a `kora:route:` key for a scoped route.
	 */
	owner: string
	/** Hashes the written record already references as stored (unchanged references). */
	alreadyReferenced?: ReadonlySet<string>
}

/**
 * Answers "does a live record inside this download scope reference this blob
 * hash?" for the blob relay (RT-1), and "may this writer reference this hash?" at
 * ingest (RT-11).
 *
 * **A content hash is not a secret.** Hashes of well-known content can be computed
 * by anyone, and they travel in records, manifests and logs. So knowing a hash never
 * grants access: a write may reference a hash only when the writer can already read
 * a record that references it, has proven possession of the bytes (pushed them), or
 * is the first to present a hash nobody references, owns or stores (a new blob).
 *
 * A hash is referenced in a scope when a live (not deleted) record in scope has a
 * blob field whose `BlobRef.manifestHash` (or, for a bare reference without a
 * manifest, `BlobRef.hash`) equals it, or when it is a chunk listed in such a manifest and the chunk is unowned or shares an owner with
 * the manifest (so a crafted manifest listing someone else's chunk hashes exposes
 * nothing). Manifests are read through `resolveBlobChunk` (central store) or learned
 * from manifest bytes verified in transit.
 *
 * Cost: the referenced set of a scope is built by a scoped query over every
 * collection that declares a blob field (O(records in scope with blobs)). It is
 * cached per scope, rebuilt after a write to one of the blob collections it scanned
 * ({@link invalidate}) or after `ttlMs` (writes through another server instance),
 * and concurrent lookups for one scope share a single rebuild (RT-17). A full hash
 * index in the store would make this O(1); this is the interim, correctness-first
 * form.
 */
export class BlobAccessIndex {
	private readonly byScope = new Map<string, ScopeEntry>()
	/** Rebuilds in progress per scope key, shared by concurrent lookups (RT-17). */
	private readonly inflight = new Map<
		string,
		{ promise: Promise<Set<string>>; stamp: GenerationStamp }
	>()
	/** manifestHash -> chunk hashes it lists (only from bytes verified against the hash). */
	private readonly manifestChunks = new Map<string, string[]>()
	/** chunkHash -> manifests listing it. */
	private readonly chunkManifests = new Map<string, Set<string>>()
	/** Ownership fallback for stores without blob-owner persistence. */
	private readonly memoryOwners = new Map<string, Set<string>>()
	private globalGeneration = 0
	private readonly collectionGeneration = new Map<string, number>()

	constructor(
		private readonly store: ServerStore,
		private readonly resolveBlobChunk: ResolveBlobChunk | null,
		private readonly ttlMs: number = DEFAULT_BLOB_ACCESS_CACHE_TTL_MS,
	) {}

	/**
	 * Forget cached scope sets because records changed. With `collections`, only sets
	 * built from those collections are dropped (a write to a collection without blob
	 * fields drops nothing); without, every set is dropped (for example writes made
	 * through another server instance).
	 */
	invalidate(collections?: Iterable<string>): void {
		if (collections === undefined) {
			this.globalGeneration += 1
			this.byScope.clear()
			return
		}
		for (const collection of collections) {
			this.collectionGeneration.set(
				collection,
				(this.collectionGeneration.get(collection) ?? 0) + 1,
			)
		}
	}

	/**
	 * True when a live record inside `scopes` references `hash`.
	 *
	 * @param scopes - The session's download scope, or undefined for unscoped
	 * @param hash - The requested content hash
	 */
	async isReferenced(scopes: ScopeMap | undefined, hash: string): Promise<boolean> {
		if (!HEX_HASH.test(hash)) return false
		const direct = await this.directHashes(scopes)
		if (direct.has(hash)) return true
		const manifests = this.chunkManifests.get(hash)
		if (!manifests) return false
		const candidates = [...manifests].filter((manifest) => direct.has(manifest))
		if (candidates.length === 0) return false
		const owners = await this.ownersOf([hash, ...candidates])
		const chunkOwners = owners.get(hash) ?? []
		// An unowned chunk (peer-to-peer mode, nothing pushed) is trusted through any
		// referenced manifest listing it; an owned one only through a manifest that
		// shares an owner, so a crafted manifest cannot reach someone else's chunk.
		if (chunkOwners.length === 0) return true
		return candidates.some((manifest) =>
			(owners.get(manifest) ?? []).some((owner) => chunkOwners.includes(owner)),
		)
	}

	/**
	 * Decide whether a writer may reference `hash` in a blob field (RT-11). Allowed
	 * when the record already referenced it, when a live record inside the writer's
	 * download scope references it, when the writer owns it (pushed the bytes, or
	 * claimed it first), or when nobody references, owns or stores it yet: then the
	 * writer claims it, atomically, so a later forger cannot.
	 */
	async authorizeReference(request: BlobReferenceRequest): Promise<boolean> {
		const { hash, scopes, owner } = request
		if (!HEX_HASH.test(hash)) return false
		if (request.alreadyReferenced?.has(hash)) return true
		if (await this.isReferenced(scopes, hash)) return true
		const owners = (await this.ownersOf([hash])).get(hash) ?? []
		if (owners.includes(owner)) return true
		if (owners.length > 0) return false
		if (scopes !== undefined && (await this.isReferenced(undefined, hash))) return false
		if (await this.heldCentrally(hash)) return false
		return this.claim(hash, owner)
	}

	/**
	 * Record that `owner` pushed bytes verified to hash to `hash` (proof of
	 * possession), and learn the chunk list when the bytes are a manifest.
	 */
	async recordPush(hash: string, bytes: Uint8Array, owner: string): Promise<void> {
		await this.addOwner(hash, owner)
		this.observeVerifiedBytes(hash, bytes)
	}

	/**
	 * When `bytes` are a manifest, true only if the pusher may reference every chunk
	 * it lists (the same rule as {@link authorizeReference}); true for non-manifest
	 * bytes. A manifest listing someone else's chunks is refused before it is stored.
	 */
	async authorizeManifestPush(
		bytes: Uint8Array,
		scopes: ScopeMap | undefined,
		owner: string,
	): Promise<boolean> {
		const chunks = parseManifestChunks(bytes)
		if (!chunks) return true
		for (const chunk of new Set(chunks)) {
			if (!(await this.authorizeReference({ hash: chunk, scopes, owner }))) return false
		}
		return true
	}

	/**
	 * Learn a manifest's chunk list from bytes already verified to hash to `hash`.
	 * Bytes that are not a manifest are ignored. Unowned chunks of an owned manifest
	 * are claimed for the manifest's owner, so a manifest crafted later cannot adopt
	 * them.
	 */
	observeVerifiedBytes(hash: string, bytes: Uint8Array): void {
		if (this.manifestChunks.has(hash)) return
		const chunks = parseManifestChunks(bytes)
		if (!chunks) return
		this.rememberManifest(hash, chunks)
		void this.claimChunksForManifestOwner(hash, chunks).catch(() => {
			// Best effort: an unowned chunk stays reachable only through manifests in scope.
		})
	}

	private async claimChunksForManifestOwner(manifest: string, chunks: string[]): Promise<void> {
		const manifestOwners = (await this.ownersOf([manifest])).get(manifest) ?? []
		const first = manifestOwners[0]
		if (first === undefined) return
		const owners = await this.ownersOf(chunks)
		for (const chunk of new Set(chunks)) {
			if ((owners.get(chunk) ?? []).length === 0) await this.claim(chunk, first)
		}
	}

	private currentStamp(collections: string[]): GenerationStamp {
		return {
			global: this.globalGeneration,
			collections: new Map(collections.map((c) => [c, this.collectionGeneration.get(c) ?? 0])),
		}
	}

	private isCurrent(stamp: GenerationStamp): boolean {
		if (stamp.global !== this.globalGeneration) return false
		for (const [collection, generation] of stamp.collections) {
			if ((this.collectionGeneration.get(collection) ?? 0) !== generation) return false
		}
		return true
	}

	private blobCollections(
		scopes: ScopeMap | undefined,
	): Array<{ collection: string; fields: string[] }> {
		const schema = this.store.getSchema()
		const result: Array<{ collection: string; fields: string[] }> = []
		for (const [collection, definition] of Object.entries(schema?.collections ?? {})) {
			const fields = Object.entries(definition.fields)
				.filter(([, field]) => field.kind === 'blob')
				.map(([name]) => name)
			if (fields.length === 0) continue
			if (scopes && !scopes[collection]) continue
			result.push({ collection, fields })
		}
		return result
	}

	private async directHashes(scopes: ScopeMap | undefined): Promise<Set<string>> {
		const partitionKey = scopes ? stableKey(scopes) : '*'
		const collections = this.blobCollections(scopes)
		const cached = this.byScope.get(partitionKey)
		if (cached && this.isCurrent(cached.stamp) && Date.now() - cached.builtAtMs < this.ttlMs) {
			return cached.direct
		}
		const running = this.inflight.get(partitionKey)
		if (running && this.isCurrent(running.stamp)) return running.promise

		const stamp = this.currentStamp(collections.map((c) => c.collection))
		const promise = this.build(scopes, collections)
		const entry = { promise, stamp }
		this.inflight.set(partitionKey, entry)
		try {
			const direct = await promise
			// Only cache a set nothing invalidated while it was being built.
			if (this.isCurrent(stamp)) {
				this.byScope.set(partitionKey, { direct, builtAtMs: Date.now(), stamp })
			}
			return direct
		} finally {
			if (this.inflight.get(partitionKey) === entry) this.inflight.delete(partitionKey)
		}
	}

	private async build(
		scopes: ScopeMap | undefined,
		collections: Array<{ collection: string; fields: string[] }>,
	): Promise<Set<string>> {
		const direct = new Set<string>()
		const manifests: string[] = []
		for (const { collection, fields } of collections) {
			const collectionScope = scopes ? (scopes[collection] ?? {}) : {}
			const { equality } = splitScopeForQuery(collectionScope)
			const rows = await this.store.queryCollection(collection, { where: equality })
			for (const row of rows) {
				if (row._deleted === 1 || row._deleted === true) continue
				if (scopes && !recordMatchesScopes(collection, row, scopes)) continue
				for (const field of fields) {
					const ref = asBlobRef(row[field])
					if (!ref) continue
					for (const hash of referencedHashes(ref)) direct.add(hash)
					if (ref.manifestHash) manifests.push(ref.manifestHash)
				}
			}
		}
		await this.loadManifests(manifests)
		return direct
	}

	/** Read unknown manifests from the central store, verifying them against their hash. */
	private async loadManifests(manifestHashes: string[]): Promise<void> {
		if (!this.resolveBlobChunk) return
		for (const manifestHash of manifestHashes) {
			if (this.manifestChunks.has(manifestHash)) continue
			let bytes: Uint8Array | null = null
			try {
				bytes = await this.resolveBlobChunk(manifestHash)
			} catch {
				bytes = null
			}
			if (bytes === null) continue
			if ((await hashBlob(bytes)) !== manifestHash) continue
			this.observeVerifiedBytes(manifestHash, bytes)
		}
	}

	private async heldCentrally(hash: string): Promise<boolean> {
		if (!this.resolveBlobChunk) return false
		try {
			return (await this.resolveBlobChunk(hash)) !== null
		} catch {
			// Unknown: fail closed.
			return true
		}
	}

	private async ownersOf(hashes: string[]): Promise<Map<string, string[]>> {
		if (this.store.getBlobOwners) return this.store.getBlobOwners(hashes)
		const result = new Map<string, string[]>()
		for (const hash of hashes) result.set(hash, [...(this.memoryOwners.get(hash) ?? [])])
		return result
	}

	private async addOwner(hash: string, owner: string): Promise<void> {
		if (this.store.recordBlobOwner) {
			await this.store.recordBlobOwner(hash, owner)
			return
		}
		this.rememberMemoryOwner(hash, owner)
	}

	private async claim(hash: string, owner: string): Promise<boolean> {
		if (this.store.claimBlobIfUnowned) return this.store.claimBlobIfUnowned(hash, owner)
		const owners = this.memoryOwners.get(hash)
		if (owners && owners.size > 0) return owners.has(owner)
		this.rememberMemoryOwner(hash, owner)
		return true
	}

	private rememberMemoryOwner(hash: string, owner: string): void {
		let owners = this.memoryOwners.get(hash)
		if (!owners) {
			if (this.memoryOwners.size >= MAX_MEMORY_BLOB_OWNERS) {
				const oldest = this.memoryOwners.keys().next().value
				if (oldest !== undefined) this.memoryOwners.delete(oldest)
			}
			owners = new Set()
			this.memoryOwners.set(hash, owners)
		}
		owners.add(owner)
	}

	private rememberManifest(manifestHash: string, chunks: string[]): void {
		if (this.manifestChunks.size >= MAX_KNOWN_MANIFESTS) {
			const oldest = this.manifestChunks.keys().next().value
			if (oldest !== undefined) this.forgetManifest(oldest)
		}
		this.manifestChunks.set(manifestHash, chunks)
		for (const chunk of chunks) {
			let owners = this.chunkManifests.get(chunk)
			if (!owners) {
				owners = new Set()
				this.chunkManifests.set(chunk, owners)
			}
			owners.add(manifestHash)
		}
	}

	private forgetManifest(manifestHash: string): void {
		for (const chunk of this.manifestChunks.get(manifestHash) ?? []) {
			const owners = this.chunkManifests.get(chunk)
			owners?.delete(manifestHash)
			if (owners && owners.size === 0) this.chunkManifests.delete(chunk)
		}
		this.manifestChunks.delete(manifestHash)
	}
}

/** Deterministic key for a scope map (sorted keys at every level). */
function stableKey(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`)
			.join(',')}}`
	}
	return JSON.stringify(value) ?? 'undefined'
}

/**
 * The content hashes a blob reference makes readable. A reference with a manifest
 * is read through the manifest (then its chunks), never by the whole-blob hash, so
 * only `manifestHash` counts: the whole-blob `hash` cannot be verified against the
 * manifest without reassembling every chunk, and must not act as a capability for
 * whatever content hashes to it. A bare reference (no manifest) is read by `hash`.
 *
 * @param ref - A blob reference
 * @returns The hashes a reader of the reference may request
 */
export function referencedHashes(ref: { hash: string; manifestHash?: string }): string[] {
	return ref.manifestHash ? [ref.manifestHash] : [ref.hash]
}

/**
 * The blob reference a field value holds (a `BlobRef`, or its JSON string as some
 * stores keep it), or null.
 */
export function asBlobRef(value: unknown): { hash: string; manifestHash?: string } | null {
	let candidate = value
	if (typeof candidate === 'string') {
		try {
			candidate = JSON.parse(candidate)
		} catch {
			return null
		}
	}
	return isBlobRef(candidate) ? candidate : null
}

/** The chunk hashes of a canonical blob manifest, or null when the bytes are not one. */
export function parseManifestChunks(bytes: Uint8Array): string[] | null {
	if (bytes.byteLength > 4 * 1024 * 1024) return null
	let parsed: unknown
	try {
		parsed = JSON.parse(new TextDecoder().decode(bytes))
	} catch {
		return null
	}
	if (typeof parsed !== 'object' || parsed === null) return null
	const chunkHashes = (parsed as { chunkHashes?: unknown }).chunkHashes
	if (!Array.isArray(chunkHashes)) return null
	if (!chunkHashes.every((h): h is string => typeof h === 'string' && HEX_HASH.test(h))) return null
	return chunkHashes
}
