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
 * operations are synced. Triggered on `sync:sent`, so a blob authored offline is
 * uploaded when its operation is finally pushed on reconnect — the same event
 * that makes the reference visible to other devices. Each blob is uploaded once
 * per session (deduplicated by manifest hash).
 *
 * A no-op unless the connected server advertised central blob storage.
 *
 * @returns An unsubscribe function.
 */
export function wireBlobUpload(
	emitter: KoraEventEmitter,
	syncEngine: SyncEngine,
	blobStore: ContentAddressedBlobStore,
): () => void {
	const uploaded = new Set<string>()
	return emitter.on('sync:sent', (event) => {
		if (!syncEngine.isBlobStorageEnabled()) {
			return
		}
		for (const op of event.operations) {
			for (const ref of blobRefsInData(op.data)) {
				const manifestHash = ref.manifestHash
				if (manifestHash === undefined || uploaded.has(manifestHash)) {
					continue
				}
				uploaded.add(manifestHash)
				void uploadBlob(ref, syncEngine, blobStore).catch(() => {
					// Upload is best-effort; a failure just means the blob is served
					// peer-to-peer until a later successful upload. Allow a retry.
					uploaded.delete(manifestHash)
				})
			}
		}
	})
}
