// The first-paint subset of @korajs/store (first-visit parity, S4a).
//
// Frameworks render before the database opens, so the query cache and the helpers that
// identify a query must load without the store runtime (SQLite, replication, Yjs). This
// entry has its own module graph for that; see `@korajs/core/lite` for why a separate entry
// matters to a bundler. Add to it only what the first paint needs.

export { normalizeWhere, queryKey } from './query/query-key'
export { assertQueryReady } from './reactivity/assert-query-ready'
export { getSharedQueryStoreCache, QueryStoreCache } from './reactivity/query-store-cache'
export type { QueryStore } from './reactivity/query-store'
