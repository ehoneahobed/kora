import { KoraError } from '@korajs/core'
import type { SchemaDefinition } from '@korajs/core'

/** The part of the sync encryption config that decides what the server can read. */
export interface EncryptedRelationConfig {
	enabled?: boolean
	cleartextFields?: Readonly<Record<string, readonly string[]>>
}

/**
 * Thrown at app initialization when end-to-end encryption would seal the foreign-key
 * field of a relation with a referential `onDelete` policy.
 */
export class SealedRelationFieldError extends KoraError {
	constructor(
		message: string,
		public readonly relation: string,
		public readonly collection: string,
		public readonly field: string,
	) {
		super(message, 'SEALED_RELATION_FIELD', {
			relation,
			collection,
			field,
			fix: `Add "${field}" to sync.encryption.cleartextFields.${collection}.`,
		})
		this.name = 'SealedRelationFieldError'
	}
}

/**
 * Refuse a configuration where end-to-end encryption seals the foreign key of a
 * relation whose `onDelete` is `cascade`, `set-null` or `restrict`.
 *
 * Referential policies are enforced by the sync server, the one replica that sees every
 * child: it cascades (or nulls, or refuses) for children no single device knows about,
 * and relays the result. It can only do so when it can read the foreign key. With the
 * key sealed, no replica can enforce the policy for everyone, and every device-side
 * substitute either loses a cascade or deletes a child another device moved away
 * (RT-74, RT-78, RT-82). So the foreign key of such a relation must travel in cleartext:
 * it reveals which parent a child belongs to, never the child's other fields.
 *
 * Relations with `onDelete: 'no-action'` (or none) are not affected: nothing is
 * enforced on delete, so their foreign key may stay sealed.
 *
 * @param schema - The app schema
 * @param encryption - The sync encryption config (none, or disabled: nothing to check)
 * @throws {SealedRelationFieldError} Naming the relation, the field and the fix
 */
export function validateEncryptedRelations(
	schema: SchemaDefinition,
	encryption: EncryptedRelationConfig | null | undefined,
): void {
	if (!encryption || encryption.enabled !== true) return
	for (const [name, relation] of Object.entries(schema.relations ?? {})) {
		const policy = relation.onDelete
		if (policy !== 'cascade' && policy !== 'set-null' && policy !== 'restrict') continue
		const cleartext = encryption.cleartextFields?.[relation.from] ?? []
		if (cleartext.includes(relation.field)) continue
		throw new SealedRelationFieldError(
			`Relation "${name}" (${relation.from}.${relation.field} -> ${relation.to}, onDelete: '${policy}') needs its foreign key in cleartext under end-to-end sync encryption: the sync server enforces '${policy}' for every device and cannot read a sealed "${relation.field}". Add it to sync.encryption.cleartextFields: { ${relation.from}: ['${relation.field}'] } (the server then sees which ${relation.to} record each ${relation.from} record belongs to, nothing else), or set onDelete: 'no-action'.`,
			name,
			relation.from,
			relation.field,
		)
	}
}
