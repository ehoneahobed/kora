import { canonicalizeLegacyOperation, canonicalizeProvenLegacyClear } from '@korajs/core'
import type { Operation } from '@korajs/core'

/**
 * `kora_server_meta` key: the stored log's beta.12 clears were made explicit (RT-85).
 */
export const LEGACY_BODIES_META_KEY = 'legacy_bodies_canonical'

/**
 * The stored operations whose body is a beta.12 clear the id PROVES, in their canonical
 * body (every `previousData` key absent from `data` restored as `null`, same id).
 *
 * Every replica folds a stored body as written: the fold has no legacy rule, so a body
 * an earlier release REWROTE under its id (a schema-transformed copy) is never read as a
 * clear (RT-85). A server ingests a protocol-1 upload in this canonical body; operations
 * a beta.12 (or older) server stored before the upgrade are made canonical once by this pass, with
 * the same proof devices apply to their logs, so the server and every device fold the
 * same body.
 *
 * @param stored - Stored update operations that declare no hash version
 * @returns The canonical operations that differ from the stored ones
 */
export async function provenLegacyClears(stored: readonly Operation[]): Promise<Operation[]> {
	const changed: Operation[] = []
	for (const op of stored) {
		if (op.type !== 'update' || op.hashVersion !== undefined || op.encrypted !== undefined) continue
		if (canonicalizeLegacyOperation(op) === op) continue
		const canonical = await canonicalizeProvenLegacyClear(op)
		if (canonical !== op) changed.push(canonical)
	}
	return changed
}
