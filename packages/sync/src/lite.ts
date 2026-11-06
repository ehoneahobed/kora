// The first-paint subset of @korajs/sync (first-visit parity, S4a).
//
// Frameworks render before the sync engine exists, so the status snapshot, its controller and
// the config checks that run in `createApp` must load without the engine, transports and
// encryption runtime. This entry has its own module graph for that; see `@korajs/core/lite`
// for why a separate entry matters to a bundler. Add to it only what the first paint needs.

export {
	createSyncStatusController,
	OFFLINE_SYNC_STATUS,
} from './reactivity/sync-status-controller'
export type { SyncStatusController } from './reactivity/sync-status-controller'
export { validateEncryptedRelations } from './encryption/encrypted-relations'
export { isValidKeyringName } from './encryption/keyring-name'

export { MAX_READ_QUERIES, READ_PROTOCOL_VERSION } from './read/read-types'
export type {
	ReadErrorBody,
	ReadIncludeStatus,
	ReadOrderBy,
	ReadQuery,
	ReadRecord,
	ReadRequest,
	ReadResponse,
	ReadResult,
	ReadStatus,
} from './read/read-types'
export { ReadThroughClient, ReadThroughError } from './read/read-through-client'
export type {
	ReadAnswer,
	ReadCallOptions,
	ReadFetch,
	ReadFetchInit,
	ReadFetchResponse,
	ReadThroughClientOptions,
} from './read/read-through-client'
