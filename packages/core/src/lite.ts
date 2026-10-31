// The first-paint subset of @korajs/core (first-visit parity, S4a).
//
// `korajs` and the framework bindings render before the local database opens, so the code
// they run on the critical path must not drag the whole package with it. A bundler places
// one module of a published package as a whole, so a symbol imported from `index` would load
// everything the store and sync runtime import from `index` too. This entry has its own
// graph: the statements it reaches are the only ones it loads, and they are the same
// definitions `index` exports (one `KoraError` class, one schema builder), shared through a
// common chunk.
//
// Add to this file only what the first paint needs. `lite-entry.test.ts` fails when it grows
// a dependency on the runtime.

export { defineSchema } from './schema/define'
export { t } from './schema/types'
export { AppNotReadyError, KoraError, SchemaValidationError } from './errors/errors'
export { isAtomicOp } from './operations/atomic-op-marker'
export { SimpleEventEmitter } from './events/event-emitter'
export {
	type WriteObserver,
	currentWriteObserver,
	runWithWriteObserver,
} from './writes/write-observer'
export { preReadyWritesAllowed, runAllowingPreReadyWrites } from './writes/pre-ready-writes'
export { buildScopeMap } from './scopes/build-scope-map'
export { extractScopeValuesFromClaims } from './scopes/extract-scope-from-claims'
export type { SchemaInput } from './schema/define'
