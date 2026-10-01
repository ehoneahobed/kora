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
const HEX_HASH = /^[0-9a-f]{64}$/

interface ScopeEntry {
	/** Blob and manifest hashes referenced by live records in the scope. */
	direct: Set<string>
	builtAtMs: number
	generation: number
}

/**
 * Answers "does a live record inside this download scope reference this blob
 * hash?" for the blob relay (RT-1).
 *
 * A hash is referenced when a live (not deleted) record in scope has a blob field
 * whose `BlobRef.hash` or `BlobRef.manifestHash` equals it, or when it is a chunk
 * hash listed in such a manifest. Manifests are read through `resolveBlobChunk`
 * (central store) or learned from manifest bytes the relay verified in transit.
 *
 * Cost: the referenced set of a scope is built by a scoped query over every
 * collection that declares a blob field (O(records in scope with blobs)). It is
 * cached per scope and rebuilt after any local write ({@link invalidate}) or after
 * `ttlMs` (writes through another server instance). A full hash index in the store
 * would make this O(1); this is the interim, correctness-first form.
 */
export class BlobAccessIndex {
	private readonly byScope = new Map<string, ScopeEntry>()
	/** manifestHash -> chunk hashes it lists (only from bytes verified against the hash). */
	private readonly manifestChunks = new Map<string, string[]>()
	/** chunkHash -> manifests listing it. */
	private readonly chunkManifests = new Map<string, Set<string>>()
	private generation = 0

	constructor(
		private readonly store: ServerStore,
		private readonly resolveBlobChunk: ResolveBlobChunk | null,
		private readonly ttlMs: number = DEFAULT_BLOB_ACCESS_CACHE_TTL_MS,
	) {}

	/** Forget cached scope sets: records changed. */
	invalidate(): void {
		this.generation += 1
		this.byScope.clear()
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
		for (const manifest of manifests) {
			if (direct.has(manifest)) return true
		}
		return false
	}

	/**
	 * Learn a manifest's chunk list from bytes already verified to hash to `hash`.
	 * Bytes that are not a manifest are ignored.
	 */
	observeVerifiedBytes(hash: string, bytes: Uint8Array): void {
		if (this.manifestChunks.has(hash)) return
		const chunks = parseManifestChunks(bytes)
		if (chunks) this.rememberManifest(hash, chunks)
	}

	private async directHashes(scopes: ScopeMap | undefined): Promise<Set<string>> {
		const partitionKey = scopes ? stableKey(scopes) : '*'
		const cached = this.byScope.get(partitionKey)
		if (
			cached &&
			cached.generation === this.generation &&
			Date.now() - cached.builtAtMs < this.ttlMs
		) {
			return cached.direct
		}
		const generation = this.generation
		const direct = new Set<string>()
		const manifests: string[] = []
		const schema = this.store.getSchema()
		for (const [collection, definition] of Object.entries(schema?.collections ?? {})) {
			const blobFields = Object.entries(definition.fields)
				.filter(([, field]) => field.kind === 'blob')
				.map(([name]) => name)
			if (blobFields.length === 0) continue
			const collectionScope = scopes ? scopes[collection] : {}
			if (!collectionScope) continue
			const { equality } = splitScopeForQuery(collectionScope)
			const rows = await this.store.queryCollection(collection, { where: equality })
			for (const row of rows) {
				if (row._deleted === 1 || row._deleted === true) continue
				if (scopes && !recordMatchesScopes(collection, row, scopes)) continue
				for (const field of blobFields) {
					const ref = asBlobRef(row[field])
					if (!ref) continue
					direct.add(ref.hash)
					if (ref.manifestHash) {
						direct.add(ref.manifestHash)
						manifests.push(ref.manifestHash)
					}
				}
			}
		}
		await this.loadManifests(manifests)
		// Only cache a set built against the current generation.
		if (generation === this.generation) {
			this.byScope.set(partitionKey, { direct, builtAtMs: Date.now(), generation })
		}
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

function asBlobRef(value: unknown): { hash: string; manifestHash?: string } | null {
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
function parseManifestChunks(bytes: Uint8Array): string[] | null {
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
