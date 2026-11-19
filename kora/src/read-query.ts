import type { CollectionDefinition, SchemaDefinition } from '@korajs/core'
import type { QueryDescriptor } from '@korajs/store'
import type { ReadQuery } from '@korajs/sync/read'

/**
 * Building a read-through query, shared by the first paint's early read (`early-read.ts`) and the
 * answers chunk (`pre-ready-answers.ts`): both must build the same request for the same query.
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
	return {
		key,
		collection: descriptor.collection,
		where: { ...descriptor.where },
		orderBy: descriptor.orderBy.map((entry) => ({
			field: entry.field,
			direction: entry.direction,
		})),
		...(descriptor.limit !== undefined ? { limit: descriptor.limit } : {}),
		...(descriptor.offset !== undefined ? { offset: descriptor.offset } : {}),
	}
}

function hasRichtext(definition: CollectionDefinition): boolean {
	return Object.values(definition.fields).some((field) => field.kind === 'richtext')
}

/** `<syncPath>/read` over http(s) for a sync URL that may be ws(s) and may carry a query. */
export function readEndpointUrl(syncUrl: string): string {
	const http = syncUrl.replace(/^ws(s?):\/\//, 'http$1://').replace(/[?#].*$/, '')
	return `${http.replace(/\/+$/, '')}/read`
}
