// Internal exports — shared within @kora packages but NOT part of the public API.
// Other @kora packages can import from '@korajs/store/internal' if needed.

export {
	serializeOperation,
	deserializeOperation,
	deserializeOperationWithCollection,
	serializeRecord,
	deserializeRecord,
} from './serialization/serializer'

export {
	buildSelectQuery,
	buildCountQuery,
	buildInsertQuery,
	buildUpdateQuery,
	buildSoftDeleteQuery,
	buildWhereClause,
} from './query/sql-builder'
export type { SqlQuery } from './query/sql-builder'

export type {
	OperationRow,
	RawCollectionRow,
	MetaRow,
	VersionVectorRow,
	Subscription,
} from './types'
