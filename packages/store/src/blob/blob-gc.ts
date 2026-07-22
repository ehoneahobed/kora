import { type BlobRef, isBlobRef } from '@korajs/core'
import { parseBlobManifest } from './blob-manifest-transfer'
import type { ContentAddressedBlobStore } from './content-addressed-blob-store'

/** Outcome of a blob garbage-collection sweep. */
export interface BlobGcResult {
	/** Total distinct blobs held before the sweep. */
	scanned: number
	/** Distinct hashes kept because a live reference points to them (blob, manifest, or chunk). */
	live: number
	/** Number of blobs deleted (or, with `dryRun`, that would be deleted). */
	collected: number
	/** The hashes deleted (or, with `dryRun`, that would be deleted). */
	collectedHashes: string[]
}

/** Options for {@link collectBlobGarbage}. */
export interface BlobGcOptions {
	/** Compute what would be collected without deleting anything. */
	dryRun?: boolean
}

/**
 * Extract the {@link BlobRef}s referenced by a materialized record. Scans the
 * record's top-level field values, so it works without the schema; a `blob`
 * field simply holds a `BlobRef`.
 */
export function extractBlobRefs(record: Record<string, unknown>): BlobRef[] {
	const refs: BlobRef[] = []
	for (const value of Object.values(record)) {
		if (isBlobRef(value)) {
			refs.push(value)
		}
	}
	return refs
}

/**
 * Garbage-collect a content-addressed blob store by mark-and-sweep: keep every
 * blob reachable from a live reference, delete the rest.
 *
 * The live set is closed over the reference graph — for each live {@link BlobRef}
 * it retains the blob hash, the manifest hash, and every chunk hash named in that
 * manifest. Because chunks (and blobs) are shared by content address, a chunk
 * referenced by any surviving blob is retained even if another blob that used it
 * was collected. This makes GC safe under deduplication.
 *
 * Mark-and-sweep (rather than reference counting) is deliberate: counts are
 * fragile under concurrent edits and CRDT merges, whereas a sweep against the
 * current live set is always correct for the state it observes. Run it
 * periodically or on demand.
 *
 * A manifest that cannot be read or parsed (corruption) contributes no chunk
 * hashes; its own hash still counts as live. The blob it describes is already
 * unusable, so its chunks becoming collectable is acceptable, and GC never
 * throws on a single bad manifest.
 *
 * @param store - The blob store to sweep
 * @param liveRefs - Every reference still reachable from live records
 * @param options - `dryRun` to report without deleting
 */
export async function collectBlobGarbage(
	store: ContentAddressedBlobStore,
	liveRefs: Iterable<BlobRef>,
	options: BlobGcOptions = {},
): Promise<BlobGcResult> {
	const live = new Set<string>()
	for (const ref of liveRefs) {
		live.add(ref.hash)
		if (ref.manifestHash === undefined) {
			continue
		}
		live.add(ref.manifestHash)
		try {
			const manifestBytes = await store.get(ref.manifestHash)
			if (manifestBytes !== null) {
				const manifest = parseBlobManifest(manifestBytes)
				for (const chunkHash of manifest.chunkHashes) {
					live.add(chunkHash)
				}
			}
		} catch {
			// A corrupt/unreadable manifest contributes no chunk hashes; the blob is
			// already broken. Never abort the whole sweep for one bad manifest.
		}
	}

	const all = await store.list()
	const collectedHashes: string[] = []
	for (const hash of all) {
		if (live.has(hash)) {
			continue
		}
		collectedHashes.push(hash)
		if (!options.dryRun) {
			await store.delete(hash)
		}
	}

	return {
		scanned: all.length,
		live: live.size,
		collected: collectedHashes.length,
		collectedHashes,
	}
}
