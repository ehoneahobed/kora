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
	sqlDefaultLiteral,
	sqlStringLiteral,
} from './schema/sql-gen'
export { compareStamps, stampOf } from './fold/stamp'
export { planField } from './fold/field-kind'
export type { FieldPlan } from './fold/field-kind'
