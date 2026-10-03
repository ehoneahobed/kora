import type { SchemaDefinition } from '@korajs/core'

/** The part of the sync encryption config that decides what the server can read. */
export interface SealedRelationEncryption {
	enabled?: boolean
	cleartextFields?: Readonly<Record<string, readonly string[]>>
}

/**
 * The relations the sync server cannot cascade (RT-74): with end-to-end encryption
 * enabled, a cascade / set-null relation whose field is not listed in the child
 * collection's `cleartextFields` is sealed, so the server never sees which children
 * reference a deleted parent. Devices cascade those themselves.
 *
 * @param schema - The app schema
 * @param encryption - The sync encryption config (none or disabled: no sealed relation)
 * @returns The names of the sealed cascade / set-null relations
 */
export function sealedRelationNames(
	schema: SchemaDefinition,
	encryption: SealedRelationEncryption | null | undefined,
): string[] {
	if (!encryption || encryption.enabled !== true) return []
	const names: string[] = []
	for (const [name, relation] of Object.entries(schema.relations ?? {})) {
		if (relation.onDelete !== 'cascade' && relation.onDelete !== 'set-null') continue
		const cleartext = encryption.cleartextFields?.[relation.from] ?? []
		if (!cleartext.includes(relation.field)) names.push(name)
	}
	return names.sort()
}
