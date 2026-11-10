import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import { scanDeliveryPosition, tally } from './delivery-progress-scan'

/**
 * Four review rounds found the same bug four times: a write of the delivery position after an
 * await, with no re-check that the position the batch was received at still exists. Two layers
 * keep it from coming back.
 *
 * 1. Structure (round 6). The position is not engine fields: it is `#private` state of
 *    `DeliveryPosition`, which no cast, bracket access, destructuring, `Reflect` or
 *    `Object.assign` of the engine can reach. It changes through method calls, and only
 *    `commitDeliveryProgress` holds the batch writer.
 * 2. This test, a syntax-tree scan (not lines, which the fifth review defeated with eight
 *    spellings, nor a list of spellings, which the sixth did with thirty-one): every call of a
 *    position mutator, every mention of a persistence method, every write of the state that
 *    decides what a batch counts for, every element access with a key the scan cannot read,
 *    every cast of the engine or its collaborators, every call to `Reflect` / `globalThis` /
 *    `Object.assign`, and every live-database mutation without a synchronous check before it
 *    is listed below with its owner and a site count. `packages/sync/src` is scanned whole,
 *    and the store and the kora package for the persistence names. A new site anywhere, in
 *    any spelling, fails here, and adding it to the table is a decision made in review.
 */
// Every test here scans the engine's source synchronously (about 0.1 s alone, several times that
// on a loaded runner). Back to back they never return to the event loop, and the worker's reply
// to vitest's `onTaskUpdate` is an I/O event: past 60 s of unbroken work the call times out
// ("Timeout calling onTaskUpdate", an unhandled error that fails the package). A macrotask turn
// after each test lets the loop run.
afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..', '..', '..')
const ENGINE = 'packages/sync/src/engine/sync-engine.ts'
const SOURCE = readFileSync(join(ROOT, ENGINE), 'utf8')

/** `rule @ file @ member` -> number of sites. */
const EXPECTED: Record<string, number> = {
	// ---- Position fields reappearing on the engine (it holds none: the state is private to DeliveryPosition)
	'assign:accessRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	// ---- Writes of the state that decides what a batch counts for: owners of session, view, user and replica identity
	'state:connectionGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:deliveryGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	'state:deliveryGeneration @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'state:offlineWatermarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.refreshOfflineMarks': 1,
	'state:principal @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyPrincipal': 1,
	'state:serverFrontier @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleError': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOutboundAckTimeout': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleTransportClose': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleTransportError': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:sessionEpoch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.stopInternal': 1,
	'state:sessionPrincipal @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchIntoStaging': 3,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'state:staging @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	// ---- Who changes the delivery position: owners (start, view switches, full resync, dropping a replica) and the single batch writer (advance, adoptKey, writer)
	'position:adoptKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'position:adoptRulesKey @ packages/sync/src/engine/delivery-position.ts @ PositionWriter.adoptKey': 1,
	'position:adoptRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	'position:advance @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 2,
	'position:forgetView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.evictColdViewWatermarks': 1,
	'position:moveTo @ packages/sync/src/engine/delivery-position.ts @ PositionWriter.advance': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.dropStaging': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.restoreLivePosition': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 2,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'position:moveTo @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'position:preloadView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 3,
	'position:recordView @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.setViewWatermark': 1,
	'position:writer @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	// ---- Durable writes of the position: owners, the single writer, and capability checks that only read the method
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'persist:persistDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	'persist:saveAccessRulesKey @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.saveAccessRulesKey': 1,
	'persist:saveAccessRulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'persist:saveDeliveryWatermark @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyDeliveryBatch': 1,
	'persist:saveDeliveryWatermark @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.saveDeliveryWatermark': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.buildOfflineCompletion': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.canQuarantine': 1,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	'persist:saveDeliveryWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.persistDeliveryWatermark': 2,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.beginStaging': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.canQuarantine': 1,
	'persist:saveQuarantine-progress @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 3,
	'persist:sendDeliveryAck @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 2,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryView': 1,
	'persist:setViewWatermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.switchDeliveryViewWithInheritance': 1,
	// ---- Who may import the position classes
	'import:position @ packages/sync/src/engine/sync-engine.ts @ <top level>': 1,
	// Free functions that write the position durably, in the store that owns them.
	'call:saveDeliveryWatermark @ packages/store/src/store/store.ts @ Store.saveDeliveryWatermark': 1,
	'call:saveUnappliedOperationsInTx @ packages/store/src/store/store.ts @ Store.applyRemoteBatchNow': 1,
	'call:saveUnappliedOperationsInTx @ packages/store/src/sync/sync-durability.ts @ function saveUnappliedOperations': 1,
	'import:saveDeliveryWatermark @ packages/store/src/store/store.ts @ <top level>': 1,
	'import:saveUnappliedOperationsInTx @ packages/store/src/store/store.ts @ <top level>': 1,
	// ---- Mutations of the live database with no synchronous position check before them in the same function. Why each is not a hole:
	//  * inside an apply transaction (applyBatchInOneTransaction: retractions, applyInbound; the batch's applyScopeRetraction in applyDeliveredRetraction): the single writer rolls the transaction back on a stale context
	//  * helpers whose callers check: SyncEngine.applyScopeRetraction (called by applyDeliveredRetraction after its check, and by the handshake narrowing), ensureOfflineUnit's openOfflineUnit (callers check; see the guarded call sites)
	//  * deferScopeRetraction in applyDeliveredRetraction: the store checks `isCurrent` synchronously before it records anything
	//  * the handshake and session start (handleHandshakeResponse, startInternal, resetDeliveryForFullResync, handleOperationBatch's reset): they own the position, they do not apply a batch received at one
	//  * acknowledgments, rejections and pushes (handleAcknowledgment, handleOperationRejected, pushOperation, recheckAccessNarrowing): they react to the outbound queue, not to a delivery batch
	//  * store-level writers called from the engine's own wrappers: applyRemoteOperation inside applyAtPosition and applyAtPosition inside applyInbound(Quietly) carry the delivery's `isCurrent` into the storage transaction (noteDeliveryPosition), and applyDeliveryBatch inside applyBatchInOneTransaction is the single-transaction path that rolls back whole on a stale context; the handshake's applyScopeNarrowing owns the position (it is the narrowing of the new grant, not of a received batch)
	'unguarded:applyDeliveredRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'unguarded:applyInbound @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyDeliveredRetraction': 1,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyScopeRetraction': 1,
	'unguarded:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.clearOfflineMarks': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationBatch': 1,
	'unguarded:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.resetDeliveryForFullResync': 1,
	'unguarded:deferScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyDeliveredRetraction': 1,
	'unguarded:openOfflineUnit @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.ensureOfflineUnit': 1,
	'unguarded:rebaseDeliveryRun @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleAcknowledgment': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationRejected': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.pushOperation': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recheckAccessNarrowing': 1,
	'unguarded:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	// ---- Element access with a key the scan cannot read: data lookups, never the engine or its collaborators
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function awarenessStatesToWire': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function keyServiceReply': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ function wireToAwarenessStates': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 4,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchPerOperation': 3,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.chooseSessionNode': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.emitRewritten': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleOperationBatch': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.parkAdoption': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.prepareOperationProbe': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recordOutOfUplinkScope': 3,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recordUploadProgress': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverSequenceConflict': 1,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.settleQueuedNode': 2,
	'dynamic-member-access @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.transitionTo': 1,
	// ---- Callers of the full resync: all inside the message chain, or after awaiting it
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverFromClone': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recoverSequenceConflict': 1,
	'serialized:resetDeliveryForFullResync @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.startInternal': 1,
	// ---- Code built at run time (can name any member): the one optional-peer loader of the kora package, which imports a module by name and touches no delivery state
	'dynamic-code:Function @ kora/src/adapter-resolver.ts @ function importOptionalPeer': 1,
	// ---- Namespace imports (reach every export of a module): the Yjs CRDT library only
	'import:namespace @ packages/store/src/fold/record-folder.ts @ <top level>': 1,
	'import:namespace @ packages/store/src/richtext/create-richtext-controller.ts @ <top level>': 1,
	'import:namespace @ packages/store/src/serialization/richtext-serializer.ts @ <top level>': 1,
	// ---- The persisted position's meta key spelled as a string: its definition, in the module that owns the sync state
	'named-by-string:delivery_watermark @ packages/store/src/sync/sync-state.ts @ <top level>': 1,
	// ---- Mutators named without being called: the capability checks `if (!this.store.applyX)` (the method is optional on a store). A reference that is passed or stored is called later with no check before it, so a new one is a decision made in review
	'reference:applyCollectionNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchPerOperation': 1,
	'reference:applyDeliveryBatch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'reference:applyScopeNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'reference:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyScopeRetraction': 1,
	'reference:clearOfflineMarks @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.clearOfflineMarks': 1,
	'reference:openOfflineUnit @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.ensureOfflineUnit': 1,
	'reference:rebaseDeliveryRun @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'reference:recheckAccessNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.recheckAccessNarrowing': 1,
	// ---- The persisted position reached by its key. sync-state.ts is the one writer/reader; the other two reset it to 0 to force a full resync and run only while no sync engine is delivering: requestSnapshotResync during store open (before any engine exists, fold-plan reconciliation) and restoreReplace during a restore (the app stops the engine first, and a restore bumps the index generation and clears the cursor)
	'sql:delivery-watermark @ packages/store/src/backup/restore.ts @ function restoreReplace': 2,
	'sql:delivery-watermark @ packages/store/src/store/store.ts @ Store.requestSnapshotResync': 2,
	'sql:delivery-watermark @ packages/store/src/sync/sync-state.ts @ <top level>': 2,
	'sql:delivery-watermark @ packages/store/src/sync/sync-state.ts @ function deliveryWatermarkKey': 2,
	'sql:delivery-watermark @ packages/store/src/sync/sync-state.ts @ function loadAllDeliveryWatermarks': 4,
	// ---- Writes of fields of a delivery context / replica: the writer itself (commitDeliveryProgress advances the context it just committed), the staging replica's own watermark (applyBatchIntoStaging), and unrelated `generation` fields of the transport and the holding emitter
	'state:context.generation @ packages/sync/src/engine/holding-emitter.ts @ HoldingEmitter.discard': 1,
	'state:context.generation @ packages/sync/src/transport/websocket-transport.ts @ WebSocketTransport.connect': 1,
	'state:context.generation @ packages/sync/src/transport/websocket-transport.ts @ WebSocketTransport.disconnect': 1,
	'state:context.generation @ packages/sync/src/transport/websocket-transport.ts @ WebSocketTransport.touchLiveness': 1,
	'state:context.rulesKey @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 1,
	'state:context.watermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchIntoStaging': 1,
	'state:context.watermark @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.commitDeliveryProgress': 2,
	// ---- The offline-watermark cache set by its one owner
	'state:offlineWatermarks.set @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.setViewWatermark': 1,
	// ---- The two checks themselves, declared once (a subclass or patch declaring another is a finding)
	'tamper:declare:deliveryContextChanged @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.deliveryContextChanged': 1,
	'tamper:declare:positionMoved @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.positionMoved': 1,
	// ---- Mutations that carry their own currency check into the storage write (`context` / `isCurrent`) but are called without one. Why each is not a hole:
	//  * applyBatchInOneTransaction's applyInbound: runs inside the batch transaction, which the single writer rolls back whole on a stale context (StaleDeliveryBatch), so nothing it wrote survives
	//  * applyDeliveredRetraction's batch.applyScopeRetraction: same transaction
	//  * the handshake's applyScopeRetraction(…, false) hides nothing (applyToStore false): it only rejects writes the server already refused
	'uncarried:applyInbound @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'uncarried:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyDeliveredRetraction': 1,
	'uncarried:applyScopeRetraction @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	'unguarded:applyAtPosition @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyInbound': 1,
	'unguarded:applyAtPosition @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyInboundQuietly': 1,
	'unguarded:applyDeliveryBatch @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyBatchInOneTransaction': 1,
	'unguarded:applyRemoteOperation @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.applyAtPosition': 2,
	'unguarded:applyScopeNarrowing @ packages/sync/src/engine/sync-engine.ts @ SyncEngine.handleHandshakeResponse': 1,
	// ---- Dynamic imports (load a module by name at run time): optional peers, lazily loaded features and the SQLite worker. None touches delivery state; a new one is reviewed
	'dynamic-import @ kora/src/adapter-resolver.ts @ function createAdapter': 3,
	'dynamic-import @ kora/src/setup-devtools.ts @ function setupDevtools': 2,
	'dynamic-import @ kora/src/storage-accessor.ts @ <class>.deleteDatabase': 1,
	'dynamic-import @ kora/src/storage-accessor.ts @ <class>.listDatabases': 1,
	'dynamic-import @ packages/store/src/adapters/better-sqlite3-adapter.ts @ BetterSqlite3Adapter.open': 1,
	'dynamic-import @ packages/store/src/adapters/local-databases.ts @ function deleteLocalDatabase': 1,
	// S4a (render before ready): the lite entry loads the runtime and the pre-ready write journal as chunks after the first paint. These `import()` calls load S4a's own modules, `@korajs/core` and `@korajs/store` for local writes held before the app is ready; none writes the delivery position (the scan finds no S4a caller of a position writer).
	'dynamic-import @ kora/src/create-app.ts @ function createApp': 5,
	// S4b (pre-ready answers): loads the in-memory answer service, the read-through HTTP client and the credential provider built from `sync.authClient` (it only calls the binding's `auth` and `resolveSyncState`) when `sync.firstVisit.readThrough` is on. The client only POSTs to the read endpoint and holds no store or position; nothing it loads writes the delivery position.
	'dynamic-import @ kora/src/create-app.ts @ function loadPreReadyAnswers': 3,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function applyQueue': 1,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function noteScanned': 1,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function openJournal': 1,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function recover': 1,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function refuseQueue': 1,
	'dynamic-import @ kora/src/pre-ready-journal.ts @ function warnLater': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function assignHeldNode': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function blockedByOlderWrite': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function discardJournalFor': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function discardJournalOf': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function heldOfNode': 1,
	'dynamic-import @ kora/src/pre-ready-recovery.ts @ function rejectUnapplied': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.apply': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.assignHeld': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.discardHeld': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.discardJournal': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.enqueue': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.getJournal': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.noteMemoryOnly': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.noteSignedInUser': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.patchOwner': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.persist': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.purgeFailedOf': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.refuse': 1,
	'dynamic-import @ kora/src/pre-ready-writes.ts @ PreReadyWriteQueue.scan': 1,
	'dynamic-import @ packages/store/src/adapters/local-databases.ts @ function exportLocalDatabase': 1,
	'dynamic-import @ packages/store/src/adapters/sqlite-wasm-adapter.ts @ SqliteWasmAdapter.attachAndOpen': 1,
	'dynamic-import @ packages/store/src/adapters/sqlite-wasm-adapter.ts @ SqliteWasmAdapter.createStagingAdapter': 1,
	'dynamic-import @ packages/store/src/adapters/sqlite-wasm-adapter.ts @ SqliteWasmAdapter.promoteToLeader': 1,
	'dynamic-import @ packages/store/src/adapters/sqlite-wasm-mock-bridge.ts @ MockWorkerBridge.handleOpen': 1,
	'dynamic-import @ packages/store/src/adapters/sqlite-wasm-worker-core.ts @ function loadSqlite3': 1,
	'dynamic-import @ packages/store/src/backup/backup.ts @ function restoreBackup': 1,
	'dynamic-import @ packages/store/src/store/store.ts @ Store.exportAudit': 1,
	'dynamic-import @ packages/store/src/store/store.ts @ Store.exportBackup': 1,
	'dynamic-import @ packages/store/src/store/store.ts @ Store.flushAuditQueue': 1,
	'dynamic-import @ packages/store/src/store/store.ts @ Store.getAuditTraces': 1,
	'dynamic-import @ packages/store/src/store/store.ts @ Store.importBackupNow': 2,
	'dynamic-import @ packages/sync/src/transport/http-long-polling-transport.ts @ HttpLongPollingTransport.loadDefaultSerializer': 1,
	// ---- Element access with a key the scan cannot read in the files that hold the sync state: row/column lookups by field name, never a writer
	'dynamic-member-access @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.hasCollection': 1,
	// ---- (same, in the sync state modules and the engine's helper modules)
	'dynamic-member-access @ packages/store/src/sync/offline-marks.ts @ function saveOfflineCompletionInTx': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-durability.ts @ function loadAcceptedDownlinkScope': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-durability.ts @ function loadOwnAckedThrough': 2,
	'dynamic-member-access @ packages/store/src/sync/sync-durability.ts @ function saveOwnAckedThrough': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadAllDeliveryWatermarks': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadAuthoritativeNodeIds': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadDeliveryWatermark': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadDeltaCursor': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadLastAckedServerVector': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadNodeToken': 4,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function loadRevokedAuthoritativeNodeIds': 1,
	'dynamic-member-access @ packages/store/src/sync/sync-state.ts @ function serializeVersionVectorToMeta': 1,
	'dynamic-member-access @ packages/sync/src/engine/outbound-queue.ts @ OutboundQueue.reject': 2,
	'dynamic-member-access @ packages/sync/src/engine/verify-inbound.ts @ function fillDeclaredNestedMembers': 3,
	'dynamic-member-access @ packages/sync/src/engine/verify-inbound.ts @ function fillNested': 4,
	'dynamic-member-access @ packages/sync/src/engine/verify-inbound.ts @ function mapMembers': 1,
	'dynamic-member-access @ packages/sync/src/engine/verify-inbound.ts @ function replaceAt': 3,
	// ---- globalThis in the sync lifecycle: environment feature detection (window / document / navigator)
	'reflective:globalThis @ kora/src/sync-lifecycle.ts @ function wireSyncLifecycleAfterReady': 2,
	// ---- Mutations that carry a currency check but are called without `context` / `isCurrent`, outside the engine: the kora SyncStore wrapper forwards its `options` argument whole (the engine's isCurrent included), and the store's own owners (the handshake narrowing, the recheck after an acknowledgment) are not called for a received batch
	'uncarried:applyCollectionNarrowing @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyCollectionNarrowing': 1,
	'uncarried:applyScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyDeliveryBatch': 1,
	'uncarried:applyScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyScopeRetraction': 1,
	'uncarried:applyScopeRetraction @ packages/store/src/store/store.ts @ Store.applyScopeNarrowing': 1,
	'uncarried:applyScopeRetraction @ packages/store/src/store/store.ts @ Store.recheckAccessNarrowing': 2,
	'uncarried:deferScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.deferScopeRetraction': 1,
	// ---- Live-database mutations named outside the engine. The kora apply pipelines apply the DELIVERED operation under its own id, so the store's by-id currency check (noteDeliveryPosition) holds for every one of them; the SyncStore wrapper methods are forwarders; the store's beginStaging merges into a scratch replica and importBackupNow runs with the engine stopped; the offline-mark helpers are called by the engine's guarded sites
	'unguarded:applyCollectionNarrowing @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyCollectionNarrowing': 1,
	'unguarded:applyRemoteOperation @ kora/src/apply-pipeline.ts @ ApplyPipeline.apply': 1,
	'unguarded:applyRemoteOperation @ kora/src/apply-pipeline.ts @ ApplyPipeline.applyFolded': 1,
	'unguarded:applyRemoteOperation @ kora/src/apply-pipeline.ts @ ApplyPipeline.applyRemoteInBatch': 2,
	'unguarded:applyRemoteOperation @ packages/store/src/store/store.ts @ Store.beginStaging': 1,
	'unguarded:applyRemoteOperation @ packages/store/src/store/store.ts @ Store.importBackupNow': 1,
	'unguarded:applyScopeNarrowing @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyScopeNarrowing': 1,
	'unguarded:applyScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyDeliveryBatch': 1,
	'unguarded:applyScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.applyScopeRetraction': 1,
	'unguarded:applyScopeRetraction @ packages/store/src/store/store.ts @ Store.applyScopeNarrowing': 1,
	'unguarded:applyScopeRetraction @ packages/store/src/store/store.ts @ Store.recheckAccessNarrowing': 2,
	'unguarded:clearOfflineMarks @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.clearOfflineMarks': 1,
	'unguarded:deferScopeRetraction @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.deferScopeRetraction': 1,
	'unguarded:openOfflineUnit @ kora/src/store-sync-state.ts @ StoreSyncStatePersistence.openOfflineUnit': 1,
	'unguarded:rebaseDeliveryRun @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.rebaseDeliveryRun': 1,
	'unguarded:recheckAccessNarrowing @ kora/src/merge-aware-sync-store.ts @ MergeAwareSyncStore.recheckAccessNarrowing': 1,
}

function walk(directory: string, out: string[] = []): string[] {
	for (const name of readdirSync(directory)) {
		const path = join(directory, name)
		if (statSync(path).isDirectory()) {
			if (name !== 'node_modules' && name !== 'dist' && name !== 'benchmarks') walk(path, out)
		} else if (path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.endsWith('.d.ts')) {
			out.push(path)
		}
	}
	return out
}

/** Which findings of a file count: the engine in full, the rest of the sync package by name, other packages by persistence name. */
/**
 * The files that hold the persistence methods or the sync state itself (the engine's collaborators):
 * an element access with a key the scan cannot read, or a `Reflect` / `Object` call, there can reach a
 * writer by any name. Everywhere else those are data lookups (the store alone has hundreds).
 */
const HOLDERS =
	/^(kora\/src\/(store-sync-state|merge-aware-sync-store|sync-lifecycle)\.ts|packages\/store\/src\/sync\/(sync-state|sync-durability|offline-marks)\.ts|packages\/sync\/src\/engine\/)/

function counts(file: string, rule: string): boolean {
	if (file === ENGINE) return true
	// Everywhere a persisted position, a check or code built at run time could be reached from.
	if (/^(sql:|dynamic-code:|dynamic-import|tamper:|named-by-string:|import:)/.test(rule))
		return true
	// Mutations of the live database made on a delivered operation, named by anyone.
	if (/^(unguarded|uncarried|reference):/.test(rule)) return true
	if (HOLDERS.test(file) && /^(dynamic-member-access|reflective:)/.test(rule)) return true
	if (file.startsWith('packages/sync/src')) {
		return /^(persist|alias|position|call|state|assign|cache|serialized):/.test(rule)
	}
	return /^(persist|alias|call|position|serialized):/.test(rule)
}

function scanFile(file: string, source: string): ReturnType<typeof scanDeliveryPosition> {
	return scanDeliveryPosition(source, file).filter((site) => counts(file, site.rule))
}

const OTHERS = (() => {
	const sites: ReturnType<typeof scanDeliveryPosition> = []
	for (const directory of ['packages/sync/src', 'packages/store/src', 'kora/src']) {
		for (const path of walk(join(ROOT, directory))) {
			const file = relative(ROOT, path)
			// The scan and the position class are checked by their own tests and by the table.
			if (file === ENGINE || file.endsWith('delivery-progress-scan.ts')) continue
			sites.push(...scanFile(file, readFileSync(path, 'utf8')))
		}
	}
	return sites
})()

/** Everything the scan finds, with the engine's text replaced by `engineSource`. */
function repository(engineSource: string): Record<string, number> {
	return tally([...OTHERS, ...scanFile(ENGINE, engineSource)])
}

function sorted(table: Record<string, number>): Record<string, number> {
	return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a.localeCompare(b)))
}

describe('the delivery position has one writer (syntax-tree rule)', () => {
	test('every writer, alias, mutation and caller is accounted for', () => {
		expect(repository(SOURCE)).toEqual(sorted(EXPECTED))
	})

	test('the writer exists and validates the context before any write', () => {
		const start = SOURCE.indexOf('private async commitDeliveryProgress(')
		expect(start).toBeGreaterThan(0)
		const body = SOURCE.slice(start, SOURCE.indexOf('\n\t}\n', start))
		expect(body).toContain('deliveryContextChanged')
	})

	test('deliveryContextChanged compares every field of the context', () => {
		const start = SOURCE.indexOf('private deliveryContextChanged(')
		const body = SOURCE.slice(start, SOURCE.indexOf('\n\t}\n', start))
		for (const field of [
			'sessionEpoch !== context.epoch',
			'connectionGeneration !== context.connection',
			'deliverySignature() !== context.signature',
			'principal !== context.principal',
			'context.staging',
			'position.watermark !== context.watermark',
			'deliveryGeneration !== context.generation',
			'rulesKey',
		]) {
			expect(body, field).toContain(field)
		}
	})

	test('the full resync is documented as serialized with batch handling', () => {
		const at = SOURCE.indexOf('private async resetDeliveryForFullResync(')
		expect(SOURCE.slice(Math.max(0, at - 900), at)).toContain(
			'INVARIANT: this is serialized with batch handling',
		)
	})
})

/** Replaces `from` (which must occur exactly once) with `to`. */
function replaceOnce(source: string, from: string, to: string): string {
	expect(source.split(from).length - 1, `anchor: ${from.slice(0, 60)}`).toBe(1)
	return source.replace(from, to)
}

/**
 * The engine reduced to what a snippet needs to be judged: the imports, the class header and the two
 * checks the rules recognise by name (`positionMoved`, `deliveryContextChanged`). Scanning 7,600 lines
 * for every one of the ~150 spelling tests cost 0.1 s alone and several times that on a loaded
 * runner; a snippet's finding does not depend on the rest of the engine (a validation run compares
 * every snippet against the full engine, see `KORA_SCAN_VALIDATE`).
 */
const REDUCED_BASE = (() => {
	const classAt = SOURCE.indexOf('export class SyncEngine {')
	const method = (name: string): string => {
		const start = SOURCE.indexOf(`\tprivate ${name}(`)
		return SOURCE.slice(start, SOURCE.indexOf('\n\t}\n', start) + 4)
	}
	return `${SOURCE.slice(0, classAt)}export class SyncEngine {\n${method('positionMoved')}\n${method('deliveryContextChanged')}`
})()

/** The full engine with `members` added, remembered so that `detected` can judge them on the reduced one. */
const MEMBERS_OF = new Map<string, string>()

/** Adds `members` as new members of the SyncEngine class, right before `positionMoved`. */
function withMembers(members: string): string {
	const full = replaceOnce(
		SOURCE,
		'\tprivate positionMoved(',
		`${members}\n\tprivate positionMoved(`,
	)
	MEMBERS_OF.set(full, members)
	return full
}

/** The scan of the repository differs from the real one (something was added, moved or removed). */
let realRepository: string | undefined
let reducedRepository: string | undefined
function detected(engineSource: string): boolean {
	const full = (): boolean => {
		realRepository ??= JSON.stringify(repository(SOURCE))
		return JSON.stringify(repository(engineSource)) !== realRepository
	}
	const members = MEMBERS_OF.get(engineSource)
	if (members === undefined) return full()
	const alone = (source: string): string =>
		JSON.stringify(tally(scanFile(ENGINE, `${source}\n}\n`)))
	reducedRepository ??= alone(REDUCED_BASE)
	const reduced = alone(`${REDUCED_BASE}\n${members}`) !== reducedRepository
	if (process.env.KORA_SCAN_VALIDATE)
		expect(reduced, 'reduced engine agrees with the full one').toBe(full())
	return reduced
}

describe('the reduced engine the spelling tests scan agrees with the full engine', () => {
	// A fixed sample in every run (the full comparison of every snippet is `KORA_SCAN_VALIDATE=1`,
	// run by the nightly job): if the reduction ever drifts from the real scan, this fails first.
	const sample: Record<string, string> = {
		'a write of the persisted position':
			"\tprivate zz(): void { this.syncState.saveDeltaCursor('x', 1) }",
		'a bracket write of the watermark': "\tprivate zz(): void { this['deliveryWatermark'] = 1 }",
		'a hollow check before a mutation':
			"\tprivate async zz(context: DeliveryContext): Promise<void> { const moved = (): boolean => true\n\t\tif (moved()) return\n\t\tawait this.store.applyScopeRetraction('c', 'r', 1, { isCurrent: () => true }) }",
		'a harmless method': '\tprivate zz(): number { return 1 }',
	}
	for (const [name, member] of Object.entries(sample)) {
		test(name, () => {
			const members = `${member}\n`
			const full = withMembers(members)
			const alone = (source: string): string =>
				JSON.stringify(tally(scanFile(ENGINE, `${source}\n}\n`)))
			const reduced = alone(`${REDUCED_BASE}\n${members}`) !== alone(REDUCED_BASE)
			realRepository ??= JSON.stringify(repository(SOURCE))
			const fullFound = JSON.stringify(repository(full)) !== realRepository
			expect(reduced).toBe(fullFound)
		})
	}
})

/** A file other than the engine's, with `source`, is found to hold something unlisted. */
function detectedElsewhere(file: string, source: string): boolean {
	return scanFile(file, source).length > 0
}

describe('the rule sees every spelling of an escape (the eight the fifth review used, and more)', () => {
	const escapes: Record<string, string> = {
		'bracket access': "private evil(): void { this['deliveryWatermark'] = 5 }",
		'template-literal bracket access': 'private evil(): void { this[`deliveryWatermark`] = 5 }',
		'compound assignment': 'private evil(): void { this.deliveryWatermark += 1 }',
		increment: 'private evil(): void { this.deliveryWatermark++ }',
		'optional call':
			"private async evil(): Promise<void> { await this.syncState?.saveDeliveryWatermark?.('', 1) }",
		'destructured alias':
			"private async evil(): Promise<void> { const { saveDeliveryWatermark: save } = this.syncState ?? {}; await save?.('', 1) }",
		'generic method name':
			'private async evil<T>(value: T): Promise<T> { this.deliveryWatermark = 1; return value }',
		'arrow-property method': 'private evil = (): void => { this.deliveryWatermark = 1 }',
		'variable second argument':
			'private async evil(progress: never): Promise<void> { await this.syncState?.saveQuarantine?.([], progress) }',
		'spread arguments':
			'private async evil(args: never[]): Promise<void> { await this.syncState?.saveQuarantine?.(...args) }',
		'const self = this': 'private evil(): void { const self = this; self.deliveryWatermark = 1 }',
		'assignment alias of this':
			'private evil(): void { let self: unknown; self = this; void self }',
		'bracket access on a cast receiver':
			"private evil(): void { (this as unknown as { deliveryWatermark: number })['deliveryWatermark'] = 3 }",
		'template-literal access on a cast receiver':
			'private evil(): void { (this as unknown as { deliveryWatermark: number })[`deliveryWatermark`] = 3 }',
		'bracket access to a persistence method':
			"private async evil(): Promise<void> { await (this.syncState as { saveDeliveryWatermark?: (s: string, w: number) => Promise<void> })['saveDeliveryWatermark']?.('', 1) }",
		'an alias of this that touches nothing yet':
			'private evil(): unknown { const self = this; return self }',
		'Reflect.set': "private evil(): void { Reflect.set(this, 'deliveryWatermark', 1) }",
		// ---- the thirty-one spellings of the sixth review, and the structural ones
		'computed key built from literals':
			"private evil(): void { (this as any)['delivery' + 'Watermark'] = 1 }",
		'key held in a constant':
			"private evil(): void { const K = 'deliveryWatermark'; (this as any)[K] = 1 }",
		'Reflect through an alias': 'private evil(): void { const R = Reflect; R.set(this, "x", 1) }',
		'Object through globalThis':
			'private evil(): void { globalThis.Object.assign(this, { x: 1 }) }',
		'Object assign by bracket': "private evil(): void { Object['assign'](this, { x: 1 }) }",
		'Object.assign destructured':
			'private evil(): void { const { assign } = Object; assign(this, { x: 1 }) }',
		'a member of syncState by a variable name':
			"private async evil(name: string): Promise<void> { await (this.syncState as any)[name]('', 1) }",
		'a split method name':
			"private evil(): void { (this as any)['setView' + 'Watermark']('x', 1) }",
		'a bound persistence method':
			'private async evil(progress: never): Promise<void> { const f = this.syncState!.saveQuarantine!.bind(this.syncState); await f([], progress) }',
		'an unlisted live-database mutator, unguarded':
			"private async evil(): Promise<void> { await this.store.applyScopeRetraction?.('c', 'r') }",
		'a store mutator reached through a deferral':
			"private async evil(): Promise<void> { await this.store.deferScopeRetraction?.('c', 'r') }",
		'a run rebase':
			'private async evil(): Promise<void> { await this.store.rebaseDeliveryRun?.(1) }',
		'a write of the replica': 'private evil(): void { this.staging = null }',
		'a write of the user': "private evil(): void { this.principal = 'x' }",
		'a bump of the drop counter': 'private evil(): void { this.deliveryGeneration++ }',
		'a write of the offline watermarks':
			'private evil(): void { this.offlineWatermarks = new Map() }',
		'a write of the server frontier': 'private evil(): void { this.serverFrontier = 1 }',
		'the owner API from a new member': 'private evil(): void { this.position.moveTo(3) }',
		'the writer from a new member': 'private evil(): void { this.position.writer.advance(3) }',
		'the writer held in a variable':
			'private evil(): void { const { writer } = this.position; void writer }',
		'the unit key without a check':
			'private async evil(m: never): Promise<void> { await this.ensureOfflineUnit(m) }',
		'a new full-resync caller':
			'private async evil(): Promise<void> { await this.resetDeliveryForFullResync() }',
		'destructuring assignment': 'private evil(): void { [this.deliveryWatermark] = [1] }',
		'object destructuring assignment':
			'private evil(): void { ({ w: this.deliveryWatermark } = { w: 1 }) }',
		'cast receiver':
			'private evil(): void { (this as { deliveryWatermark: number }).deliveryWatermark = 3 }',
		'dynamic member name':
			"private evil(): void { const key = 'deliveryWatermark'; this[key as never] = 1 }",
		'Object.assign': 'private evil(): void { Object.assign(this, { deliveryWatermark: 1 }) }',
		'Object.defineProperty':
			"private evil(): void { Object.defineProperty(this, 'x', { value: 1 }) }",
		'Object.setPrototypeOf': 'private evil(): void { Object.setPrototypeOf(this, null) }',
		'Object.defineProperties':
			'private evil(): void { Object.defineProperties(this, { x: { value: 1 } }) }',
		'a view cache write': "private evil(): void { this.deliverySignatureWatermarks.set('x', 9) }",
		'the cache setter': "private evil(): void { this.setViewWatermark('x', 9) }",
		'the key save':
			"private async evil(): Promise<void> { await this.syncState?.saveAccessRulesKey?.('k') }",
		'a bare acknowledgment': 'private evil(): void { this.sendDeliveryAck(1, 1) }',
		'a stored reference':
			'private evil(): unknown { return this.syncState?.saveDeliveryWatermark }',
		'a narrowing without a guard':
			"private async evil(): Promise<void> { await this.store.applyCollectionNarrowing?.('c', {}, new Set()) }",
		'a retraction without a guard':
			'private async evil(m: never): Promise<void> { await this.applyDeliveredRetraction(m, 1) }',
	}
	for (const [name, member] of Object.entries(escapes)) {
		test(`a new member: ${name}`, () => {
			expect(detected(withMembers(`\t${member}\n`))).toBe(true)
		})
	}

	test('a second write inside a method that is allowed one (the whole-method hole)', () => {
		for (const method of ['startInternal', 'handleHandshakeResponse', 'commitDeliveryProgress']) {
			const pattern = new RegExp(`\\t(?:private )?(?:async )?${method}\\([^)]*\\)[^{]*\\{\\n`)
			const match = pattern.exec(SOURCE)
			expect(match, method).not.toBeNull()
			const at = (match?.index ?? 0) + (match?.[0].length ?? 0)
			const mutated = `${SOURCE.slice(0, at)}\t\tthis['deliveryWatermark'] += 1\n${SOURCE.slice(at)}`
			expect(detected(mutated), method).toBe(true)
		}
	})
})

describe('the rule sees a guard removed from the live-database mutations of a stale batch', () => {
	test('the unit key before the per-operation path', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\tawait this.ensureOfflineUnit(msg)',
			'\t\t\tawait this.ensureOfflineUnit(msg)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('the narrowing loop', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
			'\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('a retraction of the per-operation path', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\t\tif (moved()) return false\n\t\t\t\tconst at = isDeliveryBatch',
			'\t\t\t\tconst at = isDeliveryBatch',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('an await between the check and the mutation', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\tawait this.ensureOfflineUnit(msg)',
			'\t\t\tif (moved()) return stale()\n\t\t\tawait Promise.resolve()\n\t\t\tawait this.ensureOfflineUnit(msg)',
		)
		expect(detected(mutated)).toBe(true)
	})

	test('a check before the loop does not cover the iterations after an await', () => {
		const mutated = replaceOnce(
			SOURCE,
			'\t\t\tif (moved()) return stale()\n\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
			'\t\t\ttry {\n\t\t\t\tif (!this.store.applyCollectionNarrowing)',
		).replace(
			'\t\tfor (const [collection, scope] of Object.entries(msg.accessNarrowing ?? {})) {',
			'\t\tif (moved()) return stale()\n\t\tfor (const [collection, scope] of Object.entries(msg.accessNarrowing ?? {})) {',
		)
		expect(detected(mutated)).toBe(true)
	})
})

describe('the rule sees an escape outside the engine file', () => {
	const elsewhere: Record<string, [string, string]> = {
		'a subclass changing the position': [
			'packages/sync/src/engine/evil.ts',
			"import { SyncEngine } from './sync-engine'\nexport class Evil extends SyncEngine { evil(): void { (this as never as { position: { moveTo(n: number): void } }).position.moveTo(1) } }",
		],
		'a prototype patch of a persistence writer': [
			'packages/sync/src/engine/evil.ts',
			'export function patch(engine: { prototype: Record<string, unknown> }): void { engine.prototype.setViewWatermark = (): void => undefined; void engine.prototype.persistDeliveryWatermark }',
		],
		'an import of the position class': [
			'packages/sync/src/engine/evil.ts',
			"import { DeliveryPosition } from './delivery-position'\nexport const p = new DeliveryPosition()",
		],
		'a helper writing the durable watermark': [
			'packages/sync/src/reactivity/evil.ts',
			"export async function w(s: { saveDeliveryWatermark(sig: string, n: number): Promise<void> }): Promise<void> { await s.saveDeliveryWatermark('', 9) }",
		],
		'a store method forwarding the key': [
			'packages/store/src/store/evil.ts',
			"export async function k(s: { saveAccessRulesKey(k: string): Promise<void> }): Promise<void> { await s.saveAccessRulesKey('x') }",
		],
		'a free persistence function imported into the sync package': [
			'packages/sync/src/engine/evil.ts',
			"import { saveUnappliedOperationsInTx } from '@korajs/store/internal'\nexport const x = saveUnappliedOperationsInTx",
		],
		'a free persistence function called under its own name': [
			'packages/store/src/sync/evil.ts',
			'declare function saveDeliveryWatermark(n: number): Promise<void>\nexport async function w(): Promise<void> { await saveDeliveryWatermark(1) }',
		],
		'a free persistence function imported with an alias': [
			'kora/src/evil.ts',
			"import { saveDeliveryWatermark as save } from '@korajs/store/internal'\nexport const x = save",
		],
		'a free persistence function stored in a variable': [
			'packages/store/src/sync/evil.ts',
			'declare function saveDeliveryWatermark(n: number): Promise<void>\nexport const f = saveDeliveryWatermark',
		],
		'a free persistence function returned': [
			'packages/store/src/sync/evil.ts',
			'declare function persistDeliveryWatermark(n: number): Promise<void>\nexport function g() { return persistDeliveryWatermark }',
		],
		'a free persistence function passed as an argument': [
			'packages/sync/src/engine/evil.ts',
			'declare function sendDeliveryAck(n: number): void\nexport const h = [1].map(sendDeliveryAck)',
		],
		'a kora adapter calling the position writer': [
			'kora/src/evil.ts',
			'export function a(w: { writer: { advance(n: number): void } }): void { w.writer.advance(1) }',
		],
	}
	for (const [name, [file, source]] of Object.entries(elsewhere)) {
		test(name, () => {
			expect(detectedElsewhere(file, source)).toBe(true)
		})
	}
})

describe('the seventh review: every spelling it found is a finding (no scan-hole class left)', () => {
	const C = 'context: DeliveryContext | null'
	const seventhMembers: Record<string, string> = {
		'N01 binding computed string key':
			"private evil(): void { const { ['moveTo']: m } = this.position; m.call(this.position, 5) }",
		'N02 binding string-literal key':
			"private evil(): void { const { 'moveTo': m } = this.position; m.call(this.position, 5) }",
		'N03 binding computed concat key':
			"private evil(): void { const { ['move' + 'To']: m } = this.position; m.call(this.position, 5) }",
		'N04 writer via computed binding':
			"private evil(): void { const { ['writer']: w } = this.position; void w }",
		'N05 eval': "private evil(): void { eval('this.position.moveTo(1)') }",
		'N06 new Function': "private evil(): void { new Function('p', 'p.moveTo(1)')(this.position) }",
		'N07 same-statement await after guard': `private async evil(${C}, o: Operation): Promise<void> { if (this.positionMoved(context)) return; await (await Promise.resolve(), this.applyInbound(o, null, undefined, context)) }`,
		'N08 guard result ignored': `private async evil(${C}, o: Operation): Promise<void> { this.positionMoved(context); await this.applyInbound(o, null, undefined, context) }`,
		'N09 guard in non-gating branch': `private async evil(${C}, o: Operation, x: boolean): Promise<void> { if (x) { if (this.positionMoved(context)) return } await this.applyInbound(o, null, undefined, context) }`,
		'N10 guard then deferred call via reference': `private async evil(${C}, o: Operation): Promise<void> { if (this.positionMoved(context)) return; const f = this.applyInbound; await Promise.resolve(); await f.call(this, o, null) }`,
		'N11 applyAtPosition direct':
			'private async evil(o: Operation): Promise<void> { await this.applyAtPosition(o, { position: 1, replay: false }) }',
		'N12 store.applyRemoteOperation direct':
			'private async evil(o: Operation): Promise<void> { await this.store.applyRemoteOperation(o) }',
		'N13 store.applyScopeNarrowing direct':
			'private async evil(): Promise<void> { await this.store.applyScopeNarrowing?.({}, {}) }',
		'N14 store.applyDeliveryBatch direct':
			'private async evil(): Promise<void> { await (this.store as any).applyDeliveryBatch?.() }',
		'N15 offlineWatermarks.set': "private evil(): void { this.offlineWatermarks.set('x', 9) }",
		'N16 offlineWatermarks.clear': 'private evil(): void { this.offlineWatermarks.clear() }',
		'N17 write to staging field':
			'private evil(): void { if (this.staging) this.staging.watermark = 0 }',
		'N18 write to context.watermark': `private evil(${C}): void { if (context) context.watermark = 99 }`,
		'N19 write to context.signature': `private evil(${C}): void { if (context) context.signature = this.deliverySignature() }`,
		'N20 context.generation write': `private evil(${C}): void { if (context) context.generation = this.deliveryGeneration }`,
		'N21 replace position object':
			'private evil(): void { (this as unknown as { position: DeliveryPosition }).position = new DeliveryPosition() }',
		'N22 dynamic import':
			"private async evil(): Promise<void> { const m = await import('./delivery-position'); void new m.PositionWriter(this.position) }",
		'N23 Proxy of position': 'private evil(): unknown { return new Proxy(this.position, {}) }',
		'N24 raw SQL meta key':
			'private async evil(): Promise<void> { await (this.store as any).adapter.execute("DELETE FROM _kora_meta WHERE key LIKE \'delivery_watermark%\'") }',
		'N25 shadowed always-false moved':
			'private async evil(o: Operation): Promise<void> { const moved = (): boolean => false; if (moved()) return; await this.applyInbound(o, null, undefined, context) }',
		'N26 guard in earlier unrelated loop': `private async evil(${C}, o: Operation): Promise<void> { for (const _ of [1]) { if (this.positionMoved(context)) break } await this.applyInbound(o, null, undefined, context) }`,
		'N27 persist via Function.prototype.call':
			"private async evil(): Promise<void> { await Function.prototype.call.call((this.syncState as any).saveDeliveryWatermark, this.syncState, '', 1) }",
		'N28 getter on views is copy: set':
			"private evil(): void { (this.position.views as Map<string, number>).set('x', 1) }",
		'N29 emit event consumer calls writer (callback)':
			"private evil(): void { this.emitter?.on?.('x' as never, () => { this.position.moveTo(1) }) }",
		'N30 sessionEpoch mutated via Object.assign alias':
			'private evil(): void { const o = Object; o.assign(this, {}) }',
		'N31 tagged template computed key':
			"private evil(): void { const k = `move${'To'}`; (this.position as any)[k](1) }",
		'N32 recheckAccessNarrowing in new unguarded member':
			'private async evil(): Promise<void> { await this.recheckAccessNarrowing(false) }',
		'N33 for-await guard': `private async evil(${C}, o: Operation): Promise<void> { if (this.positionMoved(context)) return; for await (const _ of (async function*(){ yield 1 })()) {} await this.applyInbound(o, null, undefined, context) }`,
		'N34 guard then yield/then-chain': `private evil(${C}, o: Operation): Promise<unknown> { if (this.positionMoved(context)) return Promise.resolve(); return Promise.resolve().then(() => this.applyInbound(o, null, undefined, context)) }`,
		'N36 gate by a method of another object': `private async evil(${C}, o: Operation): Promise<void> { if (this.position.positionMoved(context)) return; await this.applyInbound(o, null, undefined, context) }`,
		'N37 collection state handed out': 'private evil(): unknown { return this.offlineWatermarks }',
		'N38 collection state aliased then cleared':
			'private evil(): void { const m = this.offlineWatermarks; m.clear() }',
		'N39 constructor-built code':
			"private evil(): unknown { return (async () => undefined).constructor('return 1') }",
		'N40 the position field replaced':
			'private evil(): void { this.position = undefined as never }',
		'N41 check bound to a local name':
			'private evil(): unknown { const { positionMoved: pm } = this.position; return pm }',
		'N42 string-keyed check in a binding':
			"private evil(): unknown { const { 'deliveryContextChanged': d } = this.position; return d }",
		'N43 for-await loop holding an unawaited mutation': `private async evil(${C}, o: Operation): Promise<void> { if (this.positionMoved(context)) return; for await (const _ of this.pending()) { void this.applyInbound(o, null, undefined, context) } }`,
		'N44 generator yielding in the condition of a branch holding a mutation': `private *evil(${C}, o: Operation): Generator<number> { if (this.positionMoved(context)) return; if (yield 1) { void this.applyInbound(o, null, undefined, context) } }`,
		'N35 awaits inside conditional before call same stmt': `private async evil(${C}, o: Operation): Promise<void> { if (this.positionMoved(context)) return; const r = await this.outboundQueue.initialize().then(() => this.applyInbound(o, null, undefined, context)); void r }`,
	}
	const seventhElsewhere: Record<string, [string, string]> = {
		'E01 prototype patch of guard': [
			'kora/src/evil.ts',
			"export function p(E: { prototype: Record<string, unknown> }): void { E.prototype['deliveryContextChanged'] = (): boolean => false }",
		],
		'E02 raw sql watermark in store': [
			'packages/store/src/store/evil.ts',
			"export async function w(a: { execute(s: string): Promise<void> }): Promise<void> { await a.execute(\"UPDATE _kora_meta SET value = '0' WHERE key LIKE 'delivery_watermark%'\") }",
		],
		'E03 namespace import of sync package': [
			'kora/src/evil.ts',
			"import * as S from '@korajs/sync'\nexport const x = new S.DeliveryPosition()",
		],
		'E04 computed destructure in kora': [
			'kora/src/evil.ts',
			"export function a(p: Record<string, (n: number) => void>): void { const { ['moveTo']: m } = p; m(1) }",
		],
		'E05 computed destructure persistence': [
			'kora/src/evil.ts',
			"export async function a(s: Record<string, (a: string, n: number) => Promise<void>>): Promise<void> { const { ['saveDeliveryWatermark']: f } = s; await f('', 1) }",
		],
		'E06 string-key destructure persistence': [
			'packages/store/src/sync/evil.ts',
			"export async function a(s: Record<string, (a: string, n: number) => Promise<void>>): Promise<void> { const { 'saveDeliveryWatermark': f } = s; await f('', 1) }",
		],
		'E07 bracket on non-engine file w/ dynamic key': [
			'kora/src/store-sync-state.ts',
			"export function a(s: any, k: string): void { s[k]('', 1) }",
		],
		'E08 Reflect in kora': [
			'kora/src/store-sync-state.ts',
			"export function a(s: object): void { Reflect.set(s, 'x', 1) }",
		],
		'E10 position key in a template literal': [
			'packages/store/src/store/evil.ts',
			"export const q = (s: string): string => `DELETE FROM _kora_meta WHERE key = 'delivery_watermark:${s}'`",
		],
		'E09 apply/mutator in store unguarded (applyScopeRetraction)': [
			'packages/store/src/store/evil.ts',
			"export async function a(s: { applyScopeRetraction(c: string, r: string): Promise<void> }): Promise<void> { await s.applyScopeRetraction('c','r') }",
		],
	}
	for (const [name, member] of Object.entries(seventhMembers)) {
		test(`a new member: ${name}`, () => {
			expect(detected(withMembers(`\t${member}\n`)), name).toBe(true)
		})
	}
	for (const [name, [file, source]] of Object.entries(seventhElsewhere)) {
		test(`elsewhere: ${name}`, () => {
			expect(detectedElsewhere(file, source), name).toBe(true)
		})
	}
})

describe('the guard semantics: what counts as a check, and what does not', () => {
	const P = 'context: DeliveryContext | null, o: Operation, x: boolean'
	const CALL = 'await this.applyInbound(o, null, undefined, context)'
	const member = (body: string): string => `private async evil(${P}): Promise<void> { ${body} }`
	// Each of these has a synchronous check before the mutation, and must change nothing in the table.
	const gated: Record<string, string> = {
		'a plain gate': `if (this.positionMoved(context)) return; ${CALL}`,
		'a gate in an || chain': `if (x || this.positionMoved(context)) return; ${CALL}`,
		'a gate whose branch is a block that leaves': `if (this.positionMoved(context)) { void x; return }; ${CALL}`,
		'a gate that throws': `if (this.positionMoved(context)) throw new Error('stale'); ${CALL}`,
		'a local check that is the engine check': `const moved = (): boolean => this.positionMoved(context); if (moved()) return; ${CALL}`,
		'a gate in a loop body, per iteration': `for (const _ of [1, 2]) { if (this.positionMoved(context)) break; ${CALL} }`,
	}
	for (const [name, body] of Object.entries(gated)) {
		test(`a real gate is accepted: ${name}`, () => {
			expect(detected(withMembers(`\t${member(body)}\n`)), name).toBe(false)
		})
	}
	// Each of these looks like a check and is not one.
	const hollow: Record<string, string> = {
		'a gate joined with &&': `if (x && this.positionMoved(context)) return; ${CALL}`,
		'a check whose branch does not leave (block)': `if (this.positionMoved(context)) { void x }; ${CALL}`,
		'a check whose branch does not leave (statement)': `if (this.positionMoved(context)) void x; ${CALL}`,
		'a gate whose condition awaits': `if (this.positionMoved(await this.outboundQueue.initialize().then(() => context))) return; ${CALL}`,
		'a gate whose condition awaits first': `if ((await Promise.resolve(x)) || this.positionMoved(context)) return; ${CALL}`,
		'the check of another object': `if (this.position.positionMoved(context)) return; ${CALL}`,
		'a local check that always says no': `const moved = (): boolean => false; if (moved()) return; ${CALL}`,
		'a local check that calls something else': `const moved = (): boolean => x; if (moved()) return; ${CALL}`,
		'a parameter named moved': `if (moved()) return; ${CALL}`,
		'a check inside a nested function': `const f = (): boolean => { if (this.positionMoved(context)) return true; return false }; void f; ${CALL}`,
		'a for-await between the gate and the call': `if (this.positionMoved(context)) return; for await (const _ of this.pending()) { void _ }; ${CALL}`,
		'an await in the call arguments':
			'if (this.positionMoved(context)) return; await this.applyInbound(await Promise.resolve(o), null, undefined, context)',
		'an await earlier in the same statement':
			'if (this.positionMoved(context)) return; const r = (await Promise.resolve(1), await this.applyInbound(o, null, undefined, context)); void r',
		'an await in the condition of the branch holding the call': `if (this.positionMoved(context)) return; if (await Promise.resolve(x)) { ${CALL} }`,
		'an await in the condition of a while holding the call': `if (this.positionMoved(context)) return; while (await Promise.resolve(x)) { ${CALL}; break }`,
		'an await in the subject of a switch holding the call': `if (this.positionMoved(context)) return; switch (await Promise.resolve(x)) { case true: ${CALL} }`,
		'the call in a catch after an awaited try': `if (this.positionMoved(context)) return; try { await Promise.resolve() } catch { ${CALL} }`,
		'the call in a loop that awaits (gate before the loop)': `if (this.positionMoved(context)) return; for (const _ of [1, 2]) { ${CALL} }`,
		'a result that is ignored': `this.positionMoved(context); ${CALL}`,
		'a check in a branch that does not gate': `if (x) { if (this.positionMoved(context)) return }; ${CALL}`,
		'a mutation without the delivery context':
			'if (this.positionMoved(context)) return; await this.applyInbound(o, null)',
		'a mutation with a null context':
			'if (this.positionMoved(context)) return; await this.applyInbound(o, null, undefined, null)',
	}
	for (const [name, body] of Object.entries(hollow)) {
		test(`a hollow check is a finding: ${name}`, () => {
			const text = name.startsWith('a parameter named moved')
				? `private async evil(moved: () => boolean, ${P}): Promise<void> { ${body} }`
				: member(body)
			expect(detected(withMembers(`\t${text}\n`)), name).toBe(true)
		})
	}
})
