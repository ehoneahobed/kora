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
