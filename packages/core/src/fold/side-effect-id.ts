import { OperationError } from '../errors/errors'
import { canonicalize } from '../operations/content-hash'

/** Domain tag for derived side-effect ids, so they can never collide with a content hash. */
const SIDE_EFFECT_DOMAIN = 'kora/side-effect/v1'

/**
 * Deterministic id for a side-effect operation (a referential cascade, a
 * set-null, a constraint correction) generated while applying `parentOpId`.
 *
 * Every replica that applies the same parent operation and generates the same
 * effect on the same record derives the same id, so the effect is stored once and
 * deduplicates everywhere instead of multiplying (one copy per replica) and racing
 * (W7 step 3). Cascades keep working offline: a client derives the same id the
 * server will.
 *
 * Callers must also make the side-effect's CONTENT deterministic (timestamp and
 * data derived from the parent), because dedup by id keeps whichever copy arrives
 * first. Ids are SHA-256 over canonical JSON of
 * `{ domain, parent, rule, target }`, hex encoded.
 *
 * @param parentOpId - Id of the operation whose application produced the effect
 * @param ruleId - Stable id of the rule (for example `relation:<name>:cascade`)
 * @param targetRecordId - Id of the record the effect writes
 * @returns 64-char hex id
 */
export async function deriveSideEffectOpId(
	parentOpId: string,
	ruleId: string,
	targetRecordId: string,
): Promise<string> {
	for (const [name, value] of [
		['parentOpId', parentOpId],
		['ruleId', ruleId],
		['targetRecordId', targetRecordId],
	] as const) {
		if (typeof value !== 'string' || value.length === 0) {
			throw new OperationError(`deriveSideEffectOpId: ${name} must be a non-empty string`, {
				[name]: value,
			})
		}
	}
	const canonical = canonicalize({
		domain: SIDE_EFFECT_DOMAIN,
		parent: parentOpId,
		rule: ruleId,
		target: targetRecordId,
	})
	const digest = await globalThis.crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(canonical),
	)
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}
