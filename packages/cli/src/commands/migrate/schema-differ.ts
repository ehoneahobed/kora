import type { FieldDescriptor, SchemaDefinition } from '@kora/core'

export type SchemaChange =
	| { type: 'collection-added'; collection: string }
	| { type: 'collection-removed'; collection: string }
	| { type: 'field-added'; collection: string; field: string; descriptor: FieldDescriptor }
	| { type: 'field-removed'; collection: string; field: string; descriptor: FieldDescriptor }
	| {
			type: 'field-changed'
			collection: string
			field: string
			before: FieldDescriptor
			after: FieldDescriptor
	  }
	| { type: 'index-added'; collection: string; index: string }
	| { type: 'index-removed'; collection: string; index: string }

export interface SchemaDiff {
	fromVersion: number
	toVersion: number
	changes: SchemaChange[]
	hasChanges: boolean
	hasBreakingChanges: boolean
}

/**
 * Computes a structural schema diff.
 */
export function diffSchemas(previous: SchemaDefinition, current: SchemaDefinition): SchemaDiff {
	const changes: SchemaChange[] = []

	const previousCollections = new Set(Object.keys(previous.collections))
	const currentCollections = new Set(Object.keys(current.collections))

	for (const collection of currentCollections) {
		if (!previousCollections.has(collection)) {
			changes.push({ type: 'collection-added', collection })
		}
	}

	for (const collection of previousCollections) {
		if (!currentCollections.has(collection)) {
			changes.push({ type: 'collection-removed', collection })
		}
	}

	for (const collection of currentCollections) {
		if (!previousCollections.has(collection)) continue

		const previousDef = previous.collections[collection]
		const currentDef = current.collections[collection]
		if (!previousDef || !currentDef) continue

		const previousFields = previousDef.fields
		const currentFields = currentDef.fields

		for (const [fieldName, currentField] of Object.entries(currentFields)) {
			const previousField = previousFields[fieldName]
			if (!previousField) {
				changes.push({
					type: 'field-added',
					collection,
					field: fieldName,
					descriptor: currentField,
				})
				continue
			}

			if (!fieldDescriptorsEqual(previousField, currentField)) {
				changes.push({
					type: 'field-changed',
					collection,
					field: fieldName,
					before: previousField,
					after: currentField,
				})
			}
		}

		for (const [fieldName, previousField] of Object.entries(previousFields)) {
			if (!(fieldName in currentFields)) {
				changes.push({
					type: 'field-removed',
					collection,
					field: fieldName,
					descriptor: previousField,
				})
			}
		}

		const previousIndexes = new Set(previousDef.indexes)
		const currentIndexes = new Set(currentDef.indexes)

		for (const index of currentIndexes) {
			if (!previousIndexes.has(index)) {
				changes.push({ type: 'index-added', collection, index })
			}
		}

		for (const index of previousIndexes) {
			if (!currentIndexes.has(index)) {
				changes.push({ type: 'index-removed', collection, index })
			}
		}
	}

	changes.sort(compareChanges)

	return {
		fromVersion: previous.version,
		toVersion: current.version,
		changes,
		hasChanges: changes.length > 0,
		hasBreakingChanges: changes.some(isBreakingChange),
	}
}

export function getChangedCollections(diff: SchemaDiff): string[] {
	const collections = new Set<string>()
	for (const change of diff.changes) {
		collections.add(change.collection)
	}
	return [...collections].sort()
}

function isBreakingChange(change: SchemaChange): boolean {
	if (change.type === 'collection-removed' || change.type === 'field-removed') return true
	if (change.type === 'field-changed') {
		if (change.before.kind !== change.after.kind) return true
		if (change.before.itemKind !== change.after.itemKind) return true
		if (serializeEnum(change.before.enumValues) !== serializeEnum(change.after.enumValues)) return true
		if (change.before.required !== change.after.required && change.after.required) return true
		return false
	}
	if (change.type === 'field-added') {
		const descriptor = change.descriptor
		return descriptor.required && descriptor.defaultValue === undefined && !descriptor.auto
	}
	return false
}

function fieldDescriptorsEqual(left: FieldDescriptor, right: FieldDescriptor): boolean {
	return (
		left.kind === right.kind &&
		left.required === right.required &&
		left.defaultValue === right.defaultValue &&
		left.auto === right.auto &&
		left.itemKind === right.itemKind &&
		serializeEnum(left.enumValues) === serializeEnum(right.enumValues)
	)
}

function serializeEnum(values: readonly string[] | null): string {
	if (!values) return ''
	return values.join('|')
}

function compareChanges(left: SchemaChange, right: SchemaChange): number {
	if (left.collection < right.collection) return -1
	if (left.collection > right.collection) return 1

	if (left.type < right.type) return -1
	if (left.type > right.type) return 1

	const leftKey = 'field' in left ? left.field : 'index' in left ? left.index : ''
	const rightKey = 'field' in right ? right.field : 'index' in right ? right.index : ''

	if (leftKey < rightKey) return -1
	if (leftKey > rightKey) return 1
	return 0
}
