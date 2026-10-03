import {
	canonicalizeLegacyOperation,
	canonicalizeProvenLegacyClear,
	quoteIdent,
} from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { deserializeOperationWithCollection, serializeOperation } from '../serialization/serializer'
import type { OperationRow, StorageAdapter } from '../types'

/** `_kora_meta` key: the op log's legacy bodies were made canonical (RT-83, RT-85). */
export const LEGACY_BODIES_META_KEY = 'legacy_bodies_canonical'

/** A log row rewritten into its canonical legacy body. */
export interface CanonicalizedLegacyBody {
	collection: string
	recordId: string
}

/**
 * Make every genuine beta.13 clear in the operation log explicit, once per database
 * (RT-83, RT-85).
 *
 * beta.13 applied `update(id, { field: undefined })` as a clear, hashed the member as
 * `null`, and logged JSON without it. Every later replica folds a stored body as
 * written (the fold has no legacy rule: a body a schema transform rewrote must never be
 * read as a clear), so the clear is written into the logged body here, where its
 * provenance is known:
 * - this device's own operations that declare no hash version were written by its
 *   beta.13 self (beta.14 always declares version 2): a `previousData` key absent from
 *   `data` is always such a clear;
 * - any other node's undeclared update is rewritten only when its id PROVES the clear
 *   (`canonicalizeProvenLegacyClear`), as on inbound delivery.
 * The restored body has the same id: version 1 hashes `undefined` and `null` alike.
 *
 * @param adapter - The storage adapter
 * @param schema - The schema (collections with a log)
 * @param ownNodeId - This device's node id
 * @returns The rewritten rows' records (to re-fold)
 */
export async function canonicalizeLegacyLogBodies(
	adapter: StorageAdapter,
	schema: SchemaDefinition,
	ownNodeId: string,
): Promise<CanonicalizedLegacyBody[]> {
	const rewritten: CanonicalizedLegacyBody[] = []
	for (const collection of Object.keys(schema.collections)) {
		const table = quoteIdent(`_kora_ops_${collection}`)
		const rows = await adapter.query<OperationRow>(
			`SELECT * FROM ${table} WHERE type = 'update' AND previous_data IS NOT NULL`,
		)
		const updates: Array<{ id: string; data: string | null }> = []
		for (const row of rows) {
			let op: Operation
			try {
				op = deserializeOperationWithCollection(row, collection)
			} catch {
				// An unreadable row is the log-integrity scan's business, not this one's.
				continue
			}
			if (op.hashVersion === 2 || canonicalizeLegacyOperation(op) === op) continue
			const canonical =
				op.nodeId === ownNodeId
					? canonicalizeLegacyOperation(op)
					: await canonicalizeProvenLegacyClear(op)
			if (canonical === op) continue
			updates.push({ id: op.id, data: serializeOperation(canonical).data })
			rewritten.push({ collection, recordId: op.recordId })
		}
		if (updates.length === 0) continue
		await adapter.transaction(async (tx) => {
			for (const update of updates) {
				await tx.execute(`UPDATE ${table} SET data = ? WHERE id = ?`, [update.data, update.id])
			}
		})
	}
	return rewritten
}
