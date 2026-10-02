import type {
	KoraEventEmitter,
	Operation,
	OperationTransform,
	SchemaDefinition,
} from '@korajs/core'
import { applyOperationTransforms } from '@korajs/core'
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
import type { Logger } from '../logging/structured-logger'
import type { BlobAccessIndex } from '../richtext/blob-access-index'
import {
	authorizeOperationReferences,
	operationHasReferences,
} from '../scopes/reference-authorization'
import { ScopeRequiredError, resolveSessionScopes } from '../scopes/resolve-session-scopes'
import { InvalidScopePredicateError } from '../scopes/scope-predicate-errors'
import {
	type ScopeMap,
	type UplinkAuthorizationResult,
	authorizeRecordWrite,
	authorizeUplinkWrite,
	missingScopeFields,
	normalizeScopeMap,
	operationMatchesScopes,
	recordMatchesScopes,
	snapshotExitsScopes,
} from '../scopes/server-scope-filter'
import type { ProductionHttpRouteContext } from '../server/route-context'
import type {
	DeliveredOperation,
	MaterializedRecord,
	OperationScopeSnapshot,
	ServerStore,
} from '../store/server-store'
import type { ServerTransport } from '../transport/server-transport'
import type { AuthContext, AuthProvider, SessionRevocation } from '../types'
import { isOperationTimestampValid } from './operation-validation'
import {
	DEFAULT_MAX_OPERATION_BYTES,
	DEFAULT_MAX_OPS_PER_BATCH,
	DEFAULT_MAX_OPS_PER_MINUTE,
	SessionRateLimiter,
	validateOperationSize,
} from './session-operation-limits'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1
/** setTimeout's largest delay; longer credential lifetimes are re-armed in steps. */
const MAX_TIMER_DELAY_MS = 2_147_483_647
/** Revocations remembered for a session whose handshake has not resolved its principal. */
const MAX_PENDING_REVOCATIONS = 32

/**
 * Legacy node-claim owner shared by every anonymous principal (RT-5, superseded by
 * RT-12). Claims recorded under it by pre-release builds are not adopted by anyone;
 * an administrator releases them with `KoraSyncServer.releaseNodeClaim`.
 */
export const ANONYMOUS_NODE_OWNER = 'kora:anonymous'

/**
 * Prefix reserved for principals Kora itself synthesizes (node-claim owners of
 * anonymous devices). An auth provider may not issue a user id that starts with it,
 * so no real user can ever collide with an anonymous device's claim (RT-12).
 */
export const RESERVED_PRINCIPAL_PREFIX = 'kora:'

/** Prefix of the node-claim owner of an anonymous device: `kora:anon-node:<sha256(token)>`. */
const ANONYMOUS_NODE_OWNER_PREFIX = 'kora:anon-node:'
/** Longest node token a client may present. */
const MAX_NODE_TOKEN_LENGTH = 256
/** Bytes of randomness in a server-issued node token (256 bits). */
const NODE_TOKEN_BYTES = 32

/** 256 random bits, base64url: an unguessable per-device node token. */
function generateNodeToken(): string {
	const bytes = new Uint8Array(NODE_TOKEN_BYTES)
	globalThis.crypto.getRandomValues(bytes)
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/**
 * The node-claim owner of an anonymous device holding `nodeToken`. Only the hash is
 * stored, so the claims table never holds a usable secret.
 */
async function anonymousNodeOwner(nodeToken: string): Promise<string> {
	return `${ANONYMOUS_NODE_OWNER_PREFIX}${await hashBlob(new TextEncoder().encode(nodeToken))}`
}

/** Credential-ending error codes. Retriable: the client refreshes and re-handshakes. */
export type SessionTerminationCode = 'AUTH_REVOKED' | 'AUTH_EXPIRED'

/**
 * Same principal for re-validation: the same user and device, or both anonymous
 * (an anonymous principal gets a fresh user id per authentication).
 */
function samePrincipal(a: AuthContext, b: AuthContext): boolean {
	if (a.anonymous === true || b.anonymous === true)
		return a.anonymous === true && b.anonymous === true
	return a.userId === b.userId && a.metadata?.deviceId === b.metadata?.deviceId
}

function revocationMatches(principal: AuthContext, filter: SessionRevocation): boolean {
	if (filter.userId === undefined && filter.deviceId === undefined) return false
	if (filter.userId !== undefined && principal.userId !== filter.userId) return false
	if (filter.deviceId !== undefined && principal.metadata?.deviceId !== filter.deviceId) {
		return false
	}
	return true
}

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

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableStringify(item)).join(',')}]`
	}
	if (value && typeof value === 'object') {
		const record = value as Record<string, unknown>
		const entries = Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
		return `{${entries.join(',')}}`
	}
	return JSON.stringify(value)
}

function sameScopeMap(a: unknown, b: unknown): boolean {
	const normalize = (value: unknown): unknown =>
		value && typeof value === 'object'
			? normalizeScopeMap(value as Record<string, Record<string, unknown>>)
			: value
	return stableStringify(normalize(a) ?? null) === stableStringify(normalize(b) ?? null)
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
export type YjsDocRelayCallback = (
	sourceSessionId: string,
	message: YjsDocUpdateMessage,
	storedRecord: MaterializedRecord | null,
) => void

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

/** Default largest single blob chunk (or manifest) a session may push: 1 MiB. */
export const DEFAULT_MAX_BLOB_CHUNK_BYTES = 1024 * 1024
/** Default total blob bytes one session may push for central persistence: 256 MiB. */
export const DEFAULT_MAX_BLOB_BYTES_PER_SESSION = 256 * 1024 * 1024

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
	/** Structured logger used for protocol and persistence failures */
	logger?: Logger
	/** Max operations per sync batch */
	batchSize?: number
	/** Schema version the server expects */
	schemaVersion?: number
	/** Inclusive client schema versions accepted at handshake */
	supportedSchemaVersions?: { min: number; max: number }
	/** Transform accepted legacy operations into the server schema before validation. */
	operationTransforms?: OperationTransform[]
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
	/**
	 * Called once the session completes an accepted handshake and reaches streaming.
	 * Side channels (Yjs doc, blob and awareness relays) register the session here,
	 * never at connect time, so an unauthenticated connection is never on a relay.
	 */
	onReady?: (sessionId: string) => void
	/** Largest single blob chunk this session may push. Defaults to 1 MiB. */
	maxBlobChunkBytes?: number
	/** Total blob bytes this session may push. Defaults to 256 MiB. */
	maxBlobBytesPerSession?: number
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
	 * Largest operation batch accepted in one message. A larger batch is refused whole
	 * (`BATCH_TOO_LARGE`) before it is decoded or the store is read. Defaults to 1000.
	 */
	maxOpsPerBatch?: number
	/**
	 * Adjudicate untrusted client operations before materialization. When present,
	 * each incoming operation is passed to this validator; a `reject` decision
	 * sends an operation-rejected message and skips materialization.
	 */
	validateOperation?: OperationValidator
	/** Trusted data-plane context handed to the validator (read state, author derived ops). */
	koraContext?: ProductionHttpRouteContext
	/**
	 * Blob reference authority (RT-11): decides which content hashes this session may
	 * reference in blob fields and records the bytes it pushes. Without it, blob
	 * references are not checked at ingest.
	 */
	blobAccess?: BlobAccessIndex
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
	/**
	 * The context the auth provider returned, kept apart from {@link authContext}
	 * (which an unauthenticated session also gets, keyed by node id) so revocation
	 * only ever matches a verified principal.
	 */
	private principal: AuthContext | null = null
	/** Closes the session when its credential expires (AUTH-11). */
	private expiryTimer: ReturnType<typeof setTimeout> | null = null
	/** Revocations that arrived while the handshake was still authenticating. */
	private readonly pendingRevocations: SessionRevocation[] = []
	/** Node token issued by this handshake's first anonymous claim, sent once in the response (RT-12). */
	private issuedNodeToken: string | null = null
	/** The node-claim owner this session holds its node id under (userId, or an anonymous device key). */
	private nodeOwnerKey: string | null = null
	/** The credential presented at handshake, kept to re-validate the session (RT-18). */
	private credential: string | null = null
	private syncQuerySubsets: SyncQuerySubset[] = []
	private scopeExitPolicy: 'retain' | 'retract' = 'retain'
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
	/**
	 * Timestamp of the last delivery-stream send attempt. Periodic retransmission uses
	 * this as its stale window so a slow client does not receive duplicate full-stream
	 * batches every server tick while the first batch is still being applied.
	 */
	private lastDeliveryPushAttemptAtMs = 0
	private outstandingDelivery: {
		base: number
		max: number
		sentAtMs: number
		repeatCount: number
	} | null = null
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
	private readonly logger: Logger | null
	private readonly batchSize: number
	private readonly schemaVersion: number
	private readonly supportedSchemaVersions: { min: number; max: number }
	private readonly operationTransforms: OperationTransform[]
	private readonly onRelay: RelayCallback | null
	private readonly onAwarenessUpdate: AwarenessRelayCallback | null
	private readonly onYjsDocUpdate: YjsDocRelayCallback | null
	private readonly onBlobChunkRequest: BlobChunkRequestCallback | null
	private readonly onBlobChunkResponse: BlobChunkResponseCallback | null
	private readonly persistBlobChunk: PersistBlobChunk | null
	private readonly onClose: ((sessionId: string) => void) | null
	private readonly onReady: ((sessionId: string) => void) | null
	private readonly maxBlobChunkBytes: number
	private readonly maxBlobBytesPerSession: number
	private blobBytesPushed = 0
	private readonly onOrphanedRelays: ((nodeId: string, ops: Operation[]) => void) | null
	private readonly takeOrphanedRelays: ((nodeId: string) => Operation[]) | null
	private readonly maxOperationBytes: number
	private readonly maxOpsPerMinute: number
	private readonly maxOpsPerBatch: number
	private readonly rateLimiter: SessionRateLimiter
	/** Operations refused by the rate limiter (RT-6), for diagnostics. */
	private rateLimitedOperations = 0
	/** Batches refused whole for exceeding {@link maxOpsPerBatch} (RT-6). */
	private rejectedBatches = 0
	/** Blob chunk requests answered "not held" because the session was over budget (RT-17). */
	private rateLimitedBlobRequests = 0
	private readonly validateOperation: OperationValidator | null
	private readonly koraContext: ProductionHttpRouteContext | null
	private readonly blobAccess: BlobAccessIndex | null

	constructor(options: ClientSessionOptions) {
		this.sessionId = options.sessionId
		this.transport = options.transport
		this.store = options.store
		this.auth = options.auth ?? null
		this.serializer = options.serializer ?? new NegotiatedMessageSerializer('json')
		this.emitter = options.emitter ?? null
		this.logger = options.logger ?? null
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
		this.schemaVersion = options.schemaVersion ?? DEFAULT_SCHEMA_VERSION
		const supported = options.supportedSchemaVersions
		this.supportedSchemaVersions = supported ?? {
			min: this.schemaVersion,
			max: this.schemaVersion,
		}
		this.operationTransforms = options.operationTransforms ?? []
		this.onRelay = options.onRelay ?? null
		this.onAwarenessUpdate = options.onAwarenessUpdate ?? null
		this.onYjsDocUpdate = options.onYjsDocUpdate ?? null
		this.onBlobChunkRequest = options.onBlobChunkRequest ?? null
		this.onBlobChunkResponse = options.onBlobChunkResponse ?? null
		this.persistBlobChunk = options.persistBlobChunk ?? null
		this.onClose = options.onClose ?? null
		this.onReady = options.onReady ?? null
		this.maxBlobChunkBytes = options.maxBlobChunkBytes ?? DEFAULT_MAX_BLOB_CHUNK_BYTES
		this.maxBlobBytesPerSession =
			options.maxBlobBytesPerSession ?? DEFAULT_MAX_BLOB_BYTES_PER_SESSION
		this.onOrphanedRelays = options.onOrphanedRelays ?? null
		this.takeOrphanedRelays = options.takeOrphanedRelays ?? null
		this.maxOperationBytes = options.maxOperationBytes ?? DEFAULT_MAX_OPERATION_BYTES
		this.maxOpsPerMinute = options.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE
		this.rateLimiter = new SessionRateLimiter(this.maxOpsPerMinute)
		this.maxOpsPerBatch = options.maxOpsPerBatch ?? DEFAULT_MAX_OPS_PER_BATCH
		this.validateOperation = options.validateOperation ?? null
		this.koraContext = options.koraContext ?? null
		this.blobAccess = options.blobAccess ?? null
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
	private pushDeliveryStream(options: { trackStall?: boolean } = {}): void {
		this.deliveryPushChain = this.deliveryPushChain.then(async () => {
			if (this.state !== 'streaming' || !this.transport.isConnected()) return
			try {
				const previous = this.outstandingDelivery
				if (options.trackStall && previous && previous.max > this.lastAckedDeliverySeq) {
					previous.repeatCount += 1
					if (previous.repeatCount >= 3) {
						this.emitter?.emit({
							type: 'sync:delivery-stalled',
							sessionId: this.sessionId,
							watermark: this.lastAckedDeliverySeq,
							outstandingMaxDeliverySequence: previous.max,
							repeatCount: previous.repeatCount,
							reason: 'unacknowledged-delivery',
						})
					}
				}
				this.lastDeliveryPushAttemptAtMs = Date.now()
				// Resume from the client's last acknowledged sequence, not the last sent, so a
				// dropped or unapplied batch is re-included here. Exclude the client's own
				// operations during streaming; it already has them.
				const result = await this.sendDeliveryStream(
					this.lastAckedDeliverySeq,
					false,
					this.clientNodeId ?? undefined,
				)
				if (result.sent && result.maxScanned > this.lastAckedDeliverySeq) {
					if (
						!this.outstandingDelivery ||
						this.outstandingDelivery.base !== this.lastAckedDeliverySeq ||
						this.outstandingDelivery.max !== result.maxScanned
					) {
						this.outstandingDelivery = {
							base: this.lastAckedDeliverySeq,
							max: result.maxScanned,
							sentAtMs: Date.now(),
							repeatCount: 0,
						}
					} else {
						this.outstandingDelivery.sentAtMs = Date.now()
					}
				} else if (result.maxScanned <= this.lastAckedDeliverySeq) {
					this.outstandingDelivery = null
				}
			} catch {
				// A failed push (e.g. a transient store read error) must not reject the chain
				// and stall all future pushes. The next push, or a reconnect resend from the
				// client's watermark, recovers anything this push did not deliver.
			}
		})
	}

	private async relayVisibleOperations(operations: Operation[]): Promise<void> {
		const visibleOperations: Operation[] = []
		const retractions: Array<{ collection: string; recordId: string }> = []
		const snapshots = await this.scopeSnapshotsFor(operations)
		for (const op of operations) {
			const snapshot = snapshots.get(op.id) ?? null
			if (await this.operationVisibleToClient(op, snapshot)) {
				visibleOperations.push(op)
			} else if (await this.scopeRetractionFor(op, snapshot)) {
				retractions.push({ collection: op.collection, recordId: op.recordId })
			}
		}
		if (visibleOperations.length === 0 && retractions.length === 0) return
		// Re-check liveness: an await may have elapsed since the caller's guard.
		if (this.state !== 'streaming' || !this.transport.isConnected()) return

		const serializedOps = visibleOperations.map((op) => this.serializer.encodeOperation(op))
		const msg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: serializedOps,
			...(retractions.length > 0 ? { retractions } : {}),
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
		if (this.clientDeliveryWatermark !== null) {
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
	 * Wake the durable delivery stream for clients that negotiated delivery
	 * watermarks. This is used both for dropped watermark batches and for operations
	 * appended by another server/store instance: the session always scans from its
	 * own acknowledged cursor and applies its visibility filter before sending.
	 */
	pushDeliveryStreamIfSupported(
		staleMs = 0,
		options: { trackStall?: boolean; serverFrontier?: number } = {},
	): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		if (this.clientDeliveryWatermark === null) return
		if (
			options.serverFrontier !== undefined &&
			options.serverFrontier <= this.lastAckedDeliverySeq
		) {
			this.outstandingDelivery = null
			return
		}
		if (staleMs > 0 && Date.now() - this.lastDeliveryPushAttemptAtMs < staleMs) {
			return
		}
		this.pushDeliveryStream({ trackStall: options.trackStall })
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
		this.clearExpiryTimer()
		this.flushOrphanedRelays()

		if (this.transport.isConnected()) {
			this.transport.close(1000, reason ?? 'session closed')
		}

		this.onClose?.(this.sessionId)
	}

	/**
	 * End this session if its verified principal matches a credential revocation
	 * (AUTH-11): send a retriable `code` error so the client refreshes and
	 * re-handshakes, then close. A session still authenticating remembers the
	 * revocation and applies it as soon as its principal is known.
	 *
	 * @returns True when the session was closed by this call
	 */
	terminateIfMatches(filter: SessionRevocation, code: SessionTerminationCode): boolean {
		if (this.state === 'closed') return false
		if (!this.principal) {
			if (this.state === 'connected' && this.pendingRevocations.length < MAX_PENDING_REVOCATIONS) {
				this.pendingRevocations.push({ ...filter })
			}
			return false
		}
		if (!revocationMatches(this.principal, filter)) return false
		this.terminate(code)
		return true
	}

	/**
	 * Re-authenticate the credential that opened this session (RT-18). The session is
	 * ended with a retriable `AUTH_REVOKED` (`AUTH_EXPIRED` once past its expiry) when
	 * the provider now refuses the credential or resolves it to another principal, for
	 * example after a revocation persisted by another server instance.
	 *
	 * @returns `'terminated'` when this call ended the session, `'error'` when the
	 *   provider threw (nothing is ended; the caller retries later), else `'valid'`
	 */
	async revalidateCredential(): Promise<'valid' | 'terminated' | 'error'> {
		if (this.state === 'closed' || !this.auth || !this.principal || this.credential === null) {
			return 'valid'
		}
		const principal = this.principal
		let context: AuthContext | null
		try {
			context = await this.auth.authenticate(this.credential)
		} catch {
			return 'error'
		}
		// The session may have closed (or re-authenticated) while the provider ran.
		if (this.getState() === 'closed' || this.principal !== principal) return 'valid'
		if (context && samePrincipal(principal, context)) return 'valid'
		const expired = principal.expiresAt !== undefined && Date.now() >= principal.expiresAt
		this.terminate(expired ? 'AUTH_EXPIRED' : 'AUTH_REVOKED')
		return 'terminated'
	}

	/**
	 * End this session because an admin released its node id (RT-5). Retriable: a
	 * client that still owns the node simply reconnects and claims it again.
	 */
	endForNodeRelease(): void {
		if (this.state === 'closed') return
		this.sendError(
			'NODE_RELEASED',
			'An administrator released this device node id. Reconnect to claim it again.',
			true,
		)
		this.close('node id released')
	}

	private terminate(code: SessionTerminationCode): void {
		const message =
			code === 'AUTH_EXPIRED'
				? 'The credential for this sync session expired. Refresh it and reconnect.'
				: 'The credential for this sync session was revoked. Refresh it and reconnect.'
		this.sendError(code, message, true)
		this.close(code === 'AUTH_EXPIRED' ? 'credential expired' : 'credential revoked')
	}

	/**
	 * Arm the expiry timer from `AuthContext.expiresAt`. Returns false when the
	 * credential has already expired (the caller refuses the handshake).
	 */
	private armExpiryTimer(expiresAt: number | undefined): boolean {
		this.clearExpiryTimer()
		if (expiresAt === undefined || !Number.isFinite(expiresAt)) return true
		const remaining = expiresAt - Date.now()
		if (remaining <= 0) return false
		this.expiryTimer = setTimeout(
			() => {
				this.expiryTimer = null
				if (this.state === 'closed') return
				if (Date.now() >= expiresAt) {
					this.terminate('AUTH_EXPIRED')
				} else {
					this.armExpiryTimer(expiresAt)
				}
			},
			Math.min(remaining, MAX_TIMER_DELAY_MS),
		)
		// A pending expiry must not keep a Node process alive on its own.
		const timer = this.expiryTimer as { unref?: () => void }
		timer.unref?.()
		return true
	}

	private clearExpiryTimer(): void {
		if (this.expiryTimer !== null) {
			clearTimeout(this.expiryTimer)
			this.expiryTimer = null
		}
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

	/**
	 * The principal the auth provider verified at handshake, or null before (or
	 * without) authentication. Unlike {@link getAuthContext}, never a context
	 * synthesized for an unauthenticated session.
	 */
	getPrincipal(): AuthContext | null {
		return this.principal
	}

	isStreaming(): boolean {
		return this.state === 'streaming'
	}

	/**
	 * Ingest refusals that happen before any store work (RT-6): operations refused by
	 * the per-minute rate limiter and batches refused for exceeding the per-batch cap.
	 */
	getIngestLimitCounts(): {
		rateLimitedOperations: number
		rejectedBatches: number
		rateLimitedBlobRequests: number
	} {
		return {
			rateLimitedOperations: this.rateLimitedOperations,
			rejectedBatches: this.rejectedBatches,
			rateLimitedBlobRequests: this.rateLimitedBlobRequests,
		}
	}

	/**
	 * True when a stored record is inside this session's download scope, so a side
	 * channel (for example a Yjs doc update) about it may be delivered here. A record
	 * not stored yet is judged by its id alone.
	 */
	canReceiveRecord(
		collection: string,
		recordId: string,
		storedRecord: Record<string, unknown> | null,
	): boolean {
		if (this.state !== 'streaming') return false
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		return recordMatchesScopes(collection, { ...(storedRecord ?? {}), id: recordId }, scopes)
	}

	/**
	 * A stable key for this session's download scope. Presence (awareness) is only
	 * relayed between sessions that share exactly the same key, so it never crosses a
	 * tenant boundary. Unscoped sessions share the key `"*"`.
	 */
	/** This session's download scope, or undefined when it is unscoped. */
	getDownlinkScopes(): ScopeMap | undefined {
		return this.authContext?.downlinkScopes ?? this.authContext?.scopes
	}

	getScopePartitionKey(): string {
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		return scopes ? stableStringify(normalizeScopeMap(scopes)) : '*'
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
		if (this.state === 'closed') return
		// Nothing but a handshake is accepted until a handshake has been accepted (and,
		// with auth configured, authenticated). Operations, acknowledgments and every
		// side channel from a session that skipped it are refused and the connection is
		// closed, so an unauthenticated peer can neither write nor reach other sessions.
		if (message.type !== 'handshake' && this.state !== 'syncing' && this.state !== 'streaming') {
			this.sendError(
				'HANDSHAKE_REQUIRED',
				`Received "${message.type}" before a successful handshake. Send a handshake first.`,
				false,
			)
			this.close('handshake required')
			return
		}
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
					if (
						this.outstandingDelivery &&
						this.lastAckedDeliverySeq >= this.outstandingDelivery.max
					) {
						this.outstandingDelivery = null
					} else if (this.outstandingDelivery) {
						this.outstandingDelivery.repeatCount = 0
					}
				}
				break
			case 'error':
				break
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				await this.handleYjsDocUpdate(message)
				break
			case 'blob-chunk-request':
				// Every request costs access checks and possibly a central-store read, so it
				// is charged to the same per-session budget as operations (RT-17). Over
				// budget it is answered "not held" rather than with an error, so a client
				// pulling a large blob backs off and retries instead of being disconnected.
				if (!this.rateLimiter.allow(1)) {
					this.rateLimitedBlobRequests += 1
					this.sendToClient({
						type: 'blob-chunk-response',
						messageId: `blob-resp-${message.requestId}`,
						requestId: message.requestId,
						bytes: null,
					})
					break
				}
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
		// Bound what one session can make the server persist: a per-chunk size cap and a
		// per-session byte quota, so a client cannot fill the operator's disk.
		if (bytes.byteLength > this.maxBlobChunkBytes) {
			this.sendError(
				'BLOB_CHUNK_TOO_LARGE',
				`Blob chunk ${message.hash} is ${String(bytes.byteLength)} bytes; the limit is ${String(this.maxBlobChunkBytes)}.`,
				false,
			)
			return
		}
		if (this.blobBytesPushed + bytes.byteLength > this.maxBlobBytesPerSession) {
			this.sendError(
				'BLOB_QUOTA_EXCEEDED',
				`This session exceeded its blob upload quota of ${String(this.maxBlobBytesPerSession)} bytes.`,
				false,
			)
			return
		}
		const actual = await hashBlob(bytes)
		if (actual !== message.hash) {
			// Reject a mismatched upload rather than persisting untrusted bytes.
			return
		}
		const owner = this.blobOwnerKey()
		const scopes = this.referenceScopes()
		// A manifest may only list chunks the pusher may reference itself (RT-11), so a
		// crafted manifest cannot make another tenant's chunk reachable.
		if (
			this.blobAccess &&
			scopes !== undefined &&
			!(await this.blobAccess.authorizeManifestPush(bytes, scopes, owner))
		) {
			this.sendError(
				'BLOB_REFERENCE_FORBIDDEN',
				`Blob manifest ${message.hash} lists content this session cannot read and has not uploaded.`,
				false,
			)
			return
		}
		this.blobBytesPushed += bytes.byteLength
		await this.persistBlobChunk(message.hash, bytes)
		// Pushing the bytes proves possession: the session may reference this hash.
		await this.blobAccess?.recordPush(message.hash, bytes, owner)
	}

	/**
	 * The download scope references are authorized against (RT-11, RT-13), or
	 * undefined when they are not checked: without a real auth provider there is no
	 * tenant boundary to protect.
	 */
	private referenceScopes(): ScopeMap | undefined {
		if (!this.auth || this.auth instanceof NoAuthProvider) return undefined
		if (!this.principal) return {}
		return this.authContext?.downlinkScopes ?? this.authContext?.scopes
	}

	/**
	 * Stable blob-ownership key of this session's principal: the user id, or for an
	 * anonymous device its node-claim owner (never shared by two anonymous devices).
	 */
	private blobOwnerKey(): string {
		if (this.principal?.anonymous === true) {
			return this.nodeOwnerKey ?? `kora:node:${this.clientNodeId ?? this.sessionId}`
		}
		return this.principal?.userId ?? `kora:node:${this.clientNodeId ?? this.sessionId}`
	}

	/**
	 * Partition key for peer-to-peer blob forwarding. Sessions with the same download
	 * scope share a tenant view, except anonymous devices: every anonymous session has
	 * the same grant but they are unrelated people, so each is its own partition.
	 */
	getBlobPartitionKey(): string {
		const key = this.getScopePartitionKey()
		return this.principal?.anonymous === true ? `${this.blobOwnerKey()}|${key}` : key
	}

	/** Authorize foreign-key targets and blob references of an untrusted write. */
	private async authorizeReferences(op: Operation): Promise<UplinkAuthorizationResult> {
		const scopes = this.referenceScopes()
		const schema = this.store.getSchema()
		if (scopes === undefined || !schema || !operationHasReferences(op, schema)) {
			return { allowed: true }
		}
		const stored = (await this.lookupRecordFields(op.collection, op.recordId)) ?? null
		return authorizeOperationReferences(op, stored, {
			schema,
			downlinkScopes: scopes,
			readRow: async (collection, recordId) =>
				(await this.lookupRecordFields(collection, recordId)) ?? null,
			...(this.blobAccess ? { blobs: this.blobAccess } : {}),
			blobOwner: this.blobOwnerKey(),
		})
	}

	private handleMessageFailure(error: unknown): void {
		const reason = error instanceof Error ? error.message : 'Message handling failed'
		this.logger?.log({
			timestamp: Date.now(),
			level: 'error',
			event: 'session.message_failed',
			sessionId: this.sessionId,
			nodeId: this.clientNodeId ?? undefined,
			error: reason,
			details: {
				state: this.state,
				errorName: error instanceof Error ? error.name : typeof error,
			},
		})
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
		this.scopeExitPolicy = msg.scopeExitPolicy ?? 'retain'

		// Authenticate if provider is configured
		if (this.auth) {
			const token = msg.authToken ?? ''
			const context = await this.auth.authenticate(token)
			if (!context) {
				this.sendError('AUTH_FAILED', 'Authentication failed', false)
				this.close('authentication failed')
				return
			}
			// The `kora:` namespace belongs to principals Kora synthesizes (anonymous node
			// owners). A provider issuing such a user id could collide with them (RT-12).
			if (context.anonymous !== true && context.userId.startsWith(RESERVED_PRINCIPAL_PREFIX)) {
				this.sendError(
					'AUTH_FAILED',
					`The auth provider returned the user id "${context.userId}", which is in the reserved "${RESERVED_PRINCIPAL_PREFIX}" namespace. Issue user ids without that prefix.`,
					false,
				)
				this.close('reserved principal id')
				return
			}
			// Bind the device node id to this principal. A node id another user already
			// claimed is refused, so nobody can upload operations as someone else's device.
			// Anonymous principals get a fresh userId per connection, so their claim is
			// keyed by a per-device secret instead (RT-12): the server issues a node token
			// at the first claim, the client stores it next to its node id, and only a
			// handshake presenting it may use the node again. NoAuthProvider has no
			// identity at all.
			if (this.store.claimNode && !(this.auth instanceof NoAuthProvider)) {
				let owner = context.userId
				if (context.anonymous === true) {
					const presented =
						typeof msg.nodeToken === 'string' &&
						msg.nodeToken.length > 0 &&
						msg.nodeToken.length <= MAX_NODE_TOKEN_LENGTH
							? msg.nodeToken
							: null
					const nodeToken = presented ?? generateNodeToken()
					if (presented === null) this.issuedNodeToken = nodeToken
					owner = await anonymousNodeOwner(nodeToken)
				}
				this.nodeOwnerKey = owner
				if (!(await this.store.claimNode(msg.nodeId, owner))) {
					this.issuedNodeToken = null
					this.sendError(
						'NODE_ID_CLAIMED',
						`Node id "${msg.nodeId}" belongs to another principal, or has operation history with no recorded owner (an administrator can release it with KoraSyncServer.releaseNodeClaim). Use a fresh node id per signed-in user.`,
						false,
					)
					this.close('node id claimed by another user')
					return
				}
			}
			// A revocation that landed while this handshake was authenticating applies now.
			if (this.pendingRevocations.some((filter) => revocationMatches(context, filter))) {
				this.pendingRevocations.length = 0
				this.sendError(
					'AUTH_REVOKED',
					'The credential for this sync session was revoked. Refresh it and reconnect.',
					true,
				)
				this.close('credential revoked')
				return
			}
			this.pendingRevocations.length = 0
			// The session must not outlive the credential that opened it (AUTH-11).
			if (!this.armExpiryTimer(context.expiresAt)) {
				this.sendError(
					'AUTH_EXPIRED',
					'The credential presented at handshake has expired. Refresh it and reconnect.',
					true,
				)
				this.close('credential expired')
				return
			}
			this.principal = context
			this.authContext = context
			this.credential = token
			this.state = 'authenticated'
		}

		// Resolve download and upload authorization independently. The legacy `scopes`
		// contract remains shorthand for both directions.
		const directionalScopesConfigured =
			this.authContext?.downlinkScopes !== undefined || this.authContext?.uplinkScopes !== undefined
		const downlinkAuthScopes = directionalScopesConfigured
			? (this.authContext?.downlinkScopes ?? this.authContext?.scopes ?? {})
			: this.authContext?.scopes
		const uplinkAuthScopes = directionalScopesConfigured
			? (this.authContext?.uplinkScopes ?? this.authContext?.scopes ?? {})
			: this.authContext?.scopes
		// A real auth provider that grants nothing for a schema-scoped collection is
		// refused, never handed the scope the client asked for (AUTH-1). A schemaless
		// server has no scoped collections to protect, so it keeps the provider's
		// (absent) grant as "unscoped" and the multi-tenant warning below.
		const authenticated =
			this.auth !== null &&
			!(this.auth instanceof NoAuthProvider) &&
			this.store.getSchema() !== null
		let rawResolvedDownlinkScopes: ReturnType<typeof resolveSessionScopes>
		let rawResolvedUplinkScopes: ReturnType<typeof resolveSessionScopes>
		try {
			rawResolvedDownlinkScopes = resolveSessionScopes(this.store.getSchema(), {
				handshakeScope: msg.syncScope,
				authScopes: downlinkAuthScopes,
				authenticated,
				onUnresolved: 'throw',
			})
			// A directional uplink grant goes through the same resolver as the downlink one
			// (RT-16): verified `$claims` are bound to the schema, an unresolved binding
			// denies the collection (fail closed; the session may still read), and the
			// handshake can only narrow it, exactly as for a non-directional grant.
			rawResolvedUplinkScopes = directionalScopesConfigured
				? resolveSessionScopes(this.store.getSchema(), {
						handshakeScope: msg.syncScope,
						authScopes: uplinkAuthScopes,
						authenticated,
						onUnresolved: 'deny',
					})
				: rawResolvedDownlinkScopes
		} catch (error) {
			if (error instanceof InvalidScopePredicateError) {
				this.sendError('INVALID_SCOPE_PREDICATE', error.message, false)
				this.close('invalid scope predicate')
				return
			}
			if (!(error instanceof ScopeRequiredError)) throw error
			this.sendError('SCOPE_REQUIRED', error.message, false)
			this.close('sync scope required')
			return
		}
		let resolvedDownlinkScopes: typeof rawResolvedDownlinkScopes
		let resolvedUplinkScopes: typeof rawResolvedUplinkScopes
		try {
			resolvedDownlinkScopes = rawResolvedDownlinkScopes
				? normalizeScopeMap(rawResolvedDownlinkScopes)
				: directionalScopesConfigured
					? {}
					: undefined
			resolvedUplinkScopes = rawResolvedUplinkScopes
				? normalizeScopeMap(rawResolvedUplinkScopes)
				: directionalScopesConfigured
					? {}
					: undefined
		} catch (error) {
			this.sendToClient({
				type: 'error',
				messageId: generateUUIDv7(),
				code:
					error instanceof InvalidScopePredicateError
						? 'INVALID_SCOPE_PREDICATE'
						: 'SCOPE_PREDICATE_LIMIT',
				message: error instanceof Error ? error.message : 'Invalid scope predicate',
				retriable: false,
			})
			this.close('invalid scope predicate')
			return
		}

		if (resolvedDownlinkScopes || resolvedUplinkScopes) {
			if (this.authContext) {
				this.authContext = {
					...this.authContext,
					scopes: resolvedDownlinkScopes,
					downlinkScopes: resolvedDownlinkScopes,
					uplinkScopes: resolvedUplinkScopes,
				}
			} else {
				this.authContext = {
					userId: msg.nodeId,
					scopes: resolvedDownlinkScopes,
					downlinkScopes: resolvedDownlinkScopes,
					uplinkScopes: resolvedUplinkScopes,
				}
			}
		}

		// Judge the provider's own grant: with `authenticated`, the resolved map is never
		// empty-handed, but a provider that granted nothing still shares every unscoped
		// collection across tenants.
		warnIfMultiTenantWithoutScopes(
			this.auth,
			authenticated ? downlinkAuthScopes : resolvedDownlinkScopes,
			this.store.getSchema(),
		)

		if (msg.syncQueries && msg.syncQueries.length > 0) {
			this.syncQuerySubsets = dedupeQuerySubsets(msg.syncQueries)
		} else {
			this.syncQuerySubsets = []
		}

		this.resumeDeltaCursor = msg.deltaCursor ? decodeDeltaCursor(msg.deltaCursor) : null
		this.clientDeliveryWatermark = msg.lastDeliverySequence ?? null
		// A delivery watermark is valid only for the exact server-visible view that
		// earned it. When the server resolves a different scope than the client sent
		// (common with server-auth scopes, promotions, or invite acceptance), the client
		// cannot have keyed its local watermark by that authoritative view before this
		// handshake. Reset to a full scoped backfill instead of trusting a cursor that may
		// have advanced over previously hidden operations.
		if (
			this.clientDeliveryWatermark !== null &&
			!sameScopeMap(msg.syncScope, this.authContext?.downlinkScopes)
		) {
			this.clientDeliveryWatermark = 0
		}

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
			this.emitter?.emit({
				type: 'sync:schema-mismatch',
				clientSchemaVersion: msg.schemaVersion,
				serverSchemaVersion: this.schemaVersion,
				supportedMin: min,
				supportedMax: max,
				reason: `${SCHEMA_MISMATCH_PREFIX}: client schema version ${msg.schemaVersion} not in supported range [${min}, ${max}]`,
			})
			const response: SyncMessage = {
				type: 'handshake-response',
				messageId: generateUUIDv7(),
				nodeId: this.store.getNodeId(),
				versionVector: {},
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

		// Collect the server->client stream before answering, so the response can describe
		// exactly the nodes this client will hear from. A client that reports a delivery
		// watermark gets the gap-free delivery stream (resumed from that watermark); an
		// older client gets the version-vector delta. Both hold only in-scope operations.
		const clientVector = wireToVersionVector(msg.versionVector)
		const excludeOwn =
			this.clientDeliveryWatermark !== null && this.clientDeliveryWatermark > 0
				? (this.clientNodeId ?? undefined)
				: undefined
		const deliveryPlan =
			this.clientDeliveryWatermark !== null
				? await this.collectDeliveryStream(this.clientDeliveryWatermark, excludeOwn)
				: null
		const deltaPlan = deliveryPlan === null ? await this.collectDeltaOperations(clientVector) : []

		// Only reveal vector entries for the client's own node and the nodes whose in-scope
		// operations it is about to receive. The full vector would leak every device id and
		// write count across tenants, and echoing the nodes the client names in its own
		// vector would make the handshake a write-count oracle for any device id (RT-7).
		// The client only reads its own entry (pending count and upload delta).
		const visibleNodes = new Set<string>([msg.nodeId])
		const plannedOps = deliveryPlan
			? deliveryPlan.deliverable.filter((item) => !item.retraction).map((item) => item.operation)
			: deltaPlan
		for (const op of plannedOps) {
			visibleNodes.add(op.nodeId)
		}
		const visibleServerVector = new Map(
			[...serverVector].filter(([nodeId]) => visibleNodes.has(nodeId)),
		)

		// Send handshake response with the visible version vector and accepted scope
		const response: SyncMessage = {
			type: 'handshake-response',
			messageId: generateUUIDv7(),
			nodeId: this.store.getNodeId(),
			versionVector: versionVectorToWire(visibleServerVector),
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
			...(this.authContext?.downlinkScopes
				? {
						acceptedScope: this.authContext.downlinkScopes,
						acceptedDownlinkScopes: this.authContext.downlinkScopes,
					}
				: {}),
			...(this.authContext?.uplinkScopes
				? { acceptedUplinkScopes: this.authContext.uplinkScopes }
				: {}),
			...(this.issuedNodeToken !== null ? { nodeToken: this.issuedNodeToken } : {}),
		}
		this.issuedNodeToken = null
		this.sendToClient(response)

		this.emitter?.emit({ type: 'sync:connected', nodeId: msg.nodeId })

		// Transition to syncing and send the collected server->client stream. Resuming
		// from a non-zero watermark excludes the client's own operations (it already holds
		// its history); a full resync (watermark 0) includes them so it recovers everything.
		this.state = 'syncing'
		if (this.clientDeliveryWatermark !== null && deliveryPlan !== null) {
			this.lastAckedDeliverySeq = this.clientDeliveryWatermark
			this.lastDeliveryPushAttemptAtMs = Date.now()
			this.sendCollectedDeliveryStream(deliveryPlan, this.clientDeliveryWatermark, true)
		} else {
			this.sendCollectedDelta(deltaPlan)
		}

		// Transition to streaming after delta is sent
		if (this.state !== 'syncing') return
		this.state = 'streaming'
		this.onReady?.(this.sessionId)

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
		// Refuse an oversized batch before decoding it or reading the store (RT-6). The
		// whole batch is refused and nothing is acknowledged, so a client that sent it
		// legitimately can split it and resubmit; no operation is lost.
		if (msg.operations.length > this.maxOpsPerBatch) {
			this.rejectedBatches += 1
			this.sendError(
				'BATCH_TOO_LARGE',
				`Operation batch "${msg.messageId}" holds ${String(msg.operations.length)} operations; the limit is ${String(this.maxOpsPerBatch)} per batch. Send smaller batches.`,
				false,
			)
			return
		}
		const operations = msg.operations.map((s) => this.serializer.decodeOperation(s))
		const applied: Operation[] = []
		let acknowledgedThrough = 0
		let canAdvanceAck = true
		let uniqueOperations = 0
		let duplicateOperations = 0
		let rejectedOperations = 0

		for (const op of operations) {
			if (!canAdvanceAck) {
				continue
			}

			// Charge the rate limiter before anything that touches the store (RT-6): a
			// refused operation (foreign node, out of scope) still costs a store read, so
			// it must count against the budget like an accepted one.
			if (!this.rateLimiter.allow(1)) {
				this.rateLimitedOperations += 1
				this.sendError(
					'RATE_LIMIT',
					`Session exceeded operation rate limit (${String(this.maxOpsPerMinute)} ops/min)`,
					true,
				)
				canAdvanceAck = false
				continue
			}

			// A session may only upload its own device's operations. A foreign nodeId
			// would let one peer advance another device's version-vector entry and make
			// that device skip uploading its real writes. The ack does not advance over a
			// foreign op: its sequence number is not in this client's sequence space.
			if (op.nodeId !== this.clientNodeId || op.timestamp.nodeId !== op.nodeId) {
				// A client may echo back another device's operation that the server itself
				// delivered (its delta is computed against the handshake-time vector). That
				// op is already stored under its id, so accepting it as a duplicate writes
				// nothing and cannot advance any vector: treat it exactly like a duplicate.
				if (await this.isStoredOperation(op)) {
					duplicateOperations += 1
					acknowledgedThrough = op.sequenceNumber
					continue
				}
				this.sendOperationRejected(
					op,
					'NODE_ID_MISMATCH',
					`Operation "${op.id}" claims node "${op.nodeId}" (timestamp node "${op.timestamp.nodeId}") but this session is node "${String(this.clientNodeId)}". A client may only upload operations it authored.`,
					false,
				)
				rejectedOperations += 1
				continue
			}

			const authorization = await this.authorizeClientOperation(op)
			if (!authorization.allowed) {
				this.sendOperationRejected(
					op,
					authorization.code,
					authorization.code === 'SCOPE_VIOLATION'
						? `${authorization.message} Refresh scopes before creating or explicitly resubmitting an authorized operation.`
						: authorization.message,
					false,
				)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			if (!isOperationTimestampValid(op)) {
				this.sendError(
					'INVALID_TIMESTAMP',
					`Operation "${op.id}" timestamp is too far in the future`,
					false,
				)
				canAdvanceAck = false
				continue
			}

			const sizeCheck = validateOperationSize(op, this.maxOperationBytes)
			if (!sizeCheck.valid) {
				this.sendError(
					'OPERATION_TOO_LARGE',
					sizeCheck.message ?? `Operation "${op.id}" is too large`,
					false,
				)
				canAdvanceAck = false
				continue
			}

			const serverOp = this.transformForServerSchema(op)
			if (serverOp === null) {
				this.sendOperationRejected(
					op,
					'SCHEMA_TRANSFORM_UNAVAILABLE',
					`Operation "${op.id}" cannot be transformed from schema v${op.schemaVersion} to server schema v${this.schemaVersion}.`,
					false,
				)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Server-side adjudication of untrusted client operations. Runs after
			// the built-in guards and before materialization, so a rejected op never
			// enters the authoritative log and never relays to other clients.
			if (this.validateOperation && this.koraContext) {
				let decision: Awaited<ReturnType<OperationValidator>>
				try {
					decision = await this.validateOperation(serverOp, {
						auth: this.authContext,
						kora: this.koraContext,
					})
				} catch (error) {
					// A throwing validator must not crash ingestion or silently accept.
					// Treat it as a retriable rejection so the submitter can try again.
					const message = error instanceof Error ? error.message : 'validator error'
					this.sendOperationRejected(
						serverOp,
						'VALIDATION_ERROR',
						`Validator threw: ${message}`,
						true,
					)
					canAdvanceAck = false
					continue
				}
				if (decision.action === 'reject') {
					const retriable = decision.retriable ?? isRetriableRejection(decision.code)
					this.sendOperationRejected(serverOp, decision.code, decision.message, retriable)
					rejectedOperations += 1
					if (retriable) {
						canAdvanceAck = false
					} else {
						acknowledgedThrough = op.sequenceNumber
					}
					continue
				}
				if (decision.action === 'ignore') {
					// The server took responsibility out of band; do not materialize the
					// raw op and do not reject. The batch ack lets the client drop it.
					acknowledgedThrough = op.sequenceNumber
					continue
				}
				// action === 'accept' falls through to normal materialization.
			}

			// What the write points at (foreign-key parents, blob content) must be inside
			// what this writer may read (RT-11, RT-13).
			const references = await this.authorizeReferences(serverOp)
			if (!references.allowed) {
				this.sendOperationRejected(serverOp, references.code, references.message, false)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Re-check authorization inside the store's apply critical section against the
			// row as it is at commit time, so a concurrent ownership change or same-id
			// insert cannot slip in between the pre-check above and this write.
			const uplinkScopes = this.uplinkScopes()
			const applyResult = await applyServerOperation(this.store, serverOp, undefined, {
				authorize: (stored) => authorizeUplinkWrite(serverOp, stored, uplinkScopes),
				// Cascades and set-nulls of a delete are judged against the same scope (RT-10).
				authorizeSideEffect: (effect, stored) => authorizeUplinkWrite(effect, stored, uplinkScopes),
			})
			if (applyResult.rejection) {
				this.sendOperationRejected(
					serverOp,
					applyResult.rejection.code,
					applyResult.rejection.message,
					applyResult.rejection.retriable,
				)
				rejectedOperations += 1
				if (applyResult.rejection.retriable) {
					canAdvanceAck = false
				} else {
					acknowledgedThrough = op.sequenceNumber
				}
				continue
			}
			if (applyResult.result === 'applied') {
				applied.push(...applyResult.appliedOperations)
				uniqueOperations += 1
				acknowledgedThrough = op.sequenceNumber
			} else {
				duplicateOperations += 1
				acknowledgedThrough = op.sequenceNumber
			}
		}

		if (operations.length > 0) {
			this.emitter?.emit({
				type: 'sync:received',
				operations,
				batchSize: operations.length,
				uniqueOperations,
				duplicateOperations,
				rejectedOperations,
			})
		}

		// Send acknowledgment
		const lastOp = operations[operations.length - 1]
		const ack: SyncMessage = {
			type: 'acknowledgment',
			messageId: generateUUIDv7(),
			acknowledgedMessageId: msg.messageId,
			lastSequenceNumber: lastOp ? Math.min(acknowledgedThrough, lastOp.sequenceNumber) : 0,
		}
		this.sendToClient(ack)

		// Relay only newly applied operations to other sessions
		if (applied.length > 0) {
			this.onRelay?.(this.sessionId, applied)
		}
	}

	private transformForServerSchema(op: Operation): Operation | null {
		if (op.schemaVersion === this.schemaVersion) {
			return op
		}
		return applyOperationTransforms(op, this.schemaVersion, this.operationTransforms)
	}

	/** The in-scope operations a version-vector client is missing (not yet sent). */
	private async collectDeltaOperations(clientVector: Map<string, number>): Promise<Operation[]> {
		const serverVector = this.store.getVersionVector()
		const missing: Operation[] = []

		for (const [nodeId, serverSeq] of serverVector) {
			const clientSeq = clientVector.get(nodeId) ?? 0
			if (serverSeq > clientSeq) {
				const ops = await this.store.getOperationRange(nodeId, clientSeq + 1, serverSeq)
				const snapshots = await this.scopeSnapshotsFor(ops)
				for (const op of ops) {
					if (await this.operationVisibleToClient(op, snapshots.get(op.id) ?? null)) {
						missing.push(op)
					}
				}
			}
		}
		return missing
	}

	/** Send a collected version-vector delta in paginated, cursor-carrying batches. */
	private sendCollectedDelta(missing: Operation[]): void {
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
	): Promise<{ sentOperations: number; maxScanned: number; sent: boolean }> {
		const collected = await this.collectDeliveryStream(fromDeliverySeq, excludeNodeId)
		return this.sendCollectedDeliveryStream(collected, fromDeliverySeq, finalizeWhenEmpty)
	}

	/** Scan the delivery log after `fromDeliverySeq` and keep what this session may see. */
	private async collectDeliveryStream(
		fromDeliverySeq: number,
		excludeNodeId?: string,
	): Promise<CollectedDeliveryStream> {
		const scanChunk = Math.max(this.batchSize, 1) * 5
		let scanCursor = fromDeliverySeq
		let maxScanned = fromDeliverySeq
		const deliverable: Array<DeliveredOperation & { retraction?: boolean }> = []

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
				const snapshot = delivered.scopeSnapshot ?? null
				if (await this.operationVisibleToClient(delivered.operation, snapshot)) {
					deliverable.push(delivered)
				} else if (await this.scopeRetractionFor(delivered.operation, snapshot)) {
					deliverable.push({ ...delivered, retraction: true })
				}
			}
			if (chunk.length < scanChunk) break
		}
		return { deliverable, maxScanned }
	}

	/** Send a collected delivery stream as chained base -> max batches. */
	private sendCollectedDeliveryStream(
		collected: CollectedDeliveryStream,
		fromDeliverySeq: number,
		finalizeWhenEmpty: boolean,
	): { sentOperations: number; maxScanned: number; sent: boolean } {
		const { deliverable, maxScanned } = collected
		if (deliverable.length === 0) {
			// Nothing in scope after the cursor. On a handshake resume, send a single empty
			// final batch so the client advances past an out-of-scope tail and completes
			// initial sync. During streaming, send nothing (an empty batch every relay tick
			// would be pure noise); a reconnect re-scans the small tail if needed.
			let sent = false
			if (finalizeWhenEmpty || maxScanned > fromDeliverySeq) {
				sent = this.sendDeliveryBatch([], fromDeliverySeq, maxScanned, 0, true)
			}
			return { sentOperations: 0, maxScanned, sent }
		}

		const totalBatches = Math.ceil(deliverable.length / this.batchSize)
		let base = fromDeliverySeq
		for (let i = 0; i < totalBatches; i++) {
			const slice = deliverable.slice(i * this.batchSize, (i + 1) * this.batchSize)
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
		return {
			sentOperations: deliverable.filter((item) => !item.retraction).length,
			maxScanned,
			sent: true,
		}
	}

	/** Build, track, and send one chained delivery-stream batch. */
	private sendDeliveryBatch(
		slice: Array<DeliveredOperation & { retraction?: boolean }>,
		base: number,
		max: number,
		batchIndex: number,
		isFinal: boolean,
	): boolean {
		const batchMsg: SyncMessage = {
			type: 'operation-batch',
			messageId: generateUUIDv7(),
			operations: slice
				.filter((delivered) => !delivered.retraction)
				.map((delivered) => this.serializer.encodeOperation(delivered.operation)),
			...(slice.some((delivered) => delivered.retraction)
				? {
						retractions: slice
							.filter((delivered) => delivered.retraction)
							.map((delivered) => ({
								collection: delivered.operation.collection,
								recordId: delivered.operation.recordId,
							})),
					}
				: {}),
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
		const sent = this.sendToClient(batchMsg)
		const sentOperations = slice.filter((delivered) => !delivered.retraction)
		if (sentOperations.length > 0) {
			this.emitter?.emit({
				type: 'sync:sent',
				operations: sentOperations.map((delivered) => delivered.operation),
				batchSize: sentOperations.length,
			})
		}
		return sent
	}

	/** The scope snapshots of these operations, when the store keeps them (RT-14). */
	private async scopeSnapshotsFor(
		operations: Operation[],
	): Promise<Map<string, OperationScopeSnapshot>> {
		if (!this.store.getOperationScopeSnapshots || operations.length === 0) return new Map()
		try {
			return await this.store.getOperationScopeSnapshots(operations.map((op) => op.id))
		} catch {
			return new Map()
		}
	}

	/**
	 * Download visibility of one operation. With a scope snapshot (RT-14) the
	 * operation is judged on the record's scope values right after it was applied, so
	 * history written while a record belonged to someone else stays hidden after an
	 * ownership transfer, and a previous owner still receives its own history. Query
	 * subsets (a client-chosen narrowing, not an authorization) keep using the current
	 * row. Operations without a snapshot (legacy rows, custom stores) fall back to the
	 * current row plus `op.data`.
	 */
	private async operationVisibleToClient(
		op: Operation,
		snapshot: OperationScopeSnapshot | null = null,
	): Promise<boolean> {
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		const subsets = this.syncQuerySubsets
		if (snapshot?.post) {
			if (!recordMatchesScopes(op.collection, { ...snapshot.post, id: op.recordId }, scopes)) {
				return false
			}
			if (subsets.length === 0) return true
			const current = await this.lookupRecordFields(op.collection, op.recordId)
			return operationMatchesQuerySubsets(op, subsets, current)
		}
		// Visibility is judged on the server-materialized row plus op.data, never on the
		// writer's previousData (RT-3: it is unverified, so it could push an op into
		// another tenant's log or hide it from the writer's own devices). A partial
		// update (or a delete) may not carry the scope / query-subset fields in its own
		// data, so backfill them from the materialized record (including a soft-deleted
		// one) whenever they are missing. Only look up when needed so the common case
		// (inserts, or ops that already carry the fields) stays lookup-free.
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

	/** True when the store already holds exactly this operation (same node, sequence and id). */
	private async isStoredOperation(op: Operation): Promise<boolean> {
		try {
			const stored = await this.store.getOperationRange(
				op.nodeId,
				op.sequenceNumber,
				op.sequenceNumber,
			)
			return stored.some((candidate) => candidate.id === op.id)
		} catch {
			return false
		}
	}

	/**
	 * The scopes this session may write under. Fails closed: with auth configured but
	 * no accepted authentication, the session may write nothing (an empty scope map),
	 * never everything.
	 */
	private uplinkScopes(): ScopeMap | undefined {
		if (this.auth && !this.authContext) return {}
		return this.authContext?.uplinkScopes ?? this.authContext?.scopes
	}

	/**
	 * Upload authorization, independent from the client's downloaded/query view. The
	 * stored row (including a soft-deleted one) is always loaded when scopes apply and
	 * is authoritative; client-supplied previousData is never consulted.
	 */
	private async authorizeClientOperation(op: Operation): Promise<UplinkAuthorizationResult> {
		const scopes = this.uplinkScopes()
		const stored = scopes ? await this.lookupRecordFields(op.collection, op.recordId) : undefined
		return authorizeUplinkWrite(op, stored ?? null, scopes)
	}

	/**
	 * True when this update moved the record out of the session's scope, judged on the
	 * store's own before/after values (RT-15), never on the writer's previousData. An
	 * operation without a snapshot never produces a retraction (fail quiet: the
	 * client keeps what it already had, and no other tenant's record id leaks).
	 */
	private async scopeRetractionFor(
		op: Operation,
		snapshot: OperationScopeSnapshot | null = null,
	): Promise<boolean> {
		if (this.scopeExitPolicy !== 'retract') return false
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		if (!scopes || !snapshot) return false
		return snapshotExitsScopes(op, snapshot, scopes)
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
	): Promise<MaterializedRecord | undefined> {
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

	/**
	 * A Yjs doc-channel update is a write to a richtext field: the sender must be
	 * allowed to write the stored record (same rule as operation uploads). The stored
	 * row is handed to the relay so delivery can be limited to sessions whose download
	 * scope contains the record.
	 */
	private async handleYjsDocUpdate(msg: YjsDocUpdateMessage): Promise<void> {
		if (!this.onYjsDocUpdate) return
		const stored = (await this.lookupRecordFields(msg.collection, msg.recordId)) ?? null
		const decision = authorizeRecordWrite(msg.collection, msg.recordId, stored, this.uplinkScopes())
		if (!decision.allowed) {
			this.logger?.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'session.yjs_update_rejected',
				sessionId: this.sessionId,
				nodeId: this.clientNodeId ?? undefined,
				details: { collection: msg.collection, recordId: msg.recordId, code: decision.code },
			})
			return
		}
		this.onYjsDocUpdate(this.sessionId, msg, stored)
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
		this.clearExpiryTimer()
		this.flushOrphanedRelays()
		this.emitter?.emit({ type: 'sync:disconnected', reason: 'transport closed' })
		this.onClose?.(this.sessionId)
	}
}

/** Delivery-log operations collected for one session, before they are batched. */
interface CollectedDeliveryStream {
	deliverable: Array<DeliveredOperation & { retraction?: boolean }>
	maxScanned: number
}

function selectWireFormat(supportedWireFormats?: WireFormat[]): WireFormat {
	if (supportedWireFormats?.includes('protobuf')) {
		return 'protobuf'
	}

	return 'json'
}
