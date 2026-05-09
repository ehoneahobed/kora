import type { OnDeleteAction, RelationDefinition, SchemaDefinition } from '@korajs/core'

/**
 * A resolved relation reference: describes a relation that points TO a given collection.
 * When a record in `targetCollection` is deleted, we must handle records in
 * `sourceCollection` that reference it via `foreignKeyField`.
 */
export interface IncomingRelation {
	/** Name of the relation in the schema */
	relationName: string
	/** Collection that holds the foreign key (the "from" side) */
	sourceCollection: string
	/** Field in the source collection that references the target */
	foreignKeyField: string
	/** What to do when the referenced record is deleted */
	onDelete: OnDeleteAction
	/** The full relation definition */
	relation: RelationDefinition
}

/**
 * Builds an efficient lookup from target collection to all relations that reference it.
 *
 * Given a schema with relations like:
 * ```
 * todoBelongsToProject: { from: 'todos', to: 'projects', field: 'projectId', onDelete: 'cascade' }
 * ```
 *
 * The lookup for 'projects' would return:
 * ```
 * [{ sourceCollection: 'todos', foreignKeyField: 'projectId', onDelete: 'cascade', ... }]
 * ```
 *
 * This enables O(1) lookup when deleting a record to find all dependent relations.
 *
 * @param schema - The full schema definition containing relations
 * @returns A map from target collection name to its incoming relations
 */
export function buildRelationLookup(schema: SchemaDefinition): Map<string, IncomingRelation[]> {
	const lookup = new Map<string, IncomingRelation[]>()

	for (const [relationName, relation] of Object.entries(schema.relations)) {
		const targetCollection = relation.to
		const existing = lookup.get(targetCollection) ?? []
		existing.push({
			relationName,
			sourceCollection: relation.from,
			foreignKeyField: relation.field,
			onDelete: relation.onDelete,
			relation,
		})
		lookup.set(targetCollection, existing)
	}

	return lookup
}

/**
 * Get all incoming relations for a given collection.
 * Returns an empty array if no relations reference the collection.
 *
 * @param lookup - The pre-built relation lookup map
 * @param collection - The target collection name
 * @returns Array of incoming relations
 */
export function getIncomingRelations(
	lookup: Map<string, IncomingRelation[]>,
	collection: string,
): IncomingRelation[] {
	return lookup.get(collection) ?? []
}
