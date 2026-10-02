import { type BlobRef, type KoraEventEmitter, isBlobRef } from '@korajs/core'
import { type ContentAddressedBlobStore, parseBlobManifest } from '@korajs/store'
import type { SyncEngine } from '@korajs/sync'

/** Collect the blob references (with a manifest) carried by an operation's data. */
function blobRefsInData(data: Record<string, unknown> | null): BlobRef[] {
	if (!data) {
		return []
	}
	const refs: BlobRef[] = []
	for (const value of Object.values(data)) {
		if (isBlobRef(value) && value.manifestHash !== undefined) {
			refs.push(value)
		}
	}
	return refs
}

/**
 * Upload a single blob (its manifest and every chunk) to the server so the bytes
 * remain available after this device disconnects. Reads the already-staged bytes
 * from the local blob store; skips anything the store does not hold.
 */
async function uploadBlob(
	ref: BlobRef,
	syncEngine: SyncEngine,
	blobStore: ContentAddressedBlobStore,
): Promise<void> {
	const manifestHash = ref.manifestHash
	if (manifestHash === undefined) {
		return
	}
	const manifestBytes = await blobStore.get(manifestHash)
	if (manifestBytes === null) {
		return
	}
	// Upload chunks first so the manifest a peer resolves is never dangling.
	const manifest = parseBlobManifest(manifestBytes)
	const seen = new Set<string>()
	for (const chunkHash of manifest.chunkHashes) {
		if (seen.has(chunkHash)) {
			continue
		}
		seen.add(chunkHash)
		const bytes = await blobStore.get(chunkHash)
		if (bytes !== null) {
			syncEngine.uploadBlobChunk(chunkHash, bytes)
		}
	}
	syncEngine.uploadBlobChunk(manifestHash, manifestBytes)
}

/**
 * Automatically upload the bytes behind `blob` fields to the server as their
 * operations are synced. The bytes (every chunk, then the manifest) are pushed
 * BEFORE the batch carrying the reference, on the same connection: the server only
 * accepts a reference to content the writer can already read or has uploaded, so
 * pushing first is the writer's proof of possession (RT-11). A blob authored offline
 * is uploaded when its operation is finally pushed on reconnect. Each blob is
 * uploaded once per sync engine (deduplicated by manifest hash).
 *
 * A no-op unless the connected server advertised central blob storage or asked for
 * proofs of possession (peer-relay mode, RT-23).
 *
 * @returns An unsubscribe function.
 */
export function wireBlobUpload(
	_emitter: KoraEventEmitter,
	syncEngine: SyncEngine,
	blobStore: ContentAddressedBlobStore,
): () => void {
	const uploaded = new Set<string>()
	return syncEngine.setOutboundPreparer(async (operations) => {
		// Central storage keeps the bytes; a peer-relay server only verifies them as
		// proof of possession before it accepts the reference (RT-23).
		if (!syncEngine.isBlobStorageEnabled() && !syncEngine.isBlobPossessionProofRequested()) {
			return
		}
		for (const op of operations) {
			for (const ref of blobRefsInData(op.data)) {
				const manifestHash = ref.manifestHash
				if (manifestHash === undefined || uploaded.has(manifestHash)) {
					continue
				}
				try {
					await uploadBlob(ref, syncEngine, blobStore)
					uploaded.add(manifestHash)
				} catch {
					// Upload is best-effort; a failure leaves the blob to be served
					// peer-to-peer, and the next batch carrying it retries the upload.
				}
			}
		}
	})
}
