// Internal exports — shared within @kora packages but NOT part of the public API.
// Other @kora packages can import from '@korajs/sync/internal' if needed.

export { MemoryTransport, createMemoryTransportPair } from './transport/memory-transport'
export { MemoryQueueStorage } from './engine/memory-queue-storage'
export {
	buildScopeSnapshot,
	matchesScopePredicate,
	recordMatchesScopePredicates,
} from './scopes/scope-snapshot'
export { scopeViewKey } from './scopes/scope-view-key'
export { verifyInboundOperation, type InboundVerification } from './engine/verify-inbound'
