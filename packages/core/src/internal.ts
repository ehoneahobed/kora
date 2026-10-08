// Internal exports — shared within @kora packages but NOT part of the public API.
// Other @kora packages can import from '@korajs/core/internal' if needed.

export { canonicalize, computeOperationId } from './operations/content-hash'
export { SimpleEventEmitter } from './events/event-emitter'
export { validateOperationParams } from './operations/operation'
export { topologicalSort } from './version-vector/topological-sort'
export {
	collectionIndexName,
	enumCheckConstraint,
	legacyCollectionIndexName,
	SCHEMA_CEILING_DIRECTIVE,
	sqlDefaultLiteral,
	sqlStringLiteral,
} from './schema/sql-gen'
export {
	isKoraInternalColumn,
	isKoraSqliteEnumCheck,
	isPostgresEnumCheckDefinition,
	parseEnumCheckDefinition,
	parseSqliteCheckConstraints,
	planPostgresConstraintRelaxation,
	planSqliteConstraintRelaxation,
	readSqliteTableCatalog,
	sqliteCheckConstraintDefinition,
	sqliteCheckReferencesColumn,
	sqliteConstraintRelaxationStatements,
	sqliteTableNeedsRelaxation,
} from './schema/constraint-relaxation'
export type {
	EnumCheckShape,
	SqliteCheckConstraint,
	SqliteColumnInfo,
	SqliteForeignKeyInfo,
	SqliteQueryFn,
	SqliteTableCatalog,
} from './schema/constraint-relaxation'
export { compareStamps, stampOf } from './fold/stamp'
export { planField } from './fold/field-kind'
export type { FieldPlan } from './fold/field-kind'
export {
	type CollectionScope,
	type ScopeConjunction,
	type ScopeDisjunction,
	MAX_SCOPE_BRANCHES,
	SCOPE_OR_KEY,
	isScopeDisjunction,
	isPlainRecord,
	isUnrestrictedScope,
	matchesFieldPredicate,
	narrowCollectionScope,
	recordMatchesCollectionScope,
	scopeBranches,
	scopeFieldNames,
} from './scopes/scope-predicate'
