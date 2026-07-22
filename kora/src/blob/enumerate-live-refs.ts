import type { BlobRef, SchemaDefinition } from '@korajs/core'
import { type Store, extractBlobRefs } from '@korajs/store'

/**
 * Collect every {@link BlobRef} still reachable from live records in the local
 * store. Only collections that declare a `blob` field are scanned. This is the
 * live set garbage collection retains; anything in the blob store not reachable
 * from here is collectable.
 *
 * @param store - The local record store
 * @param schema - The app schema (used to find collections with blob fields)
 */
export async function enumerateLiveBlobRefs(
	store: Store,
	schema: SchemaDefinition,
): Promise<BlobRef[]> {
	const refs: BlobRef[] = []
	for (const [name, collection] of Object.entries(schema.collections)) {
		const hasBlobField = Object.values(collection.fields).some((field) => field.kind === 'blob')
		if (!hasBlobField) {
			continue
		}
		const records = await store.collection(name).where({}).exec()
		for (const record of records) {
			refs.push(...extractBlobRefs(record as Record<string, unknown>))
		}
	}
	return refs
}
