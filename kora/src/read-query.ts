import type { CollectionDefinition, SchemaDefinition } from '@korajs/core'
import type { QueryDescriptor } from '@korajs/store'
import type { ReadQuery } from '@korajs/sync/read'

/**
 * Building a read-through query (the answers chunk). The first paint's early read builds the
 * same query object with a slimmer copy (`earlyQuery` in early-read.ts): keep the two in step.
 */

/** The longest query key the read endpoint accepts. */
const MAX_QUERY_KEY_LENGTH = 256

/**
 * The read-through query for a descriptor, or null when the query cannot be answered from
 * memory before the store opens.
 *
 * Refused (the store answers instead): relational queries, whose records would need their
 * included rows rebuilt; collections with rich text, whose stored form the in-memory record
 * cannot reproduce; collections the schema does not define; and a descriptor too long to be
 * a key (a hash could collide, and a collision would deliver another query's rows).
 */
export function toReadQuery(
	descriptor: QueryDescriptor,
	schema: SchemaDefinition,
): ReadQuery | null {
	const definition = schema.collections[descriptor.collection]
	if (definition === undefined) return null
	if (descriptor.include !== undefined && descriptor.include.length > 0) return null
	if (hasRichtext(definition)) return null
	const key = JSON.stringify([
		descriptor.collection,
		descriptor.where,
		descriptor.orderBy,
		descriptor.limit ?? null,
		descriptor.offset ?? null,
	])
	if (key.length > MAX_QUERY_KEY_LENGTH) return null
	// An undefined limit or offset is left out by JSON.stringify, as the request needs: the same
	// bytes as spreading them only when set, in less first-paint code. Descriptors are immutable.
	return {
		key,
		collection: descriptor.collection,
		where: descriptor.where,
		orderBy: descriptor.orderBy.map((entry) => ({
			field: entry.field,
			direction: entry.direction,
		})),
		limit: descriptor.limit,
		offset: descriptor.offset,
	}
}

function hasRichtext(definition: CollectionDefinition): boolean {
	return Object.values(definition.fields).some((field) => field.kind === 'richtext')
}
