import type { KoraEventEmitter, Operation, SchemaDefinition } from '@korajs/core'
import { SyncError, generateUUIDv7, hashBlob } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type {
	AwarenessUpdateMessage,
	BlobChunkPushMessage,
	BlobChunkRequestMessage,
	BlobChunkResponseMessage,
	HandshakeMessage,
	MessageSerializer,
	OperationBatchMessage,
	SyncMessage,
	WireFormat,
	YjsDocUpdateMessage,
} from '@korajs/sync'
import { decodeBlobChunkBytes } from '@korajs/sync'
import {
	type DeltaCursor,
	NegotiatedMessageSerializer,
	SCHEMA_MISMATCH_PREFIX,
	type SyncQuerySubset,
	createDeltaCursorFromBatch,
	decodeDeltaCursor,
	dedupeQuerySubsets,
	encodeDeltaCursor,
	isClientSchemaVersionSupported,
	operationMatchesQuerySubsets,
	sliceOperationsAfterCursor,
	versionVectorToWire,
	wireToVersionVector,
} from '@korajs/sync'
import { applyServerOperation } from '../apply/apply-server-operation'
import type { OperationValidator } from '../apply/operation-validator'
import { isRetriableRejection } from '../apply/rejection-taxonomy'
import { NoAuthProvider } from '../auth/no-auth'
import { resolveSessionScopes } from '../scopes/resolve-session-scopes'
import { missingScopeFields, operationMatchesScopes } from '../scopes/server-scope-filter'
import type { ProductionHttpRouteContext } from '../server/route-context'
import type { DeliveredOperation, ServerStore } from '../store/server-store'
import type { ServerTransport } from '../transport/server-transport'
import type { AuthContext, AuthProvider } from '../types'
import { isOperationTimestampValid } from './operation-validation'
import {
	DEFAULT_MAX_OPERATION_BYTES,
	DEFAULT_MAX_OPS_PER_MINUTE,
	SessionRateLimiter,
	validateOperationSize,
} from './session-operation-limits'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1

/**
 * Tracks auth providers we have already warned about, so the multi-tenant
 * no-scopes guardrail fires once per server (keyed by provider instance)
 * rather than once per client connection.
 */
const warnedUnscopedProviders = new WeakSet<AuthProvider>()

/**
 * Warn once when a real (multi-user) auth provider is configured but an
 * authenticated session resolves to no sync scopes at all.
 *
 * With no scopes, `operationMatchesScopes` treats every operation as visible,
 * which is the correct zero-config behavior for a single-user local-first app.
 * But once a real auth provider is in play, "no scopes" means every user syncs
 * every other user's data — a silent cross-tenant data exposure. We cannot flip
 * the default to deny-all without breaking the zero-config promise, so instead
 * we surface the dangerous configuration loudly and exactly once.
 *
 * `null` auth (local-first, no auth) and `NoAuthProvider` (dev/testing) are
 * intentionally excluded: for those, unscoped sync is the intended behavior.
 */
function warnIfMultiTenantWithoutScopes(
	auth: AuthProvider | null,
	resolvedScopes: unknown,
	schema: SchemaDefinition | null,
): void {
	if (!auth || auth instanceof NoAuthProvider) {
		return
	}
	if (resolvedScopes) {
		return
	}
	if (!schema || Object.keys(schema.collections).length === 0) {
		return
	}
	if (warnedUnscopedProviders.has(auth)) {
		return
	}
	warnedUnscopedProviders.add(auth)
	console.warn(
		'[kora] An authenticated session resolved to no sync scopes, so every ' +
			"user will sync every other user's data. Return per-user sync scopes " +
			"from your auth provider (for example KoraAuthProvider's resolveScopes) " +
			'to isolate tenants. Note: declaring sync rules in your schema is not ' +
			'enough on its own — the per-user values come from the auth provider. ' +
			'(This warning is expected for single-tenant apps where all authenticated ' +
			'users are meant to share the same data.)',
	)
}

/**
 * Possible states for a client session.
 */
export type SessionState = 'connected' | 'authenticated' | 'syncing' | 'streaming' | 'closed'

/**
 * Callback invoked when a session has new operations to relay to other sessions.
 */
export type RelayCallback = (sourceSessionId: string, operations: Operation[]) => void

/**
 * Callback invoked when a session receives an awareness update to relay to other sessions.
 */
export type AwarenessRelayCallback = (
	sourceSessionId: string,
	message: AwarenessUpdateMessage,
) => void

/**
 * Callback invoked when a session receives a Yjs doc channel update to relay.
 */
export type YjsDocRelayCallback = (sourceSessionId: string, message: YjsDocUpdateMessage) => void

/**
 * Callback invoked when a session receives a blob chunk request to route.
 */
export type BlobChunkRequestCallback = (
	sourceSessionId: string,
	message: BlobChunkRequestMessage,
) => void

/**
 * Callback invoked when a session receives a blob chunk response to route back.
 */
export type BlobChunkResponseCallback = (
	sourceSessionId: string,
	message: BlobChunkResponseMessage,
) => void

/**
 * Persist a blob chunk (or manifest) uploaded by a client, keyed by its content
 * hash. Provided by the server operator; enables central blob storage so bytes
 * survive the authoring device going offline.
 */
export type PersistBlobChunk = (hash: string, bytes: Uint8Array) => Promise<void> | void

/**
 * Options for creating a ClientSession.
 */
export interface ClientSessionOptions {
	/** Unique session identifier */
	sessionId: string
	/** Transport for this client connection */
	transport: ServerTransport
	/** Server-side operation store */
	store: ServerStore
	/** Authentication provider (optional) */
	auth?: AuthProvider
	/** Message serializer */
	serializer?: MessageSerializer
	/** Event emitter for DevTools integration */
	emitter?: KoraEventEmitter
	/** Max operations per sync batch */
	batchSize?: number
	/** Schema version the server expects */
	schemaVersion?: number
	/** Inclusive client schema versions accepted at handshake */
	supportedSchemaVersions?: { min: number; max: number }
	/** Called when this session has operations to relay to other sessions */
	onRelay?: RelayCallback
	/** Called when this session receives an awareness update to broadcast */
	onAwarenessUpdate?: AwarenessRelayCallback
	/** Called when this session receives a Yjs doc channel update to broadcast */
	onYjsDocUpdate?: YjsDocRelayCallback
	/** Called when this session receives a blob chunk request to route */
	onBlobChunkRequest?: BlobChunkRequestCallback
	/** Called when this session receives a blob chunk response to route back */
	onBlobChunkResponse?: BlobChunkResponseCallback
	/** Persist a client-uploaded blob chunk centrally (keyed by content hash) */
	persistBlobChunk?: PersistBlobChunk
	/** Called when this session closes */
	onClose?: (sessionId: string) => void
	/**
	 * Called on close with relay operations this client never acknowledged, so the
	 * server can buffer them per node id and redeliver on the client's next
	 * connection. Closes the window where a relay dropped just before a reconnect
	 * would otherwise be lost (the per-session retransmit tick never fires in time).
	 */
	onOrphanedRelays?: (nodeId: string, ops: Operation[]) => void
	/**
	 * Called once this session reaches streaming to pull any relay operations buffered
	 * for its node id while it was disconnected. They are re-sent through the normal
	 * relay path (re-filtered by this session's current scope).
	 */
	takeOrphanedRelays?: (nodeId: string) => Operation[]
	/** Maximum serialized operation size in bytes. Defaults to 256 KiB. */
	maxOperationBytes?: number
	/** Maximum operations accepted per minute for this session. Defaults to 600. */
	maxOpsPerMinute?: number
	/**
	 * Adjudicate untrusted client operations before materialization. When present,
	 * each incoming operation is passed to this validator; a `reject` decision
	 * sends an operation-rejected message and skips materialization.
	 */
	validateOperation?: OperationValidator
	/** Trusted data-plane context handed to the validator (read state, author derived ops). */
	koraContext?: ProductionHttpRouteContext
}

/**
 * Handles the sync protocol for a single connected client.
 *
 * Lifecycle: connected → (authenticated) → syncing → streaming → closed
 *
 * The session:
 * 1. Receives a handshake from the client
 * 2. Authenticates if an AuthProvider is configured
 * 3. Sends back a HandshakeResponse with the server's version vector
 * 4. Computes and sends the server's delta to the client (paginated)
 * 5. Processes incoming operation batches from the client
 * 6. Transitions to streaming for real-time bidirectional sync
 * 7. Relays new operations to other sessions via the RelayCallback
 */
export class ClientSession {
	private state: SessionState = 'connected'
	private clientNodeId: string | null = null
	private authContext: AuthContext | null = null
	private syncQuerySubsets: SyncQuerySubset[] = []
	private resumeDeltaCursor: DeltaCursor | null = null

	/**
	 * The delivery watermark the client reported at handshake, or null when the client
	 * does not use the delivery watermark (old client, or no watermark yet). When set,
	 * the server drives the gap-free server->client stream from delivery sequences
	 * instead of the version-vector delta.
	 */
	private clientDeliveryWatermark: number | null = null
	/**
	 * The highest delivery sequence this client has ACKNOWLEDGED (its confirmed
	 * watermark, as reported in acks). Incremental streaming pushes resume from here, not
	 * from the highest sequence sent, so a dropped or unapplied batch is always
	 * re-included by the next push (which re-scans from the acknowledged position). This
	 * is what makes streaming recovery independent of any bounded retransmit buffer: there
	 * is no sent-but-unacked window that a buffer eviction could strand. Seeded from the
	 * client's reported watermark at handshake.
	 */
	private lastAckedDeliverySeq = 0
	/** Serializes incremental delivery pushes so their batches never interleave. */
	private deliveryPushChain: Promise<void> = Promise.resolve()

	/**
	 * Relay batches sent to this client but not yet acknowledged, keyed by messageId.
	 * The client acks every operation-batch it applies; on ack the entry is cleared.
	 * {@link retransmitPendingRelays} re-sends anything still unacked, so a relay
	 * dropped by a lossy transport is redelivered instead of leaving the client with a
	 * permanent version-vector gap (a lost operation) that delta sync cannot recover.
	 * Bounded so a silent client cannot grow it without limit.
	 */
	private readonly pendingRelays = new Map<
		string,
		{ message: SyncMessage; ops: Operation[]; sentAtMs: number }
	>()
	private static readonly MAX_PENDING_RELAYS = 1000

	private readonly sessionId: string
	private readonly transport: ServerTransport
	private readonly store: ServerStore
	private readonly auth: AuthProvider | null
	private readonly serializer: MessageSerializer
	private readonly emitter: KoraEventEmitter | null
	private readonly batchSize: number
	private readonly schemaVersion: number
	private readonly supportedSchemaVersions: { min: number; max: number }
	private readonly onRelay: RelayCallback | null
	private readonly onAwarenessUpdate: AwarenessRelayCallback | null
	private readonly onYjsDocUpdate: YjsDocRelayCallback | null
	private readonly onBlobChunkRequest: BlobChunkRequestCallback | null
	private readonly onBlobChunkResponse: BlobChunkResponseCallback | null
	private readonly persistBlobChunk: PersistBlobChunk | null
	private readonly onClose: ((sessionId: string) => void) | null
	private readonly onOrphanedRelays: ((nodeId: string, ops: Operation[]) => void) | null
	private readonly takeOrphanedRelays: ((nodeId: string) => Operation[]) | null
	private readonly maxOperationBytes: number
	private readonly maxOpsPerMinute: number
	private readonly rateLimiter: SessionRateLimiter
	private readonly validateOperation: OperationValidator | null
	private readonly koraContext: ProductionHttpRouteContext | null

	constructor(options: ClientSessionOptions) {
		this.sessionId = options.sessionId
		this.transport = options.transport
		this.store = options.store
		this.auth = options.auth ?? null
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const supported = options.supportedSchemaVersions
		this.supportedSchemaVersions = supported ?? {
			min: this.schemaVersion,
			max: this.schemaVersion,
		}
		this.onRelay = options.onRelay ?? null
		this.onAwarenessUpdate = options.onAwarenessUpdate ?? null
		this.onYjsDocUpdate = options.onYjsDocUpdate ?? null
		this.onBlobChunkRequest = options.onBlobChunkRequest ?? null
		this.onBlobChunkResponse = options.onBlobChunkResponse ?? null
		this.persistBlobChunk = options.persistBlobChunk ?? null
		this.onClose = options.onClose ?? null
		this.onOrphanedRelays = options.onOrphanedRelays ?? null
		this.takeOrphanedRelays = options.takeOrphanedRelays ?? null
		this.maxOperationBytes = options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES
		this.maxOpsPerMinute = options.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE
		this.rateLimiter = new SessionRateLimiter(this.maxOpsPerMinute)
		this.validateOperation = options.validateOperation ?? null
		this.koraContext = options.koraContext ?? null
	}

	/**
	 * Start handling messages from the client transport.
	 */
	start(): void {
		this.transport.onMessage((msg) => this.enqueueMessage(msg))
		this.transport.onClose((_code, _reason) => this.handleTransportClose())
		this.transport.onError((_err) => {
			// Transport errors during active session cause close
			if (this.state !== 'closed') {
				this.handleTransportClose()
			}
		})
	}

	/**
	 * Relay operations from another session to this client.
	 * Only relays if the session is in streaming state and transport is connected.
	 */
	relayOperations(operations: Operation[]): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		// A delivery-watermark client is fed by the gap-free delivery stream, resumed from
		// the last sequence sent to it, so its watermark keeps advancing live and a
		// reconnect resends only what was genuinely missed. The specific operations from
		// the fan-out are only a wake-up: the push pulls everything in scope after the send
		// cursor from the delivery log, which is the authoritative, contiguous order.
		if (this.clientDeliveryWatermark !== null) {
			this.pushDeliveryStream()
			return
		}
		if (operations.length === 0) return
		// Visibility now requires an async record lookup (scope/subset backfill); relay
		// is fire-and-forget, so run it without blocking the caller's fan-out loop.
		void this.relayVisibleOperations(operations)
	}

	/**
	 * Push newly-available in-scope operations to a delivery-watermark client, resuming
	 * from the highest delivery sequence already sent. Pushes are serialized so their
	 * batches never interleave (which would break the base/max chain).
	 */
	private pushDeliveryStream(): void {
		this.deliveryPushChain = this.deliveryPushChain.then(async () => {
			if (this.state !== 'streaming' || !this.transport.isConnected()) return
			try {
				// Resume from the client's last acknowledged sequence, not the last sent, so a
				// dropped or unapplied batch is re-included here. Exclude the client's own
				// operations during streaming; it already has them.
				await this.sendDeliveryStream(
					this.lastAckedDeliverySeq,
					false,
					this.clientNodeId ?? undefined,
				)
			} catch {
				// A failed push (e.g. a transient store read error) must not reject the chain
				// and stall all future pushes. The next push, or a reconnect resend from the
				// client's watermark, recovers anything this push did not deliver.
			}
		})
	}

	private async relayVisibleOperations(operations: Operation[]): Promise<void> {
		const visibleOperations: Operation[] = []
		for (const op of operations) {
			if (await this.operationVisibleToClient(op)) {
				visibleOperations.push(op)
			}
		}
		if (visibleOperations.length === 0) return
		// Re-check liveness: an await may have elapsed since the caller's guard.
		if (this.state !== 'streaming' || !this.transport.isConnected()) return

		const serializedOps = visibleOperations.map((op) => this.serializer.encodeOperation(op))
		const msg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: serializedOps,
			isFinal: true,
			batchIndex: 0,
		}
		// Track this relay until the client acks it, so a drop can be retransmitted.
		this.trackPendingRelay(msg, visibleOperations)
		this.sendToClient(msg)
	}

	/** Record a relay batch as awaiting acknowledgment, evicting the oldest if full. */
	private trackPendingRelay(msg: SyncMessage, ops: Operation[]): void {
		if (this.pendingRelays.size >= ClientSession.MAX_PENDING_RELAYS) {
			const oldest = this.pendingRelays.keys().next().value
			if (oldest !== undefined) {
				this.pendingRelays.delete(oldest)
			}
		}
		this.pendingRelays.set(msg.messageId, { message: msg, ops, sentAtMs: Date.now() })
	}

	/**
	 * Retransmit relay batches this client has not acknowledged within `staleMs`.
	 * Called on a periodic tick by the server (and directly by tests). Redelivering an
	 * already-applied op is harmless: the client dedups by content-addressed id.
	 */
	retransmitPendingRelays(staleMs = 0): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		// A delivery-watermark client recovers a dropped or stalled batch by re-pushing
		// from its last acknowledged position (which re-includes anything unapplied), so a
		// gap is recovered on the next tick even with no new operations and with no reliance
		// on the bounded relay buffer. When the client is caught up the re-push is a no-op.
		if (this.clientDeliveryWatermark !== null) {
			this.pushDeliveryStream()
			return
		}
		if (this.pendingRelays.size === 0) return
		const cutoff = Date.now() - staleMs
		for (const { message, sentAtMs } of this.pendingRelays.values()) {
			if (sentAtMs <= cutoff) {
				this.sendToClient(message)
			}
		}
	}

	/**
	 * Close this session.
	 */
	/**
	 * Hand any unacknowledged relays to the server so they survive this session and are
	 * redelivered when this client reconnects (per-node buffer), then clear them. Called
	 * from every session-teardown path (explicit close and transport close).
	 */
	private flushOrphanedRelays(): void {
		if (this.onOrphanedRelays && this.clientNodeId && this.pendingRelays.size > 0) {
			const ops: Operation[] = []
			for (const entry of this.pendingRelays.values()) {
				ops.push(...entry.ops)
			}
			if (ops.length > 0) {
				this.onOrphanedRelays(this.clientNodeId, ops)
			}
		}
		this.pendingRelays.clear()
	}

	close(reason?: string): void {
		if (this.state === 'closed') return
		this.state = 'closed'
		this.flushOrphanedRelays()

		if (this.transport.isConnected()) {
			this.transport.close(1000, reason ?? 'session closed')
		}

		this.onClose?.(this.sessionId)
	}

	// --- Getters ---

	getState(): SessionState {
		return this.state
	}

	getSessionId(): string {
		return this.sessionId
	}

	getClientNodeId(): string | null {
		return this.clientNodeId
	}

	getAuthContext(): AuthContext | null {
		return this.authContext
	}

	isStreaming(): boolean {
		return this.state === 'streaming'
	}

	/**
	 * Get the transport for this session.
	 * Used by the awareness relay to send messages to this client.
	 */
	getTransport(): ServerTransport {
		return this.transport
	}

	// --- Private protocol handlers ---

	private messageChain: Promise<void> = Promise.resolve()

	/** Send to the client when the transport is still connected; no-op otherwise. */
	private sendToClient(message: SyncMessage): boolean {
		if (!this.transport.isConnected()) {
			return false
		}
		try {
			this.transport.send(message)
			return true
		} catch {
			return false
		}
	}

	private enqueueMessage(message: SyncMessage): void {
		this.messageChain = this.messageChain
			.then(() => this.handleMessageAsync(message))
			.catch((error) => this.handleMessageFailure(error))
	}

	private async handleMessageAsync(message: SyncMessage): Promise<void> {
		switch (message.type) {
			case 'handshake':
				await this.handleHandshake(message)
				break
			case 'operation-batch':
				await this.handleOperationBatch(message)
				break
			case 'acknowledgment':
				this.pendingRelays.delete(message.acknowledgedMessageId)
				if (message.deliverySequence !== undefined) {
					// Advance the confirmed watermark; the next streaming push resumes here.
					this.lastAckedDeliverySeq = Math.max(this.lastAckedDeliverySeq, message.deliverySequence)
				}
				break
			case 'error':
				break
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				this.handleYjsDocUpdate(message)
				break
			case 'blob-chunk-request':
				this.onBlobChunkRequest?.(this.sessionId, message)
				break
			case 'blob-chunk-response':
				this.onBlobChunkResponse?.(this.sessionId, message)
				break
			case 'blob-chunk-push':
				await this.handleBlobChunkPush(message)
				break
		}
	}

	/**
	 * Persist a client-uploaded blob chunk (or manifest) centrally. The bytes are
	 * verified to hash to the declared hash before storing, so a corrupt or
	 * mislabeled upload is rejected rather than served later as trusted content.
	 */
	private async handleBlobChunkPush(message: BlobChunkPushMessage): Promise<void> {
		if (!this.persistBlobChunk) {
			return
		}
		const bytes = decodeBlobChunkBytes(message.bytes)
		const actual = await hashBlob(bytes)
		if (actual !== message.hash) {
			// Reject a mismatched upload rather than persisting untrusted bytes.
			return
		}
		await this.persistBlobChunk(message.hash, bytes)
	}

	private handleMessageFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.sendError('SYNC_ERROR', reason, true)
		this.close(reason)
	}

	private async handleHandshake(msg: HandshakeMessage): Promise<void> {
		// Only accept handshake in 'connected' state (prevent duplicate handshakes)
		if (this.state !== 'connected') {
			this.sendError('DUPLICATE_HANDSHAKE', 'Handshake already completed', false)
			return
		}

		this.clientNodeId = msg.nodeId

		// Authenticate if provider is configured
		if (this.auth) {
			const token = msg.authToken ?? ''
			const context = await this.auth.authenticate(token)
			if (!context) {
				this.sendError('AUTH_FAILED', 'Authentication failed', false)
				this.close('authentication failed')
				return
			}
			this.authContext = context
			this.state = 'authenticated'
		}

		// Merge handshake sync scopes with auth scopes using schema sync rules.
		const resolvedScopes = resolveSessionScopes(this.store.getSchema(), {
			handshakeScope: msg.syncScope,
			authScopes: this.authContext?.scopes,
		})

		if (resolvedScopes) {
			if (this.authContext) {
				this.authContext = { ...this.authContext, scopes: resolvedScopes }
			} else {
				this.authContext = { userId: msg.nodeId, scopes: resolvedScopes }
			}
		}

		warnIfMultiTenantWithoutScopes(this.auth, resolvedScopes, this.store.getSchema())

		if (msg.syncQueries && msg.syncQueries.length > 0) {
			this.syncQuerySubsets = dedupeQuerySubsets(msg.syncQueries)
		} else {
			this.syncQuerySubsets = []
		}

		this.resumeDeltaCursor = msg.deltaCursor ? decodeDeltaCursor(msg.deltaCursor) : null
		this.clientDeliveryWatermark = msg.lastDeliverySequence ?? null

		// Only read the server's delivery frontier when the client actually uses the
		// watermark. If the client's reported watermark exceeds that frontier, the server's
		// log was rolled back (for example a backup restore reset the sequence), so resync
		// that client from the beginning rather than let it sit above a frontier that no
		// longer exists; the server advertises its max so the client resets to match.
		const clientUsesWatermark = this.clientDeliveryWatermark !== null
		let serverMaxDelivery = 0
		if (clientUsesWatermark) {
			serverMaxDelivery = await this.store.getMaxDeliverySequence()
			if (
				this.clientDeliveryWatermark !== null &&
				this.clientDeliveryWatermark > serverMaxDelivery
			) {
				this.clientDeliveryWatermark = 0
			}
		}

		const serverVector = this.store.getVersionVector()
		const selectedWireFormat = selectWireFormat(msg.supportedWireFormats)
		this.setSerializerWireFormat(selectedWireFormat)

		if (!isClientSchemaVersionSupported(msg.schemaVersion, this.supportedSchemaVersions)) {
			const { min, max } = this.supportedSchemaVersions
			const response: SyncMessage = {
				type: 'handshake-response',
				messageId: generateUUIDv7(),
				nodeId: this.store.getNodeId(),
				versionVector: versionVectorToWire(serverVector),
				schemaVersion: this.schemaVersion,
				accepted: false,
				rejectReason: `${SCHEMA_MISMATCH_PREFIX}: client schema version ${msg.schemaVersion} not in supported range [${min}, ${max}]`,
				supportedSchemaMin: min,
				supportedSchemaMax: max,
				serverTime: Date.now(),
			}
			this.sendToClient(response)
			this.close('schema version mismatch')
			return
		}

		// Send handshake response with server's version vector and accepted scope
		const response: SyncMessage = {
			type: 'handshake-response',
			messageId: generateUUIDv7(),
			nodeId: this.store.getNodeId(),
			versionVector: versionVectorToWire(serverVector),
			schemaVersion: this.schemaVersion,
			accepted: true,
			selectedWireFormat,
			serverTime: Date.now(),
			// The server's highest delivery sequence, so a client whose persisted watermark
			// is ahead of it (server rolled back) can reset to a full resync. Sent only to
			// watermark-using clients.
			...(clientUsesWatermark ? { serverMaxDeliverySequence: serverMaxDelivery } : {}),
			// Advertise central blob storage so the client uploads the bytes behind
			// its blob fields, keeping them available after the author goes offline.
			...(this.persistBlobChunk ? { blobStorageEnabled: true } : {}),
			// Confirm the accepted scope so the client knows what data will be synced.
			// This may differ from what the client requested if auth scopes are narrower.
			...(this.authContext?.scopes ? { acceptedScope: this.authContext.scopes } : {}),
		}
		this.sendToClient(response)

		this.emitter?.emit({ type: 'sync:connected', nodeId: msg.nodeId })

		// Transition to syncing and send the server->client stream. A client that
		// reports a delivery watermark gets the gap-free delivery stream (resumed from
		// that watermark); an older client gets the version-vector delta. Both send only
		// operations visible in this session's scope.
		this.state = 'syncing'
		if (this.clientDeliveryWatermark !== null) {
			this.lastAckedDeliverySeq = this.clientDeliveryWatermark
			// Resuming from a non-zero watermark: the client already holds its own history,
			// so exclude its own operations. A full resync (watermark 0, e.g. a fresh or
			// recovered client) passes no exclusion so it recovers everything, its own
			// operations included.
			const excludeOwn =
				this.clientDeliveryWatermark > 0 ? (this.clientNodeId ?? undefined) : undefined
			await this.sendDeliveryStream(this.clientDeliveryWatermark, true, excludeOwn)
		} else {
			const clientVector = wireToVersionVector(msg.versionVector)
			await this.sendDelta(clientVector)
		}

		// Transition to streaming after delta is sent
		this.state = 'streaming'

		// Redeliver any relays buffered while this client's node id was disconnected
		// (dropped just before a prior reconnect). relayOperations re-filters them by
		// this session's current scope and re-tracks them for acknowledgment.
		if (this.takeOrphanedRelays && this.clientNodeId) {
			const buffered = this.takeOrphanedRelays(this.clientNodeId)
			if (buffered.length > 0) {
				this.relayOperations(buffered)
			}
		}
		// A delivery-watermark client needs no explicit drain here: an operation committed
		// during the handshake-scan-to-streaming window is picked up by the next streaming
		// push (or the retransmit tick), which resumes from the client's acknowledged
		// position. Draining here would re-scan from the not-yet-advanced acknowledged
		// position and re-send the whole handshake stream.
	}

	private async handleOperationBatch(msg: OperationBatchMessage): Promise<void> {
		const operations = msg.operations.map((s) => this.serializer.decodeOperation(s))
		const applied: Operation[] = []
		const rejected: Operation[] = []

		for (const op of operations) {
			if (!(await this.operationVisibleToClient(op))) {
				rejected.push(op)
				continue
			}

			if (!isOperationTimestampValid(op)) {
				this.sendError(
					'INVALID_TIMESTAMP',
					`Operation "${op.id}" timestamp is too far in the future`,
					false,
				)
				continue
			}

			if (!this.rateLimiter.allow(1)) {
				this.sendError(
					'RATE_LIMIT',
					`Session exceeded operation rate limit (${String(this.maxOpsPerMinute)} ops/min)`,
					true,
				)
				continue
			}

			const sizeCheck = validateOperationSize(op, this.maxOperationBytes)
			if (!sizeCheck.valid) {
				this.sendError(
					'OPERATION_TOO_LARGE',
					sizeCheck.message ?? `Operation "${op.id}" is too large`,
					false,
				)
				continue
			}

			// Server-side adjudication of untrusted client operations. Runs after
			// the built-in guards and before materialization, so a rejected op never
			// enters the authoritative log and never relays to other clients.
			if (this.validateOperation && this.koraContext) {
				let decision: Awaited<ReturnType<OperationValidator>>
				try {
					decision = await this.validateOperation(op, {
						auth: this.authContext,
						kora: this.koraContext,
					})
				} catch (error) {
					// A throwing validator must not crash ingestion or silently accept.
					// Treat it as a retriable rejection so the submitter can try again.
					const message = error instanceof Error ? error.message : 'validator error'
					this.sendOperationRejected(op, 'VALIDATION_ERROR', `Validator threw: ${message}`, true)
					continue
				}
				if (decision.action === 'reject') {
					this.sendOperationRejected(
						op,
						decision.code,
						decision.message,
						decision.retriable ?? isRetriableRejection(decision.code),
					)
					continue
				}
				if (decision.action === 'ignore') {
					// The server took responsibility out of band; do not materialize the
					// raw op and do not reject. The batch ack lets the client drop it.
					continue
				}
				// action === 'accept' falls through to normal materialization.
			}

			try {
				const applyResult = await applyServerOperation(this.store, op)
				if (applyResult.rejection) {
					this.sendError(
						applyResult.rejection.code,
						applyResult.rejection.message,
						applyResult.rejection.retriable,
					)
					continue
				}
				if (applyResult.result === 'applied') {
					applied.push(...applyResult.appliedOperations)
				}
			} catch {
				// Per-op failure must not block batch acknowledgment
			}
		}

		// Send scope violation errors for rejected operations so the client
		// knows its writes were rejected rather than silently dropped.
		if (rejected.length > 0) {
			for (const op of rejected) {
				this.sendError(
					'SCOPE_VIOLATION',
					`Operation "${op.id}" in collection "${op.collection}" is outside the client's sync scope`,
					false,
				)
			}
		}

		if (operations.length > 0) {
			this.emitter?.emit({
				type: 'sync:received',
				operations,
				batchSize: operations.length,
			})
		}

		// Send acknowledgment
		const lastOp = operations[operations.length - 1]
		const ack: SyncMessage = {
			type: 'acknowledgment',
			messageId: generateUUIDv7(),
			acknowledgedMessageId: msg.messageId,
			lastSequenceNumber: lastOp ? lastOp.sequenceNumber : 0,
		}
		this.sendToClient(ack)

		// Relay only newly applied operations to other sessions
		if (applied.length > 0) {
			this.onRelay?.(this.sessionId, applied)
		}
	}

	private async sendDelta(clientVector: Map<string, number>): Promise<void> {
		const serverVector = this.store.getVersionVector()
		const missing: Operation[] = []

		for (const [nodeId, serverSeq] of serverVector) {
			const clientSeq = clientVector.get(nodeId) ?? 0
			if (serverSeq > clientSeq) {
				const ops = await this.store.getOperationRange(nodeId, clientSeq + 1, serverSeq)
				for (const op of ops) {
					if (await this.operationVisibleToClient(op)) {
						missing.push(op)
					}
				}
			}
		}

		if (missing.length === 0) {
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: [],
				isFinal: true,
				batchIndex: 0,
				totalBatches: 1,
			}
			this.sendToClient(emptyBatch)
			return
		}

		const sorted = topologicalSort(missing)
		const afterCursor = sliceOperationsAfterCursor(sorted, this.resumeDeltaCursor)
		const totalBatches = Math.ceil(afterCursor.length / this.batchSize)

		if (afterCursor.length === 0) {
			const emptyBatch: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: [],
				isFinal: true,
				batchIndex: this.resumeDeltaCursor?.batchIndex ?? 0,
				totalBatches: 1,
			}
			this.sendToClient(emptyBatch)
			return
		}

		for (let i = 0; i < totalBatches; i++) {
			const start = i * this.batchSize
			const batchOps = afterCursor.slice(start, start + this.batchSize)
			const serializedOps = batchOps.map((op) => this.serializer.encodeOperation(op))
			const batchCursor = createDeltaCursorFromBatch(batchOps, i)

			const batchMsg: SyncMessage = {
				type: 'operation-batch',
				messageId: generateUUIDv7(),
				operations: serializedOps,
				isFinal: i === totalBatches - 1,
				batchIndex: i,
				totalBatches,
				...(batchCursor ? { cursor: encodeDeltaCursor(batchCursor) } : {}),
			}
			this.sendToClient(batchMsg)

			this.emitter?.emit({
				type: 'sync:sent',
				operations: batchOps,
				batchSize: batchOps.length,
			})
		}
	}

	/**
	 * Send the gap-free server->client delivery stream, resuming just after
	 * `fromDeliverySeq`. Operations are scanned in server delivery-sequence order
	 * (commit order), scope-filtered for this session, and sent in batches that chain:
	 * each batch's `baseDeliverySequence` equals the previous batch's
	 * `maxDeliverySequence` (the first batch bases on `fromDeliverySeq`). The client
	 * applies a batch only when its watermark equals the base and advances the
	 * watermark to the max, so a dropped batch stalls the watermark and is recovered by
	 * the next handshake resend. Because delivery-sequence order respects causal order
	 * (a dependency is always committed, and thus sequenced, before its dependent), no
	 * topological sort is needed and the client never defers on a missing dependency
	 * that is itself in this stream.
	 *
	 * The final batch advances the watermark to the highest delivery sequence scanned,
	 * not merely the last in-scope one, so an out-of-scope tail is not re-scanned on the
	 * next reconnect. Returns the number of operations actually sent.
	 */
	private async sendDeliveryStream(
		fromDeliverySeq: number,
		finalizeWhenEmpty: boolean,
		excludeNodeId?: string,
	): Promise<number> {
		const scanChunk = Math.max(this.batchSize, 1) * 5
		let scanCursor = fromDeliverySeq
		let maxScanned = fromDeliverySeq
		const visible: DeliveredOperation[] = []

		while (true) {
			const chunk = await this.store.getOperationsAfterDelivery(scanCursor, scanChunk)
			const last = chunk[chunk.length - 1]
			if (last === undefined) break
			scanCursor = last.deliverySequence
			// maxScanned counts every operation scanned, including any excluded (own or
			// out-of-scope) ones, so the batch max advances the client's watermark past
			// them even though they are not sent.
			maxScanned = scanCursor
			for (const delivered of chunk) {
				// Skip the client's own operations during streaming: it already holds them,
				// so echoing them back is pure waste. They are still counted in maxScanned,
				// and a full resync (fromDeliverySeq 0) passes no excludeNodeId, so a client
				// that lost its local store still recovers its own history.
				if (excludeNodeId !== undefined && delivered.operation.nodeId === excludeNodeId) {
					continue
				}
				if (await this.operationVisibleToClient(delivered.operation)) {
					visible.push(delivered)
				}
			}
			if (chunk.length < scanChunk) break
		}

		if (visible.length === 0) {
			// Nothing in scope after the cursor. On a handshake resume, send a single empty
			// final batch so the client advances past an out-of-scope tail and completes
			// initial sync. During streaming, send nothing (an empty batch every relay tick
			// would be pure noise); a reconnect re-scans the small tail if needed.
			if (finalizeWhenEmpty) {
				this.sendDeliveryBatch([], fromDeliverySeq, maxScanned, 0, true)
			}
			return 0
		}

		const totalBatches = Math.ceil(visible.length / this.batchSize)
		let base = fromDeliverySeq
		for (let i = 0; i < totalBatches; i++) {
			const slice = visible.slice(i * this.batchSize, (i + 1) * this.batchSize)
			const lastInSlice = slice[slice.length - 1]
			if (lastInSlice === undefined) continue
			const isFinal = i === totalBatches - 1
			const lastSeq = lastInSlice.deliverySequence
			// The final batch carries the max scanned sequence (>= lastSeq) so the client
			// skips past any out-of-scope operations above the last in-scope one.
			const max = isFinal ? Math.max(maxScanned, lastSeq) : lastSeq
			this.sendDeliveryBatch(slice, base, max, i, isFinal)
			base = max
		}
		return visible.length
	}

	/** Build, track, and send one chained delivery-stream batch. */
	private sendDeliveryBatch(
		slice: DeliveredOperation[],
		base: number,
		max: number,
		batchIndex: number,
		isFinal: boolean,
	): void {
		const batchMsg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: slice.map((delivered) => this.serializer.encodeOperation(delivered.operation)),
			isFinal,
			batchIndex,
			baseDeliverySequence: base,
			maxDeliverySequence: max,
		}
		// Delivery batches are NOT tracked in the bounded pending-relay buffer: recovery of
		// a dropped or unapplied batch is by re-scan from the client's acknowledged
		// position (the next push or the retransmit tick), which cannot be defeated by a
		// buffer eviction. The client re-acks a duplicate and stalls on a gap, so re-sends
		// are always safe.
		this.sendToClient(batchMsg)
		if (slice.length > 0) {
			this.emitter?.emit({
				type: 'sync:sent',
				operations: slice.map((delivered) => delivered.operation),
				batchSize: slice.length,
			})
		}
	}

	private async operationVisibleToClient(op: Operation): Promise<boolean> {
		const scopes = this.authContext?.scopes
		const subsets = this.syncQuerySubsets
		// A partial update (or a delete) may not carry the scope / query-subset fields
		// in its own data. Judging visibility from the bare op would wrongly hide such
		// an operation, so backfill those fields from the materialized record (including
		// a soft-deleted one) whenever they are missing. Only look up when needed so the
		// common case (inserts, or ops that already carry the fields) stays lookup-free.
		const needsBackfill =
			missingScopeFields(op, scopes).length > 0 || (subsets !== undefined && subsets.length > 0)
		const fullRecord = needsBackfill
			? await this.lookupRecordFields(op.collection, op.recordId)
			: undefined

		if (!operationMatchesScopes(op, scopes, fullRecord)) {
			return false
		}
		return operationMatchesQuerySubsets(op, subsets, fullRecord)
	}

	/**
	 * Read a record's current field values from the materialized store for scope /
	 * query-subset backfill. Includes soft-deleted rows so a relayed delete (whose op
	 * carries no fields) is still judged against the record's actual scope. Returns
	 * undefined when the record cannot be read (never materialized, or no schema).
	 */
	private async lookupRecordFields(
		collection: string,
		recordId: string,
	): Promise<Record<string, unknown> | undefined> {
		try {
			const rows = await this.store.queryCollection(collection, {
				where: { id: recordId },
				includeDeleted: true,
				limit: 1,
			})
			return rows[0]
		} catch {
			return undefined
		}
	}

	private handleAwarenessUpdate(msg: AwarenessUpdateMessage): void {
		// Relay awareness updates to the server for broadcasting to other clients.
		// Awareness is purely ephemeral -- no persistence.
		this.onAwarenessUpdate?.(this.sessionId, msg)
	}

	private handleYjsDocUpdate(msg: YjsDocUpdateMessage): void {
		this.onYjsDocUpdate?.(this.sessionId, msg)
	}

	private sendError(code: string, message: string, retriable: boolean): void {
		const errorMsg: SyncMessage = {
			type: 'error',
			messageId: generateUUIDv7(),
			code,
			message,
			retriable,
		}
		this.sendToClient(errorMsg)
	}

	/**
	 * Reject one specific client operation, tied to its id, so the submitter can
	 * divert it out of its pending queue into a durable rejected store rather than
	 * losing it or retrying forever. The op is NOT materialized, so no other
	 * replica ever sees it.
	 */
	private sendOperationRejected(
		op: Operation,
		code: string,
		message: string,
		retriable: boolean,
	): void {
		const rejectedMsg: SyncMessage = {
			type: 'operation-rejected',
			messageId: generateUUIDv7(),
			operationId: op.id,
			collection: op.collection,
			recordId: op.recordId,
			code,
			message,
			retriable,
		}
		this.sendToClient(rejectedMsg)
	}

	private setSerializerWireFormat(format: WireFormat): void {
		if (typeof this.serializer.setWireFormat === 'function') {
			this.serializer.setWireFormat(format)
		}
	}

	private handleTransportClose(): void {
		if (this.state === 'closed') return
		this.state = 'closed'
		this.flushOrphanedRelays()
		this.emitter?.emit({ type: 'sync:disconnected', reason: 'transport closed' })
		this.onClose?.(this.sessionId)
	}
}

function selectWireFormat(supportedWireFormats?: WireFormat[]): WireFormat {
	if (supportedWireFormats?.includes('protobuf')) {
		return 'protobuf'
	}

	return 'json'
}
