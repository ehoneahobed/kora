import { generateSQL } from '@korajs/core'
import type { CollectionDefinition, FieldDescriptor, SchemaDefinition } from '@korajs/core'
import type { SchemaDiff } from './schema-differ'
import { getChangedCollections } from './schema-differ'
import {
	type EvolveTableTarget,
	evolveFieldSpec,
	formatEvolveTableDirective,
} from './table-evolution-directive'
import { formatRelaxValueDomainDirective } from './value-domain-directive'

export interface GeneratedMigration {
	up: string[]
	down: string[]
	summary: string[]
	containsBreakingChanges: boolean
}

/**
 * Generates SQL up/down migration statements from a schema diff.
 */
export function generateMigration(
	previous: SchemaDefinition,
	current: SchemaDefinition,
	diff: SchemaDiff,
): GeneratedMigration {
	const up: string[] = []
	// Each change's inverse is one group of statements in its own order; the groups run
	// in reverse order of the changes they undo.
	const downGroups: string[][] = []

	for (const change of diff.changes) {
		if (change.type === 'collection-added') {
			const collectionDef = current.collections[change.collection]
			if (!collectionDef) continue
			up.push(...generateSQL(change.collection, collectionDef))
			downGroups.push(dropCollectionStatements(change.collection))
		}

		if (change.type === 'collection-removed') {
			const collectionDef = previous.collections[change.collection]
			up.push(...dropCollectionStatements(change.collection))
			if (collectionDef) {
				downGroups.push(generateSQL(change.collection, collectionDef))
			}
		}
	}

	const changedCollections = getChangedCollections(diff).filter(
		(collection) =>
			collection in previous.collections &&
			collection in current.collections &&
			diff.changes.some(
				(change) =>
					change.collection === collection &&
					(change.type === 'field-added' ||
						change.type === 'field-removed' ||
						change.type === 'field-changed' ||
						change.type === 'index-added' ||
						change.type === 'index-removed'),
			),
	)

	for (const collection of changedCollections) {
		const previousDef = previous.collections[collection]
		const currentDef = current.collections[collection]
		if (!previousDef || !currentDef) continue

		// A change to a field's value domain only (enum values, requiredness, default) needs
		// no new table shape: the value domain is enforced by validation on every replica
		// (RT-101). What it needs is the removal of the constraints beta.12 and earlier DDL
		// restated it with (an enum CHECK, NOT NULL), which a table cannot evolve. The
		// directive is expanded by `kora migrate --apply` against the live catalog of each
		// backend, in the migration's transaction (with its history row), and is a no-op on
		// tables that are already relaxed.
		const valueDomainOnly = diff.changes.every(
			(change) =>
				change.collection !== collection ||
				(change.type === 'field-changed' && isValueDomainChange(change.before, change.after)),
		)
		if (valueDomainOnly) {
			const directive = relaxValueDomainDirective(collection, previousDef, currentDef)
			up.push(directive)
			downGroups.push([directive])
			continue
		}

		validateRebuildSafety(collection, previousDef, currentDef)

		// The table keeps everything the migration does not name (RT-105): a client store's
		// `_version` / `_field_versions` and foreign keys, each store's indexes, the
		// Postgres server store's column types. So the change is a directive that
		// `kora migrate --apply` expands against each backend's live catalog (ADD / DROP
		// COLUMN, a catalog-driven SQLite rebuild), in the migration's transaction, after
		// relaxing beta.12 value-domain constraints the same way.
		const relax = relaxValueDomainDirective(collection, previousDef, currentDef)
		up.push(relax, formatEvolveTableDirective(evolveTarget(collection, previousDef, currentDef)))
		downGroups.push([
			relax,
			formatEvolveTableDirective(evolveTarget(collection, currentDef, previousDef)),
		])
	}

	return {
		up,
		down: downGroups.reverse().flat(),
		summary: diff.changes.map(formatChange),
		containsBreakingChanges: diff.hasBreakingChanges,
	}
}

/**
 * Whether a field change touches only its value domain (same kind, item kind and auto
 * flag; enum values, requiredness or default differ).
 */
function isValueDomainChange(before: FieldDescriptor, after: FieldDescriptor): boolean {
	return (
		before.kind === after.kind && before.itemKind === after.itemKind && before.auto === after.auto
	)
}

/** The table changes that take a collection from `from` to `to`. */
function evolveTarget(
	collection: string,
	from: CollectionDefinition,
	to: CollectionDefinition,
): EvolveTableTarget {
	const target: EvolveTableTarget = {
		table: collection,
		add: {},
		drop: [],
		change: {},
		addIndexes: to.indexes.filter((field) => !from.indexes.includes(field)),
		removeIndexes: from.indexes.filter((field) => !to.indexes.includes(field)),
	}
	for (const [field, descriptor] of Object.entries(to.fields)) {
		const before = from.fields[field]
		if (!before) {
			target.add[field] = evolveFieldSpec(descriptor)
		} else if (before.kind !== descriptor.kind || before.itemKind !== descriptor.itemKind) {
			target.change[field] = { from: evolveFieldSpec(before), to: evolveFieldSpec(descriptor) }
		}
	}
	target.drop = Object.keys(from.fields).filter((field) => !(field in to.fields))
	return target
}

function relaxValueDomainDirective(
	collection: string,
	from: CollectionDefinition,
	to: CollectionDefinition,
): string {
	const fields = [...new Set([...Object.keys(from.fields), ...Object.keys(to.fields)])].sort()
	const enums = fields.filter(
		(field) => from.fields[field]?.kind === 'enum' || to.fields[field]?.kind === 'enum',
	)
	return formatRelaxValueDomainDirective({ table: collection, fields, enums })
}

function validateRebuildSafety(
	collection: string,
	from: CollectionDefinition,
	to: CollectionDefinition,
): void {
	for (const [fieldName, descriptor] of Object.entries(to.fields)) {
		if (fieldName in from.fields) continue
		if (descriptor.required && descriptor.defaultValue === undefined && !descriptor.auto) {
			throw new Error(
				`Cannot auto-migrate collection "${collection}": added required field "${fieldName}" has no default value.`,
			)
		}
	}

	for (const [fieldName, targetDescriptor] of Object.entries(to.fields)) {
		const sourceDescriptor = from.fields[fieldName]
		if (!sourceDescriptor) continue
		if (canTransformField(sourceDescriptor, targetDescriptor)) continue

		if (
			targetDescriptor.required &&
			targetDescriptor.defaultValue === undefined &&
			!targetDescriptor.auto
		) {
			throw new Error(
				`Cannot auto-migrate collection "${collection}": changed required field "${fieldName}" from ${sourceDescriptor.kind} to ${targetDescriptor.kind} without a safe transform/default.`,
			)
		}
	}
}

function canTransformField(source: FieldDescriptor, target: FieldDescriptor): boolean {
	if (source.kind === target.kind && source.itemKind === target.itemKind) {
		return true
	}

	if (target.kind === 'string') {
		return true
	}

	if (target.kind === 'number' || target.kind === 'timestamp') {
		return (
			source.kind === 'string' ||
			source.kind === 'enum' ||
			source.kind === 'number' ||
			source.kind === 'timestamp' ||
			source.kind === 'boolean'
		)
	}

	if (target.kind === 'boolean') {
		return (
			source.kind === 'number' ||
			source.kind === 'timestamp' ||
			source.kind === 'boolean' ||
			source.kind === 'string' ||
			source.kind === 'enum'
		)
	}

	if (target.kind === 'enum') {
		return source.kind === 'string' || source.kind === 'enum'
	}

	if (target.kind === 'array') {
		return source.kind === 'array' && source.itemKind === target.itemKind
	}

	if (target.kind === 'richtext') {
		return source.kind === 'richtext'
	}

	return false
}

function dropCollectionStatements(collection: string): string[] {
	const table = quoteIdentifier(collection)
	const opsTable = quoteIdentifier(`_kora_ops_${collection}`)
	return [`DROP TABLE IF EXISTS ${table}`, `DROP TABLE IF EXISTS ${opsTable}`]
}

function quoteIdentifier(identifier: string): string {
	if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
		throw new Error(`Invalid SQL identifier: ${identifier}`)
	}
	// Double-quote to match @korajs/core's generateSQL, so a generated migration
	// is internally consistent (CREATE from core, DROP/rebuild from here) even for
	// camelCase or reserved-word collection and column names.
	return `"${identifier}"`
}

function formatChange(change: SchemaDiff['changes'][number]): string {
	switch (change.type) {
		case 'collection-added':
			return `+ collection ${change.collection}`
		case 'collection-removed':
			return `- collection ${change.collection}`
		case 'field-added':
			return `+ ${change.collection}.${change.field}`
		case 'field-removed':
			return `- ${change.collection}.${change.field}`
		case 'field-changed':
			return `~ ${change.collection}.${change.field}`
		case 'index-added':
			return `+ index ${change.collection}.${change.index}`
		case 'index-removed':
			return `- index ${change.collection}.${change.index}`
	}
}
