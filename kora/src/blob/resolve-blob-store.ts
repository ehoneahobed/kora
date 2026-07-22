import { type ContentAddressedBlobStore, MemoryBlobStore, createOpfsBlobStore } from '@korajs/store'
import type { BlobOptions } from '../types'

/** Whether the current environment exposes the Origin Private File System. */
function opfsAvailable(): boolean {
	const nav = (globalThis as { navigator?: { storage?: { getDirectory?: unknown } } }).navigator
	return typeof nav?.storage?.getDirectory === 'function'
}

/**
 * Resolve the content-addressed blob store for an app.
 *
 * Selection order: an explicitly configured store wins; otherwise OPFS in the
 * browser (durable across reloads); otherwise an in-memory store. A browser that
 * advertises OPFS but fails to open it falls back to memory with a warning rather
 * than failing app startup, mirroring how the SQLite adapter degrades.
 *
 * @param config - The blob configuration (may provide a custom store)
 * @param dbName - The app database name, used to namespace the OPFS blob directory
 */
export async function resolveBlobStore(
	config: BlobOptions | undefined,
	dbName: string,
): Promise<ContentAddressedBlobStore> {
	if (config?.store) {
		return config.store
	}
	if (opfsAvailable()) {
		try {
			return await createOpfsBlobStore(`${dbName}-blobs`)
		} catch (error) {
			console.warn(
				`[kora] OPFS blob storage was advertised but could not be opened; falling back to in-memory blob storage (blobs will not persist across reloads). ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
			return new MemoryBlobStore()
		}
	}
	return new MemoryBlobStore()
}
