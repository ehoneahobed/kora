import type {
	KoraEventEmitter,
	Operation,
	OperationTransform,
	RecordFieldVersions,
	SchemaDefinition,
	VersionVector,
} from '@korajs/core'
import { canonicalizeLegacyOperation, isServerNodeId, operationSchemaView } from '@korajs/core'
import { SyncError, generateUUIDv7, hashBlob } from '@korajs/core'
import { topologicalSort } from '@korajs/core/internal'
import type { SideEffectOp } from '@korajs/merge'
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
import { SyncEncryptor, decodeBlobChunkBytes } from '@korajs/sync'
import {
	type DeltaCursor,
	INVALID_OPERATION_ID,
	LEGACY_SYNC_PROTOCOL_VERSION,
	NegotiatedMessageSerializer,
	PLAINTEXT_REJECTED,
	PROTOCOL_V1_DEPRECATED,
	ProtobufMessageSerializer,
	SCHEMA_MISMATCH_PREFIX,
	SYNC_PROTOCOL_VERSION,
	type SyncQuerySubset,
	createDeltaCursorFromBatch,
	declaredProtocolVersion,
	decodeDeltaCursor,
	dedupeQuerySubsets,
	encodeDeltaCursor,
	isClientSchemaVersionSupported,
	operationMatchesQuerySubsets,
	sliceOperationsAfterCursor,
	versionVectorToWire,
	wireToVersionVector,
} from '@korajs/sync'
import {
	restoreUndefinedFromPrevious,
	scopeViewKey,
	verifyInboundOperation,
} from '@korajs/sync/internal'
import {
	RESTRICTED_REJECTION_CODE,
	applyServerOperation,
	deriveServerSideEffects,
	isAuthoredCopyOfSideEffect,
	undoneSideEffectsOfStoredDelete,
} from '../apply/apply-server-operation'
import { INVALID_IDENTIFIER_CODE, isStorableIdentifier } from '../apply/ingest-validation'
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
	snapshotEntersScopes,
	snapshotExitsScopes,
	snapshotLacksScopeFields,
	snapshotValuesWithFallback,
} from '../scopes/server-scope-filter'
import type { ProductionHttpRouteContext } from '../server/route-context'
import type {
	DeliveredOperation,
	LegacySequencePair,
	MaterializedRecord,
	OperationResolution,
	OperationResolutionOutcome,
	OperationScopeSnapshot,
	ServerStore,
	StoredOperationKey,
} from '../store/server-store'
import { SEQUENCE_CONFLICT_CODE } from '../store/server-store'
import type { ServerTransport } from '../transport/server-transport'
import type { AuthContext, AuthProvider, SessionRevocation } from '../types'
import {
	FORGED_DUPLICATE_CODE,
	isRewrittenEcho,
	isSameOperationAsStored,
} from './duplicate-identity'
import { isOperationTimestampValid } from './operation-validation'
import { buildScopeEntryOperation } from './scope-entry'
import {
	BATCH_LOOKUP_RATE_COST,
	DEFAULT_MAX_BLOB_REQUESTS_PER_MINUTE,
	DEFAULT_MAX_OPERATION_BYTES,
	DEFAULT_MAX_OPS_PER_BATCH,
	DEFAULT_MAX_OPS_PER_MINUTE,
	type IngestRateLimiter,
	SessionRateLimiter,
	validateOperationSize,
} from './session-operation-limits'

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_SCHEMA_VERSION = 1

/** Refusal of an operation larger than `maxOperationBytes` (RT-86), per operation. */
export const OPERATION_TOO_LARGE_CODE = 'OPERATION_TOO_LARGE'

/** Refusal of an operation whose schema transform broke its contract (RT-84). */
export const SCHEMA_TRANSFORM_INVALID_CODE = 'SCHEMA_TRANSFORM_INVALID'
/** Default time a connection has to send its handshake before it is closed (SRV-6). */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
/**
 * Default outbound bytes queued on the socket above which the delivery stream pauses
 * until the client drains it (SRV-5/SRV-6 backpressure): 1 MiB.
 */
export const DEFAULT_DELIVERY_HIGH_WATER_BYTES = 1024 * 1024
/** How often a paused delivery stream re-checks the transport's queued bytes. */
const DELIVERY_DRAIN_POLL_MS = 25
/**
 * Longest wait between re-sends of an unacknowledged delivery (the stale window
 * doubles on every re-send without progress, LMS #12): five minutes.
 */
export const MAX_DELIVERY_RETRANSMIT_BACKOFF_MS = 5 * 60_000
/** Delivery retransmit timeout before any round trip was measured. */
const INITIAL_DELIVERY_RTO_MS = 2_000
/** Floor of the measured delivery retransmit timeout. */
const MIN_DELIVERY_RTO_MS = 1_000
/** Ceiling of the measured delivery retransmit timeout (before backoff). */
const MAX_DELIVERY_RTO_MS = 60_000
/** Unacknowledged batches remembered for round-trip samples. */
const MAX_TRACKED_UNACKED_BATCHES = 4096
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
/**
 * Prefix of a PROVISIONAL anonymous claim (RT-21):
 * `kora:anon-pending:<sha256(token)>:<expiresAtMs>`. It becomes the confirmed
 * `kora:anon-node:<sha256(token)>` once the device proves it saved the token.
 */
const ANONYMOUS_PENDING_OWNER_PREFIX = 'kora:anon-pending:'
/** Default time an unconfirmed provisional claim stays re-issuable: 24 hours. */
export const DEFAULT_ANONYMOUS_CLAIM_TTL_MS = 24 * 60 * 60 * 1000

function pendingOwner(tokenHash: string, expiresAtMs: number): string {
	return `${ANONYMOUS_PENDING_OWNER_PREFIX}${tokenHash}:${String(expiresAtMs)}`
}

function parsePendingOwner(
	owner: string | null,
): { tokenHash: string; expiresAtMs: number } | null {
	if (owner === null || !owner.startsWith(ANONYMOUS_PENDING_OWNER_PREFIX)) return null
	const rest = owner.slice(ANONYMOUS_PENDING_OWNER_PREFIX.length)
	const separator = rest.lastIndexOf(':')
	if (separator <= 0) return null
	const expiresAtMs = Number(rest.slice(separator + 1))
	if (!Number.isFinite(expiresAtMs)) return null
	return { tokenHash: rest.slice(0, separator), expiresAtMs }
}

/** Outcome of an anonymous device's node claim at handshake (RT-12, RT-21). */
type AnonymousClaimOutcome =
	| {
			ok: true
			/** The claim owner now recorded for the node. */
			owner: string
			/** The device key (`kora:anon-node:<hash>`), stable across confirmation. */
			deviceKey: string
			/** A token to hand the device in the response, when one was (re-)issued. */
			issuedToken: string | null
			/** Set while the claim is provisional: what confirmation replaces it with. */
			pending: { owner: string; token: string; confirmedOwner: string } | null
	  }
	| { ok: false }
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
	return `${ANONYMOUS_NODE_OWNER_PREFIX}${await nodeTokenHash(nodeToken)}`
}

async function nodeTokenHash(nodeToken: string): Promise<string> {
	return hashBlob(new TextEncoder().encode(nodeToken))
}

/**
 * Session-ending error codes, all retriable. `AUTH_REVOKED` / `AUTH_EXPIRED`: the
 * client refreshes its credential and re-handshakes. `SCOPE_CHANGED` (RT-26): the
 * principal's grant changed; the client simply reconnects and gets the new scope.
 */
export type SessionTerminationCode = 'AUTH_REVOKED' | 'AUTH_EXPIRED' | 'SCOPE_CHANGED'

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
	/** Schema transforms: judged views of older operations (transforms at fold time, RT-84). */
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
	 * Blob chunk requests accepted per minute, separate from the operation budget
	 * (RT-24). Defaults to 6000.
	 */
	maxBlobRequestsPerMinute?: number
	/** Length of the blob request window in ms. One minute; shorter only in tests. */
	blobRequestWindowMs?: number
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
	/** See `KoraSyncServerConfig.allowLegacyAnonymousClaims` (RT-21). Defaults to true. */
	allowLegacyAnonymousClaims?: boolean
	/** See `KoraSyncServerConfig.anonymousClaimTtlMs` (RT-21). Defaults to 24 hours. */
	anonymousClaimTtlMs?: number
	/**
	 * True when another live session (not `exceptSessionId`) is connected as `nodeId`.
	 * A provisional anonymous claim is never re-issued away from a connected device.
	 */
	isNodeLive?: (nodeId: string, exceptSessionId: string) => boolean
	/**
	 * Time a new connection has to deliver its handshake, in ms (SRV-6). A connection
	 * that sends none is closed with `HANDSHAKE_TIMEOUT`. Defaults to 10 seconds; 0
	 * disables the deadline.
	 */
	handshakeTimeoutMs?: number
	/**
	 * Queued outbound bytes above which the delivery stream pauses until the client
	 * drains its socket (transports that report `bufferedAmount`). Defaults to 1 MiB.
	 */
	deliveryHighWaterBytes?: number
	/**
	 * The ingest rate limiter for a node, shared across that node's sessions so a
	 * reconnect does not reset it (SRV-6). Called once the handshake binds the node,
	 * with the authenticated principal's user id (null for anonymous and
	 * unauthenticated sessions) so a per-user budget can be layered on top: a user
	 * minting node ids must not multiply the per-node budget.
	 * Without it the session keeps a private limiter.
	 */
	rateLimiterFor?: (nodeId: string, principal: string | null) => IngestRateLimiter
	/**
	 * Interval of the application-level heartbeat sent to clients that advertised
	 * support for it, in ms (LMS #12). The handshake response tells the client the
	 * interval so it can declare the connection dead after missing two. 0 disables it.
	 */
	appHeartbeatIntervalMs?: number
	/**
	 * Node ids whose operations this server authors (protocol v2). Sent to clients in
	 * the handshake response (`authoritativeNodeIds`); only operations from these nodes
	 * may carry server-authored metadata (`fieldVersions`, `foldState`). Defaults to the
	 * ids the store folds with (`ServerStore.getAuthoritativeNodeIds`), which is what
	 * `KoraSyncServer` always passes. Scope-entry operations (`kora:scope-entry`) are not
	 * listed: they carry the server's fold state and are joined, never folded as writes.
	 */
	authoritativeNodeIds?: readonly string[]
	/**
	 * End-to-end encryption policy (protocol v2, ENC-3). With `required`, every uploaded
	 * data-bearing operation must carry the encryption envelope; a plaintext one is
	 * refused non-retriably (`PLAINTEXT_REJECTED`), unless `allowPlaintextMigration` is
	 * set for a migration window. Without it, the server stores whatever it receives
	 * (envelope operations always opaquely).
	 */
	encryption?: { required: boolean; allowPlaintextMigration?: boolean }
}

/** A side effect of an applied delete whose server copy waits for the author's own (RT-69). */
interface DeferredSideEffect {
	parent: Operation
	effect: SideEffectOp
	/** Ids of the author's operations in the batch that are copies of this effect. */
	copyIds: string[]
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
	/** A provisional anonymous claim awaiting the device's confirmation (RT-21). */
	private pendingNodeClaim: { owner: string; token: string; confirmedOwner: string } | null = null
	private readonly allowLegacyAnonymousClaims: boolean
	private readonly anonymousClaimTtlMs: number
	private readonly isNodeLive: ((nodeId: string, exceptSessionId: string) => boolean) | null
	/** The credential presented at handshake, kept to re-validate the session (RT-18). */
	private credential: string | null = null
	/** The scope the client asked for at handshake, kept to re-resolve scopes (RT-26). */
	private handshakeScope: HandshakeMessage['syncScope'] = undefined
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
	 * watermark, as reported in acks). A retransmission rewinds the send cursor to here,
	 * so a dropped or unapplied batch is always re-included by a re-scan from the
	 * acknowledged position: recovery never depends on a bounded retransmit buffer.
	 * Seeded from the client's reported watermark at handshake.
	 */
	private lastAckedDeliverySeq = 0
	/**
	 * The delivery send cursor (SRV-3): the max of the last batch sent. Live pushes
	 * chain from it (base = lastSent), so each operation goes out once per retransmit
	 * epoch instead of the whole unacknowledged backlog on every write. Invariant:
	 * lastAcked <= lastSent. It rewinds to lastAcked only when the outstanding delivery
	 * went unacknowledged for the (backed-off) stale window.
	 */
	private lastSentDeliverySeq = 0
	/** The highest batch max ever sent to this client (acks are capped by it). */
	private highestSentDeliverySeq = 0
	/**
	 * Own-node operations at or below this delivery sequence are streamed to this
	 * client; above it they are skipped (it uploaded them itself). Set at handshake: a
	 * full resync (watermark 0) recovers the client's own history up to the frontier
	 * at that moment; a resume excludes all of them.
	 */
	private ownOperationsIncludedThrough = 0
	/** When the delivery last made progress (an ack advanced, or a fresh send/rewind). */
	private lastDeliveryProgressAtMs = 0
	/** Consecutive rewinds without acknowledgment progress (drives the backoff, LMS #12). */
	private deliveryRewinds = 0
	/**
	 * Sent, not yet acknowledged delivery batches in send order (their max and send
	 * time), for round-trip samples. `resent` marks a re-sent range, which yields no
	 * sample (Karn's rule: its ack cannot be matched to one transmission).
	 */
	private readonly unackedBatches: Array<{ max: number; sentAtMs: number; resent: boolean }> = []
	private smoothedRttMs: number | null = null
	private rttVarianceMs = 0
	/**
	 * Retransmit timeout of the delivery stream (RFC 6298 style: smoothed round trip
	 * plus four deviations, floored). An outstanding delivery with no acknowledgment
	 * progress for this long (doubled per consecutive re-send) is re-sent from the
	 * acknowledged position. Round trips include the client's apply time, so a slow
	 * device earns a longer timeout instead of spurious re-sends.
	 */
	private retransmitTimeoutMs = INITIAL_DELIVERY_RTO_MS
	private retransmitTimer: ReturnType<typeof setTimeout> | null = null
	/** A delivery push is queued but not started: further wake-ups coalesce into it. */
	private deliveryPushQueued = false
	/** Serializes delivery pushes so their batches never interleave. */
	private deliveryPushChain: Promise<void> = Promise.resolve()
	/**
	 * Records prefetched for the delivery chunk being filtered (LMS #11: one batched
	 * lookup per collection per chunk instead of one query per operation). Keyed
	 * `collection\u0000id`; null marks a record known to be absent. Only set while a
	 * chunk is filtered.
	 */
	private recordLookupCache: Map<string, MaterializedRecord | null> | null = null
	private readonly deliveryHighWaterBytes: number
	private readonly handshakeTimeoutMs: number
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null
	private handshakeReceived = false
	private readonly rateLimiterFor:
		| ((nodeId: string, principal: string | null) => IngestRateLimiter)
		| null
	private readonly appHeartbeatIntervalMs: number
	private appHeartbeatTimer: ReturnType<typeof setInterval> | null = null
	/** Last time anything was sent to the client (a heartbeat is skipped when recent). */
	private lastClientSendAtMs = 0

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
	private rateLimiter: IngestRateLimiter
	/** Separate budget for blob chunk requests (RT-24). */
	private readonly blobRateLimiter: SessionRateLimiter
	/** Operations refused by the rate limiter (RT-6), for diagnostics. */
	private rateLimitedOperations = 0
	/** Batches refused whole for exceeding {@link maxOpsPerBatch} (RT-6). */
	private rejectedBatches = 0
	/** Blob chunk requests answered "not held" because the session was over budget (RT-17). */
	private rateLimitedBlobRequests = 0
	/**
	 * The client advertised the `sequenceReservation` handshake capability (RT-37): it
	 * reserves sequence numbers in-transaction, so a second operation under a held
	 * (node, sequence) is refused with SEQUENCE_CONFLICT. False for a legacy client
	 * (Kora <= beta.13), whose duplicate pairs are stored instead.
	 */
	private sequenceReservation = false
	/** Legacy duplicate pairs this session stored (RT-37), for diagnostics. */
	private legacySequencePairs = 0
	/** Protocol version the client declared in its handshake (1 when absent). */
	private clientProtocolVersion = LEGACY_SYNC_PROTOCOL_VERSION
	private readonly authoritativeNodeIds: readonly string[] | null
	/** Hash version an undeclared uploaded id was verified as (RT-64), by operation object. */
	private readonly matchedHashVersions = new WeakMap<Operation, 1 | 2>()
	/** Uploads whose data is stored as the beta.13 writer held it (RT-71). */
	private readonly restoredLegacyData = new WeakMap<Operation, Operation['data']>()
	/** Operations accepted with an unverified legacy (beta.13) id (RT-71). */
	private unverifiedLegacyOperations = 0
	private forgedDuplicates = 0
	private readonly encryptionPolicy: { required: boolean; allowPlaintextMigration: boolean }
	/** Uploaded operations refused because their id is not their content hash (CORE-1). */
	private invalidOperationIds = 0
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
		this.authoritativeNodeIds = options.authoritativeNodeIds
			? [...options.authoritativeNodeIds]
			: null
		this.encryptionPolicy = {
			required: options.encryption?.required === true,
			allowPlaintextMigration: options.encryption?.allowPlaintextMigration === true,
		}
		this.maxOpsPerMinute = options.maxOpsPerMinute ?? DEFAULT_MAX_OPS_PER_MINUTE
		this.rateLimiter = new SessionRateLimiter(this.maxOpsPerMinute)
		this.blobRateLimiter = new SessionRateLimiter(
			options.maxBlobRequestsPerMinute ?? DEFAULT_MAX_BLOB_REQUESTS_PER_MINUTE,
			options.blobRequestWindowMs ?? 60_000,
		)
		this.maxOpsPerBatch = options.maxOpsPerBatch ?? DEFAULT_MAX_OPS_PER_BATCH
		this.validateOperation = options.validateOperation ?? null
		this.koraContext = options.koraContext ?? null
		this.blobAccess = options.blobAccess ?? null
		this.allowLegacyAnonymousClaims = options.allowLegacyAnonymousClaims ?? true
		this.anonymousClaimTtlMs = options.anonymousClaimTtlMs ?? DEFAULT_ANONYMOUS_CLAIM_TTL_MS
		this.isNodeLive = options.isNodeLive ?? null
		this.deliveryHighWaterBytes =
			options.deliveryHighWaterBytes ?? DEFAULT_DELIVERY_HIGH_WATER_BYTES
		this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
		this.rateLimiterFor = options.rateLimiterFor ?? null
		this.appHeartbeatIntervalMs = options.appHeartbeatIntervalMs ?? 0
	}

	/**
	 * Start handling messages from the client transport.
	 */
	start(): void {
		// A connection that never handshakes would hold a session (and a connection
		// slot) forever (SRV-6): close it once the deadline passes.
		if (this.handshakeTimeoutMs > 0) {
			this.handshakeTimer = setTimeout(() => {
				this.handshakeTimer = null
				if (this.handshakeReceived || this.state === 'closed') return
				this.sendError(
					'HANDSHAKE_TIMEOUT',
					`No handshake within ${String(this.handshakeTimeoutMs)} ms of connecting.`,
					true,
				)
				this.close('handshake timeout')
			}, this.handshakeTimeoutMs)
			;(this.handshakeTimer as { unref?: () => void }).unref?.()
		}
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
			this.pushDeliveryStream('continue')
			return
		}
		if (operations.length === 0) return
		// Visibility now requires an async record lookup (scope/subset backfill); relay
		// is fire-and-forget, so run it without blocking the caller's fan-out loop.
		void this.relayVisibleOperations(operations)
	}

	/**
	 * Push newly-available in-scope operations to a delivery-watermark client, chained
	 * from the send cursor (SRV-3): only what was not sent yet goes out. `rewind`
	 * first moves the cursor back to the acknowledged position (a retransmission), and
	 * `initial` is the handshake stream (it always ends in a final batch, even an empty
	 * one, so the client completes initial sync). Pushes are serialized so their batches
	 * never interleave (which would break the base/max chain); wake-ups that arrive
	 * while one is queued coalesce into it.
	 */
	private pushDeliveryStream(mode: 'continue' | 'rewind' | 'initial' = 'continue'): void {
		if (mode === 'continue') {
			if (this.deliveryPushQueued) return
			this.deliveryPushQueued = true
		}
		this.deliveryPushChain = this.deliveryPushChain.then(async () => {
			if (mode === 'continue') this.deliveryPushQueued = false
			if (this.state !== 'streaming' || !this.transport.isConnected()) return
			try {
				if (mode === 'rewind' && this.lastSentDeliverySeq > this.lastAckedDeliverySeq) {
					this.lastSentDeliverySeq = this.lastAckedDeliverySeq
					this.lastDeliveryProgressAtMs = Date.now()
					// Earlier transmissions can no longer be matched to their acks (Karn).
					this.unackedBatches.length = 0
				}
				await this.streamDelivery(this.lastSentDeliverySeq, mode === 'initial')
			} catch (error) {
				// A failed push (for example a transient store read error) must not reject the
				// chain and stall every future push. What it did not send stays above the send
				// cursor, so the next wake-up (a relay or the delivery poll) sends it.
				this.logger?.log({
					timestamp: Date.now(),
					level: 'warn',
					event: 'session.delivery_push_failed',
					sessionId: this.sessionId,
					nodeId: this.clientNodeId ?? undefined,
					error: error instanceof Error ? error.message : String(error),
				})
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
				// A record entering the scope arrives whole, before the op that moved it (RT-19).
				const entry = await this.scopeEntryFor(op, snapshot)
				if (entry) visibleOperations.push(entry)
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
	 *
	 * For a delivery-watermark client it re-sends an outstanding (sent, unacknowledged)
	 * delivery from the acknowledged position, under the same backed-off window as the
	 * retransmit timer; `staleMs` 0 re-sends at once (a deterministic trigger for tests).
	 */
	retransmitPendingRelays(staleMs = 0): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		if (this.clientDeliveryWatermark !== null) {
			if (this.lastSentDeliverySeq > this.lastAckedDeliverySeq) {
				this.pushDeliveryStreamIfSupported(staleMs, { serverFrontier: this.lastSentDeliverySeq })
			}
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
	 * watermarks: for operations appended by another server/store instance (sent from
	 * the send cursor), and for a delivery that went unacknowledged (re-sent from the
	 * acknowledged position once it made no progress for `staleMs`, backed off while it
	 * stays stuck). `staleMs` 0 re-sends at once.
	 *
	 * @param staleMs - Base stale window before an unacknowledged delivery is re-sent
	 * @param options - `serverFrontier`: the store's max delivery sequence, when known;
	 *   `trackStall`: emit `sync:delivery-stalled` after repeated re-sends
	 */
	pushDeliveryStreamIfSupported(
		staleMs = 0,
		options: { trackStall?: boolean; serverFrontier?: number } = {},
	): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		if (this.clientDeliveryWatermark === null) return
		const frontier = options.serverFrontier
		if (frontier !== undefined && frontier <= this.lastAckedDeliverySeq) {
			// Everything is acknowledged: nothing to send or re-send.
			this.deliveryRewinds = 0
			return
		}
		if (frontier !== undefined && frontier > this.lastSentDeliverySeq) {
			// New operations (possibly committed through another instance): send them.
			this.pushDeliveryStream('continue')
			return
		}
		if (this.lastSentDeliverySeq <= this.lastAckedDeliverySeq) {
			// Nothing outstanding. Without a known frontier, look for anything new.
			if (frontier === undefined) this.pushDeliveryStream('continue')
			return
		}
		// Everything is sent but not all acknowledged. The retransmit timer normally
		// handles this; the poll is a safety net with the same rule: re-send from the
		// acknowledged position only once the delivery made no progress for the window
		// (backed off while it stays stuck), so a client that cannot apply (or a
		// half-open socket) is not re-sent its backlog forever (LMS #12).
		if (this.transportBufferedAmount() > 0) return // still draining what was sent
		const window =
			staleMs <= 0
				? 0
				: Math.max(
						this.retransmitWindowMs(),
						Math.min(
							staleMs * 2 ** Math.min(this.deliveryRewinds, 16),
							MAX_DELIVERY_RETRANSMIT_BACKOFF_MS,
						),
					)
		if (Date.now() - this.lastDeliveryProgressAtMs < window) return
		this.rewindDelivery(options.trackStall === true)
	}

	/** Book-keeping for one sent delivery batch ending at `max`. */
	private recordDeliverySent(max: number): void {
		const now = Date.now()
		if (max <= this.lastAckedDeliverySeq) return
		if (this.lastSentDeliverySeq <= this.lastAckedDeliverySeq) {
			// A new outstanding delivery: its retransmit window starts now.
			this.lastDeliveryProgressAtMs = now
		}
		const resent = max <= this.highestSentDeliverySeq
		if (max > this.lastSentDeliverySeq) this.lastSentDeliverySeq = max
		if (max > this.highestSentDeliverySeq) this.highestSentDeliverySeq = max
		this.unackedBatches.push({ max, sentAtMs: now, resent })
		if (this.unackedBatches.length > MAX_TRACKED_UNACKED_BATCHES) this.unackedBatches.shift()
		this.armRetransmitTimer()
	}

	/**
	 * A delivery acknowledgment: advance the confirmed watermark (a retransmission
	 * rewinds to it), take a round-trip sample, and reset the backoff. The watermark
	 * never passes what was sent: a client cannot acknowledge what it never received.
	 */
	private noteDeliveryAcked(deliverySequence: number): void {
		const acked = Math.min(deliverySequence, this.highestSentDeliverySeq)
		if (acked <= this.lastAckedDeliverySeq) return
		const now = Date.now()
		this.lastAckedDeliverySeq = acked
		this.lastDeliveryProgressAtMs = now
		this.deliveryRewinds = 0
		// An ack of a batch sent before a rewind: the re-send skips what it covers.
		if (this.lastSentDeliverySeq < acked) this.lastSentDeliverySeq = acked
		let sample: number | null = null
		while (this.unackedBatches.length > 0) {
			const first = this.unackedBatches[0]
			if (!first || first.max > acked) break
			this.unackedBatches.shift()
			sample = first.resent ? null : now - first.sentAtMs
		}
		if (sample !== null) this.recordRoundTrip(sample)
		this.armRetransmitTimer()
	}

	/** Fold one round-trip sample into the retransmit timeout (RFC 6298). */
	private recordRoundTrip(sampleMs: number): void {
		const sample = Math.max(0, sampleMs)
		if (this.smoothedRttMs === null) {
			this.smoothedRttMs = sample
			this.rttVarianceMs = sample / 2
		} else {
			this.rttVarianceMs = 0.75 * this.rttVarianceMs + 0.25 * Math.abs(this.smoothedRttMs - sample)
			this.smoothedRttMs = 0.875 * this.smoothedRttMs + 0.125 * sample
		}
		this.retransmitTimeoutMs = Math.min(
			MAX_DELIVERY_RTO_MS,
			Math.max(MIN_DELIVERY_RTO_MS, this.smoothedRttMs + 4 * this.rttVarianceMs),
		)
	}

	/**
	 * The current retransmit window: the timeout, which each re-send doubled (up to
	 * five minutes) and which only a fresh round-trip sample brings back down.
	 */
	private retransmitWindowMs(): number {
		return Math.min(this.retransmitTimeoutMs, MAX_DELIVERY_RETRANSMIT_BACKOFF_MS)
	}

	/**
	 * (Re)arm the retransmit timer for the outstanding delivery: it fires once no
	 * acknowledgment progress was made for the retransmit window.
	 */
	private armRetransmitTimer(): void {
		if (this.retransmitTimer !== null) {
			clearTimeout(this.retransmitTimer)
			this.retransmitTimer = null
		}
		if (this.state === 'closed' || this.lastSentDeliverySeq <= this.lastAckedDeliverySeq) return
		const due = this.lastDeliveryProgressAtMs + this.retransmitWindowMs() - Date.now()
		this.retransmitTimer = setTimeout(
			() => {
				this.retransmitTimer = null
				this.onRetransmitTimeout()
			},
			Math.max(0, due),
		)
		;(this.retransmitTimer as { unref?: () => void }).unref?.()
	}

	/**
	 * No acknowledgment progress for the retransmit window: re-send from the
	 * acknowledged position (the batch was dropped, or the client could not apply it),
	 * unless the socket is still draining what was sent.
	 */
	private onRetransmitTimeout(): void {
		if (this.state !== 'streaming' || !this.transport.isConnected()) return
		if (this.lastSentDeliverySeq <= this.lastAckedDeliverySeq) return
		if (Date.now() - this.lastDeliveryProgressAtMs < this.retransmitWindowMs()) {
			this.armRetransmitTimer()
			return
		}
		if (this.transportBufferedAmount() > 0) {
			// Still writing to a slow link: that is not a loss. Look again later.
			this.lastDeliveryProgressAtMs = Date.now()
			this.armRetransmitTimer()
			return
		}
		this.rewindDelivery(true)
	}

	/** Re-send the outstanding delivery from the acknowledged position. */
	private rewindDelivery(trackStall: boolean): void {
		this.deliveryRewinds += 1
		// Exponential backoff that survives acknowledgment progress until a fresh
		// round-trip sample (RFC 6298 5.5-5.7): acks of re-sent batches give no sample.
		this.retransmitTimeoutMs = Math.min(
			this.retransmitTimeoutMs * 2,
			MAX_DELIVERY_RETRANSMIT_BACKOFF_MS,
		)
		if (trackStall && this.deliveryRewinds >= 3) {
			this.emitter?.emit({
				type: 'sync:delivery-stalled',
				sessionId: this.sessionId,
				watermark: this.lastAckedDeliverySeq,
				outstandingMaxDeliverySequence: this.lastSentDeliverySeq,
				repeatCount: this.deliveryRewinds,
				reason: 'unacknowledged-delivery',
			})
		}
		this.pushDeliveryStream('rewind')
	}

	/** Bytes queued on the transport and not yet written to the network (0 if unknown). */
	private transportBufferedAmount(): number {
		const amount = this.transport.bufferedAmount?.()
		return typeof amount === 'number' && Number.isFinite(amount) ? amount : 0
	}

	/**
	 * Wait until the transport's queued bytes drop to the high-water mark (SRV-5
	 * backpressure), so a slow client never makes the server buffer the whole stream
	 * in socket memory. Resolves early when the session closes.
	 */
	private async waitForSendWindow(): Promise<void> {
		while (
			this.state !== 'closed' &&
			this.transport.isConnected() &&
			this.transportBufferedAmount() > this.deliveryHighWaterBytes
		) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, DELIVERY_DRAIN_POLL_MS)
				;(timer as { unref?: () => void }).unref?.()
			})
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
		this.clearSessionTimers()
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
		if (context && samePrincipal(principal, context)) {
			// Same principal: the grant may still have changed (a role or team change).
			// A session whose resolved scopes differ is ended so the client reconnects and
			// is handed its new scope at handshake (RT-26).
			if (this.scopesChangedFor(context)) {
				this.terminate('SCOPE_CHANGED')
				return 'terminated'
			}
			return 'valid'
		}
		const expired = principal.expiresAt !== undefined && Date.now() >= principal.expiresAt
		this.terminate(expired ? 'AUTH_EXPIRED' : 'AUTH_REVOKED')
		return 'terminated'
	}

	/**
	 * True when `context` (a fresh authentication of this session's principal)
	 * resolves to download or upload scopes other than the ones this session holds.
	 * A grant that no longer resolves at all counts as changed.
	 */
	private scopesChangedFor(context: AuthContext): boolean {
		if (this.state !== 'streaming' && this.state !== 'syncing') return false
		const resolution = this.computeSessionScopes(context, this.handshakeScope)
		if (!resolution.ok) return true
		return (
			!sameScopeMap(resolution.downlink, this.authContext?.downlinkScopes) ||
			!sameScopeMap(resolution.uplink, this.authContext?.uplinkScopes)
		)
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
				: code === 'SCOPE_CHANGED'
					? 'The sync scope granted to this session changed. Reconnect to receive the new scope.'
					: 'The credential for this sync session was revoked. Refresh it and reconnect.'
		this.sendError(code, message, true)
		this.close(
			code === 'AUTH_EXPIRED'
				? 'credential expired'
				: code === 'SCOPE_CHANGED'
					? 'sync scope changed'
					: 'credential revoked',
		)
	}

	/** Clear every timer this session owns (expiry, handshake deadline, heartbeat). */
	private clearSessionTimers(): void {
		this.clearExpiryTimer()
		if (this.handshakeTimer !== null) {
			clearTimeout(this.handshakeTimer)
			this.handshakeTimer = null
		}
		if (this.appHeartbeatTimer !== null) {
			clearInterval(this.appHeartbeatTimer)
			this.appHeartbeatTimer = null
		}
		if (this.retransmitTimer !== null) {
			clearTimeout(this.retransmitTimer)
			this.retransmitTimer = null
		}
	}

	/**
	 * Start the application-level heartbeat for a client that advertised support for it
	 * (LMS #12): a `heartbeat` message whenever nothing else was sent for an interval,
	 * so the client can detect a dead connection it cannot see (browsers never surface
	 * WebSocket pings).
	 */
	private startAppHeartbeat(): void {
		if (this.appHeartbeatIntervalMs <= 0 || this.appHeartbeatTimer !== null) return
		const interval = this.appHeartbeatIntervalMs
		this.appHeartbeatTimer = setInterval(() => {
			if (this.state === 'closed') return
			if (Date.now() - this.lastClientSendAtMs < interval / 2) return
			this.sendToClient({ type: 'heartbeat', messageId: generateUUIDv7() })
		}, interval)
		;(this.appHeartbeatTimer as { unref?: () => void }).unref?.()
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
	 * True when the client did not advertise the `sequenceReservation` capability
	 * (RT-37): a legacy client (Kora <= beta.13) that may give two operations one
	 * sequence number. Such a pair is stored and delivered, never refused with
	 * SEQUENCE_CONFLICT. Meaningful once the handshake was accepted.
	 */
	isLegacySequenceClient(): boolean {
		return !this.sequenceReservation
	}

	/** Legacy duplicate (node, sequence) pairs this session stored (RT-37). */
	getLegacySequencePairCount(): number {
		return this.legacySequencePairs
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
			this.lastClientSendAtMs = Date.now()
			return true
		} catch {
			return false
		}
	}

	private enqueueMessage(message: SyncMessage): void {
		if (message.type === 'handshake' && !this.handshakeReceived) {
			// The deadline covers the handshake's arrival, not its (possibly slow) auth.
			this.handshakeReceived = true
			if (this.handshakeTimer !== null) {
				clearTimeout(this.handshakeTimer)
				this.handshakeTimer = null
			}
		}
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
				if (typeof message.nodeToken === 'string') {
					await this.confirmNodeClaim(message.nodeToken)
				}
				if (message.deliverySequence !== undefined) {
					// Advance the confirmed watermark (a retransmission rewinds to it). It never
					// passes the send cursor: a client cannot acknowledge what was not sent.
					this.noteDeliveryAcked(message.deliverySequence)
				}
				break
			case 'error':
			case 'heartbeat':
				// A client liveness probe needs no answer: receiving it is the point.
				break
			case 'awareness-update':
				this.handleAwarenessUpdate(message)
				break
			case 'yjs-doc-update':
				await this.handleYjsDocUpdate(message)
				break
			case 'blob-chunk-request':
				// Every request costs access checks and possibly a central-store read, so it
				// is rate-limited (RT-17), on its own budget: a large blob is one request per
				// chunk and must not starve (or be starved by) operation sync (RT-24). Over
				// budget the answer is a retriable "throttled", never "not held", so the
				// client backs off and retries instead of failing the transfer.
				if (!this.blobRateLimiter.allow(1)) {
					this.rateLimitedBlobRequests += 1
					this.sendToClient({
						type: 'blob-chunk-response',
						messageId: `blob-resp-${message.requestId}`,
						requestId: message.requestId,
						bytes: null,
						throttled: true,
						retryAfterMs: this.blobRateLimiter.retryAfterMs(),
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
		// Without central persistence a push is still accepted as proof of possession
		// (RT-23): the bytes are verified and the pusher recorded as an owner, then
		// dropped. Without either, there is nothing to do with the bytes.
		if (!this.persistBlobChunk && !this.blobAccess) {
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
		const owner = this.getBlobOwnerKey()
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
		if (this.persistBlobChunk) {
			await this.persistBlobChunk(message.hash, bytes)
		}
		// Pushing the bytes proves possession: the session may reference this hash.
		await this.blobAccess?.recordPush(message.hash, bytes, owner)
	}

	/**
	 * Claim (or re-claim) a node id for an anonymous device (RT-12, RT-21).
	 *
	 * A device presenting a token holds the node when the claim is (or can become)
	 * `kora:anon-node:<hash(token)>`: its confirmed claim, a fresh claim, or its own
	 * provisional claim, which presenting the token confirms.
	 *
	 * A device presenting no token gets a fresh token and a PROVISIONAL claim, which it
	 * confirms by acknowledging the response with the token once saved (or by
	 * presenting it next time). Until then the claim may be re-issued to a device that
	 * again presents no token (the response was lost in transit), but only while no
	 * session is connected as that node and before the claim expires. Legacy claims
	 * (expired provisional ones, and nodes of the pre-release shared anonymous owner)
	 * are re-issued only with `allowLegacyAnonymousClaims`, with a deprecation warning.
	 */
	private async claimAnonymousNode(
		nodeId: string,
		presentedToken: string | null,
	): Promise<AnonymousClaimOutcome> {
		const store = this.store
		if (!store.claimNode) return { ok: false }
		if (presentedToken !== null) {
			const hash = await nodeTokenHash(presentedToken)
			const confirmed = `${ANONYMOUS_NODE_OWNER_PREFIX}${hash}`
			const base = { deviceKey: confirmed, issuedToken: null, pending: null }
			if (await store.claimNode(nodeId, confirmed)) return { ok: true, owner: confirmed, ...base }
			const current = (await store.getNodeClaimOwner?.(nodeId)) ?? null
			const pending = parsePendingOwner(current)
			if (
				current !== null &&
				pending?.tokenHash === hash &&
				(await store.replaceNodeClaim?.(nodeId, current, confirmed)) === true
			) {
				return { ok: true, owner: confirmed, ...base }
			}
			return { ok: false }
		}

		const token = generateNodeToken()
		const hash = await nodeTokenHash(token)
		const confirmedOwner = `${ANONYMOUS_NODE_OWNER_PREFIX}${hash}`
		const owner = pendingOwner(hash, Date.now() + this.anonymousClaimTtlMs)
		const issued = {
			ok: true as const,
			owner,
			deviceKey: confirmedOwner,
			issuedToken: token,
			pending: { owner, token, confirmedOwner },
		}
		if (await store.claimNode(nodeId, owner)) return issued
		if (!store.getNodeClaimOwner || !store.replaceNodeClaim) return { ok: false }
		const current = await store.getNodeClaimOwner(nodeId)
		if (current === null) return { ok: false }
		const pending = parsePendingOwner(current)
		let legacy = false
		if (pending) {
			// Never take a provisional claim away from a device that is connected now.
			if (this.isNodeLive?.(nodeId, this.sessionId) === true) return { ok: false }
			if (pending.expiresAtMs <= Date.now()) {
				if (!this.allowLegacyAnonymousClaims) return { ok: false }
				legacy = true
			}
		} else if (current === ANONYMOUS_NODE_OWNER) {
			if (!this.allowLegacyAnonymousClaims) return { ok: false }
			legacy = true
		} else {
			return { ok: false }
		}
		if (!(await store.replaceNodeClaim(nodeId, current, owner))) return { ok: false }
		if (legacy) {
			this.logger?.log({
				timestamp: Date.now(),
				level: 'warn',
				event: 'session.legacy_anonymous_claim',
				sessionId: this.sessionId,
				nodeId,
				details: {
					message:
						'An anonymous device re-claimed a node id under a legacy claim (no confirmed node token). Upgrade the client; allowLegacyAnonymousClaims will default to false in the next release.',
				},
			})
		}
		return issued
	}

	/**
	 * The device proved it saved the node token issued by this handshake: make the
	 * provisional claim permanent (RT-21). A mismatched token is ignored.
	 */
	private async confirmNodeClaim(token: string): Promise<void> {
		const pending = this.pendingNodeClaim
		if (!pending || token !== pending.token || !this.clientNodeId) return
		this.pendingNodeClaim = null
		await this.store.replaceNodeClaim?.(this.clientNodeId, pending.owner, pending.confirmedOwner)
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
	getBlobOwnerKey(): string {
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
		return this.principal?.anonymous === true ? `${this.getBlobOwnerKey()}|${key}` : key
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
			uplinkScopes: this.uplinkScopes(),
			readRow: async (collection, recordId) =>
				(await this.lookupRecordFields(collection, recordId)) ?? null,
			...(this.blobAccess ? { blobs: this.blobAccess } : {}),
			blobOwner: this.getBlobOwnerKey(),
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
		this.sequenceReservation = msg.sequenceReservation === true
		this.clientProtocolVersion = declaredProtocolVersion(msg.protocolVersion)

		// Node ids in the `kora:` namespace belong to Kora itself (scope-entry
		// operations use `kora:scope-entry`, RT-19); no device may use one.
		if (typeof msg.nodeId !== 'string' || msg.nodeId.startsWith(RESERVED_PRINCIPAL_PREFIX)) {
			this.sendError(
				'INVALID_NODE_ID',
				`Node id "${String(msg.nodeId)}" is in the reserved "${RESERVED_PRINCIPAL_PREFIX}" namespace. Use a generated device node id.`,
				false,
			)
			this.close('reserved node id')
			return
		}
		if (!isStorableIdentifier(msg.nodeId)) {
			this.sendError(
				'INVALID_NODE_ID',
				'The node id holds U+0000 or an unpaired UTF-16 surrogate. Use a generated device node id.',
				false,
			)
			this.close('malformed node id')
			return
		}
		// The server's own node ids, current and legacy (published in the handshake's
		// `authoritativeNodeIds`), are never a device's: a device presenting one would
		// author `merge('server-authoritative')` writes as the server (RT-61).
		if (this.isServerAuthorNodeId(msg.nodeId)) {
			this.sendError(
				'INVALID_NODE_ID',
				`Node id "${msg.nodeId}" is a server node id (an authoritative node of this deployment). Use a generated device node id.`,
				false,
			)
			this.close('server node id')
			return
		}

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
				let claimed: boolean
				if (context.anonymous === true) {
					const presented =
						typeof msg.nodeToken === 'string' &&
						msg.nodeToken.length > 0 &&
						msg.nodeToken.length <= MAX_NODE_TOKEN_LENGTH
							? msg.nodeToken
							: null
					const outcome = await this.claimAnonymousNode(msg.nodeId, presented)
					claimed = outcome.ok
					if (outcome.ok) {
						this.nodeOwnerKey = outcome.deviceKey
						this.issuedNodeToken = outcome.issuedToken
						this.pendingNodeClaim = outcome.pending
					}
				} else {
					this.nodeOwnerKey = context.userId
					claimed = await this.store.claimNode(msg.nodeId, context.userId)
				}
				if (!claimed) {
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

		const resolution = this.computeSessionScopes(this.authContext, msg.syncScope)
		if (!resolution.ok) {
			this.sendError(resolution.code, resolution.message, false)
			this.close(resolution.reason)
			return
		}
		this.handshakeScope = msg.syncScope
		const resolvedDownlinkScopes = resolution.downlink
		const resolvedUplinkScopes = resolution.uplink
		const authenticated = resolution.authenticated
		const downlinkAuthScopes = resolution.downlinkAuthScopes

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
		// earned it. `lastDeliverySequence` belongs to the scope the client REQUESTED.
		// When the server resolves a different scope (server-auth scopes, promotions,
		// invite acceptance), it resumes from the watermark the client reports for the
		// accepted scope it last streamed under, if that scope has the same canonical key
		// as the one resolved now (SYNC-11). Otherwise the resolved view is new to the
		// client (for example a widened grant): a full scoped backfill from 0, never a
		// cursor that may have advanced over operations hidden from its earlier view.
		if (
			this.clientDeliveryWatermark !== null &&
			!sameScopeMap(msg.syncScope, this.authContext?.downlinkScopes)
		) {
			const acceptedWatermark = msg.acceptedScopeWatermark
			const resumable =
				typeof msg.acceptedScopeKey === 'string' &&
				typeof acceptedWatermark === 'number' &&
				Number.isSafeInteger(acceptedWatermark) &&
				acceptedWatermark >= 0 &&
				msg.acceptedScopeKey === scopeViewKey(this.authContext?.downlinkScopes)
			this.clientDeliveryWatermark = resumable ? acceptedWatermark : 0
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

		// Report the format the transport actually frames with, never one the client merely
		// offered (SYNC-9). The serializer is shared by every session on the server, so a
		// per-session switch would flip the wire format of every other session too.
		const selectedWireFormat = framingWireFormat(this.serializer)

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

		// The version vector as committed in the store, shared by every server instance
		// (SRV-4), not this instance's cache.
		const serverVector = await this.readServerVector()
		const clientVector = wireToVersionVector(msg.versionVector)
		// A client that reports a delivery watermark gets the gap-free delivery stream,
		// streamed after the response (SRV-5: never collected whole). An older client gets
		// the version-vector delta, collected before answering. Both hold only in-scope
		// operations.
		const deltaPlan =
			this.clientDeliveryWatermark === null ? await this.collectDeltaOperations(clientVector) : []

		// Only reveal vector entries for the client's own node and the nodes whose in-scope
		// operations it is about to receive. The full vector would leak every device id and
		// write count across tenants, and echoing the nodes the client names in its own
		// vector would make the handshake a write-count oracle for any device id (RT-7).
		// The client merges these entries so the operations it receives are not counted
		// as its own pending uploads. A delivery-stream client's stream is not collected
		// in advance (SRV-5): an unscoped session may see every operation, so it gets the
		// whole vector; a scoped one gets the nodes a metadata pre-pass finds visible.
		// Clients of this release count pending from their own acks (RT-28) and would not
		// need the pre-pass, but beta.13 clients count every node ahead of this vector as
		// pending (and `kora compact` uses the persisted peer entries), so it stays. It
		// starts at the resumed watermark (SYNC-11), so a reconnect scans only new ops.
		const visibleNodes = new Set<string>([msg.nodeId])
		for (const op of deltaPlan) {
			visibleNodes.add(op.nodeId)
		}
		const unscoped = (this.authContext?.downlinkScopes ?? this.authContext?.scopes) === undefined
		if (this.clientDeliveryWatermark !== null) {
			if (unscoped) {
				for (const nodeId of serverVector.keys()) visibleNodes.add(nodeId)
			} else {
				for (const nodeId of await this.collectVisibleNodeIds(this.clientDeliveryWatermark)) {
					visibleNodes.add(nodeId)
				}
			}
		}
		const visibleServerVector = new Map(
			[...serverVector].filter(([nodeId]) => visibleNodes.has(nodeId)),
		)
		// The session's own node is ALWAYS advertised, 0 when the server holds nothing of
		// it (RT-45): a device must learn that the server lost its operations (restored
		// from an older backup) to upload them again. The entry is the highest sequence
		// the server has RESOLVED for the node (stored, validator-ignored, terminally
		// refused, or stored under another number; RT-43), so an operation the server
		// decided without storing is never read as lost and re-submitted at every
		// reconnect. It names only the client's own node, so it discloses nothing (RT-7).
		visibleServerVector.set(
			msg.nodeId,
			Math.max(serverVector.get(msg.nodeId) ?? 0, await this.resolvedThrough(msg.nodeId)),
		)
		const heartbeat = msg.supportsHeartbeat === true && this.appHeartbeatIntervalMs > 0

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
			// Peer-relay mode: ask the client to push the bytes behind a blob reference
			// anyway, so the server can verify possession (and then drop them) before
			// accepting the reference (RT-23).
			...(!this.persistBlobChunk && this.blobAccess && this.referenceScopes() !== undefined
				? { blobPossessionProof: true }
				: {}),
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
			...(heartbeat ? { heartbeatIntervalMs: this.appHeartbeatIntervalMs } : {}),
			protocolVersion: SYNC_PROTOCOL_VERSION,
			authoritativeNodeIds: this.advertisedAuthoritativeNodeIds(),
			...this.advertisedRevocations(),
		}
		this.issuedNodeToken = null
		this.sendToClient(response)

		this.emitter?.emit({ type: 'sync:connected', nodeId: msg.nodeId })
		if (this.clientProtocolVersion < SYNC_PROTOCOL_VERSION) this.warnLegacyProtocol(msg.nodeId)

		// The ingest rate limit follows the node across reconnects (SRV-6): the node id
		// is bound to this principal by now (claimed when auth is configured).
		if (this.rateLimiterFor) {
			const principal =
				this.principal &&
				this.principal.anonymous !== true &&
				!(this.auth instanceof NoAuthProvider)
					? this.principal.userId
					: null
			this.rateLimiter = this.rateLimiterFor(msg.nodeId, principal)
		}

		if (this.clientDeliveryWatermark !== null) {
			// Resuming from a non-zero watermark excludes the client's own operations (it
			// already holds its history); a full resync (watermark 0) includes those
			// committed so far, so it recovers everything.
			const watermark = this.clientDeliveryWatermark
			this.lastAckedDeliverySeq = watermark
			this.lastSentDeliverySeq = watermark
			this.highestSentDeliverySeq = watermark
			this.ownOperationsIncludedThrough = watermark === 0 ? serverMaxDelivery : 0
			this.lastDeliveryProgressAtMs = Date.now()
			this.deliveryRewinds = 0
			// The stream runs on the delivery chain, so this session keeps processing the
			// client's acknowledgments and uploads while it streams (with backpressure).
			this.state = 'streaming'
			this.pushDeliveryStream('initial')
		} else {
			this.state = 'syncing'
			this.sendCollectedDelta(deltaPlan)
			// Transition to streaming after delta is sent
			if (this.state !== 'syncing') return
			this.state = 'streaming'
		}
		this.onReady?.(this.sessionId)
		if (heartbeat) this.startAppHeartbeat()

		// Redeliver any relays buffered while this client's node id was disconnected
		// (dropped just before a prior reconnect). relayOperations re-filters them by
		// this session's current scope and re-tracks them for acknowledgment.
		if (this.takeOrphanedRelays && this.clientNodeId) {
			const buffered = this.takeOrphanedRelays(this.clientNodeId)
			if (buffered.length > 0) {
				this.relayOperations(buffered)
			}
		}
		// A delivery-watermark client needs no explicit drain here: the initial stream
		// scans to the end of the log, and anything committed after its last scan is
		// above the send cursor, where the next relay wake-up or delivery poll sends it.
	}

	/**
	 * The nodes whose operations after `fromDeliverySeq` this scoped session will
	 * receive, for the handshake vector (RT-7). Scans the delivery log without holding
	 * it (memory is O(nodes)), and judges each node only until one of its operations is
	 * visible, so most operations cost one scope comparison and no record read.
	 */
	private async collectVisibleNodeIds(fromDeliverySeq: number): Promise<Set<string>> {
		const visible = new Set<string>()
		// With the candidate list, the scan stops as soon as every candidate is known
		// visible (typically after a few chunks); only nodes that never become visible
		// (other tenants' devices) make it read to the end.
		let pending: Set<string> | null = null
		if (this.store.getNodeIdsAfterDelivery) {
			try {
				pending = new Set(await this.store.getNodeIdsAfterDelivery(fromDeliverySeq))
			} catch {
				pending = null
			}
		}
		const scanChunk = Math.max(this.batchSize, 1) * 20
		let cursor = fromDeliverySeq
		while (this.state !== 'closed' && (pending === null || pending.size > 0)) {
			const chunk = await this.store.getOperationsAfterDelivery(cursor, scanChunk)
			const last = chunk[chunk.length - 1]
			if (last === undefined) break
			for (const delivered of chunk) {
				const op = delivered.operation
				if (visible.has(op.nodeId)) continue
				if (await this.operationVisibleToClient(op, delivered.scopeSnapshot ?? null)) {
					visible.add(op.nodeId)
					pending?.delete(op.nodeId)
				}
			}
			cursor = last.deliverySequence
			if (chunk.length < scanChunk) break
		}
		return visible
	}

	/**
	 * The version vector as committed in the store (SRV-4). A store shared by several
	 * instances reads it fresh; others serve their own (complete) vector.
	 */
	private async readServerVector(): Promise<VersionVector> {
		if (this.store.readVersionVector) {
			try {
				return await this.store.readVersionVector()
			} catch (error) {
				this.logger?.log({
					timestamp: Date.now(),
					level: 'warn',
					event: 'session.version_vector_read_failed',
					sessionId: this.sessionId,
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}
		return this.store.getVersionVector()
	}

	/**
	 * Resolve this session's download and upload scopes from an auth context and the
	 * scope the client asked for at handshake. Side-effect free, so revalidation can
	 * recompute it and compare (RT-26). The legacy `scopes` contract remains shorthand
	 * for both directions.
	 */
	private computeSessionScopes(
		context: AuthContext | null,
		handshakeScope: HandshakeMessage['syncScope'],
	):
		| {
				ok: true
				downlink: ScopeMap | undefined
				uplink: ScopeMap | undefined
				downlinkAuthScopes: ScopeMap | undefined
				authenticated: boolean
		  }
		| { ok: false; code: string; message: string; reason: string } {
		const directionalScopesConfigured =
			context?.downlinkScopes !== undefined || context?.uplinkScopes !== undefined
		const downlinkAuthScopes = directionalScopesConfigured
			? (context?.downlinkScopes ?? context?.scopes ?? {})
			: context?.scopes
		const uplinkAuthScopes = directionalScopesConfigured
			? (context?.uplinkScopes ?? context?.scopes ?? {})
			: context?.scopes
		// A real auth provider that grants nothing for a schema-scoped collection is
		// refused, never handed the scope the client asked for (AUTH-1). A schemaless
		// server has no scoped collections to protect, so it keeps the provider's
		// (absent) grant as "unscoped" and the multi-tenant warning.
		const authenticated =
			this.auth !== null &&
			!(this.auth instanceof NoAuthProvider) &&
			this.store.getSchema() !== null
		let rawDownlink: ReturnType<typeof resolveSessionScopes>
		let rawUplink: ReturnType<typeof resolveSessionScopes>
		try {
			rawDownlink = resolveSessionScopes(this.store.getSchema(), {
				handshakeScope,
				authScopes: downlinkAuthScopes,
				authenticated,
				onUnresolved: 'throw',
			})
			// A directional uplink grant goes through the same resolver as the downlink one
			// (RT-16): verified `$claims` are bound to the schema, an unresolved binding
			// denies the collection (fail closed; the session may still read), and the
			// handshake can only narrow it, exactly as for a non-directional grant.
			rawUplink = directionalScopesConfigured
				? resolveSessionScopes(this.store.getSchema(), {
						handshakeScope,
						authScopes: uplinkAuthScopes,
						authenticated,
						onUnresolved: 'deny',
					})
				: rawDownlink
		} catch (error) {
			if (error instanceof InvalidScopePredicateError) {
				return {
					ok: false,
					code: 'INVALID_SCOPE_PREDICATE',
					message: error.message,
					reason: 'invalid scope predicate',
				}
			}
			if (!(error instanceof ScopeRequiredError)) throw error
			return {
				ok: false,
				code: 'SCOPE_REQUIRED',
				message: error.message,
				reason: 'sync scope required',
			}
		}
		try {
			const downlink = rawDownlink
				? normalizeScopeMap(rawDownlink)
				: directionalScopesConfigured
					? {}
					: undefined
			const uplink = rawUplink
				? normalizeScopeMap(rawUplink)
				: directionalScopesConfigured
					? {}
					: undefined
			return { ok: true, downlink, uplink, downlinkAuthScopes, authenticated }
		} catch (error) {
			return {
				ok: false,
				code:
					error instanceof InvalidScopePredicateError
						? 'INVALID_SCOPE_PREDICATE'
						: 'SCOPE_PREDICATE_LIMIT',
				message: error instanceof Error ? error.message : 'Invalid scope predicate',
				reason: 'invalid scope predicate',
			}
		}
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
		// Per-field versions and fold state are server-authored only (scope-entry
		// operations, RT-27, W7). A device never sends them; one that does would forge
		// field precedence on its peers, so they are dropped before anything else sees
		// the operation.
		const operations = msg.operations.map((s) => {
			const {
				fieldVersions: _forged,
				foldState: _forgedFold,
				...op
			} = this.serializer.decodeOperation(s)
			return op
		})
		const applied: Operation[] = []
		let acknowledgedThrough = 0
		let canAdvanceAck = true
		let uniqueOperations = 0
		let duplicateOperations = 0
		let rejectedOperations = 0
		// Which of the batch's ids the server already holds, read once per batch and
		// before any other per-operation check. A device re-uploading its history (the
		// one-time upgrade re-upload, or an op its sequence repair renumbered under the
		// same id) must get a duplicate ack, never a rejection from today's authorization
		// or validators for an operation the server already accepted (RT-31).
		//
		// Rate limiting (RT-6, RT-39): the lookup is charged once per batch
		// (BATCH_LOOKUP_RATE_COST; the batch size is already capped), and an operation
		// the lookup finds stored costs nothing more: acknowledging it writes nothing and
		// reads nothing else. Every other operation is charged before anything touches
		// the store for it. So a device's upgrade re-upload of thousands of stored
		// operations is not cut off by RATE_LIMIT, while lookups still cost per batch.
		let stored: Map<string, StoredOperationKey> = new Map()
		let resolved: Map<string, OperationResolution> = new Map()
		let lookupCredit = 0
		if (operations.length > 0) {
			if (this.rateLimiter.allow(BATCH_LOOKUP_RATE_COST)) {
				lookupCredit = BATCH_LOOKUP_RATE_COST
				// Identifiers a store cannot hold are refused in the loop, never looked up (RT-65).
				const lookupable = operations.filter((op) => operationIdentifiersStorable(op))
				stored = await this.findStoredOperations(lookupable)
				resolved = await this.findResolutions(lookupable, stored)
			} else {
				this.rateLimitedOperations += operations.length
				this.sendRateLimited()
				canAdvanceAck = false
			}
		}

		// The author's own cascades / set-nulls of a delete in this batch (RT-69): the
		// server does not derive a second copy of an effect the author uploads itself.
		const authoredCopies = this.indexAuthoredSideEffectCopies(operations)
		const deferredEffects: DeferredSideEffect[] = []
		const storedInBatch = new Set<string>()

		for (const op of operations) {
			if (!canAdvanceAck) {
				continue
			}

			// An identifier holding U+0000 or a lone surrogate cannot be stored or looked up
			// (Postgres refuses it). Refused terminally without touching the store, so it
			// never fails the session (RT-65); nothing is recorded under such an id.
			if (!operationIdentifiersStorable(op)) {
				this.sendOperationRejected(
					op,
					INVALID_IDENTIFIER_CODE,
					`Operation "${String(op.id)}" has an identifier holding U+0000 or an unpaired UTF-16 surrogate. Identifiers must be well-formed strings.`,
					false,
				)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Already stored (found by the batch lookup): a duplicate ack, free of charge,
			// but only for the SAME operation (RT-77). The stored copy is loaded and compared
			// on every field its id covers; an upload that reuses a stored id with any other
			// content is refused (non-retriable, logged as tampering) with no effect at all.
			const storedCopy = this.isStoredDuplicate(op, stored)
				? await this.loadStoredOperation(op, stored)
				: null
			if (storedCopy !== null) {
				const schema = this.store.getSchema()
				if (
					!(await isSameOperationAsStored(op, storedCopy, schema)) &&
					!(op.nodeId !== this.clientNodeId && (await isRewrittenEcho(op, storedCopy, schema)))
				) {
					this.refuseForgedDuplicate(op, storedCopy)
					rejectedOperations += 1
					acknowledgedThrough = op.sequenceNumber
					continue
				}
				await this.noteStoredElsewhere(op, stored)
				// A delete sent again (the batch that stored it failed later, or was never
				// acknowledged): any referential effect still undone is derived (or deferred
				// to the author's copies in this batch) now, so an effect deferred in memory
				// by a failed batch is never lost (RT-73). Judged on the STORED delete only.
				if (storedCopy.type === 'delete') {
					applied.push(
						...(await this.resumeStoredDeleteEffects(storedCopy, authoredCopies, deferredEffects)),
					)
				}
				storedInBatch.add(op.id)
				duplicateOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Already resolved for this device without being stored (RT-43, RT-47): the
			// original answer again, free of charge, and never a second judgement. A refused
			// operation stays refused even when the device lost its rejection marker (a
			// restored copy): re-running authorization and validators against today's state
			// could apply a write the server refused. An ignored one is not handed to the
			// validator again (its out-of-band effect must not repeat).
			const resolution = resolved.get(op.id)
			if (resolution) {
				if (resolution.outcome === 'refused') {
					this.sendOperationRejected(
						op,
						resolution.code ?? RESTRICTED_REJECTION_CODE,
						resolution.message ?? 'This operation was refused earlier.',
						false,
					)
					rejectedOperations += 1
				} else {
					duplicateOperations += 1
				}
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Charge the rate limiter before anything that touches the store (RT-6): a
			// refused operation (foreign node, out of scope) still costs a store read, so
			// it must count against the budget like an accepted one. The batch's lookup
			// unit pays for its first such operation, so a batch of N new operations costs
			// N, exactly as before, and a batch of stored duplicates costs one.
			if (lookupCredit > 0) {
				lookupCredit -= 1
			} else if (!this.rateLimiter.allow(1)) {
				this.rateLimitedOperations += 1
				this.sendRateLimited()
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
				if (await this.isStoredOperation(op, stored)) {
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

			// This device's own operation, already stored under its id (content-addressed,
			// so the same write): nothing to judge or write again. It was authorized and
			// validated when first accepted; re-judging it now could refuse a write the
			// server holds and make the device roll it back.
			// The (node, sequence) may differ from the stored one: the client's sequence
			// repair renumbers a legacy duplicate and keeps its id.
			// A custom store without the batch lookup is asked per op by (node, sequence).
			if (
				stored.get(op.id)?.nodeId === op.nodeId ||
				(!this.store.findStoredOperations && (await this.isStoredOperation(op, stored)))
			) {
				await this.noteStoredElsewhere(op, stored)
				storedInBatch.add(op.id)
				duplicateOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			const authorization = await this.authorizeClientOperation(op)
			if (!authorization.allowed) {
				await this.refuseTerminally(
					op,
					authorization.code,
					authorization.code === 'SCOPE_VIOLATION'
						? `${authorization.message} Refresh scopes before creating or explicitly resubmitting an authorized operation.`
						: authorization.message,
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

			// An oversized operation is refused on its own, terminally, and the ack moves
			// past it (RT-86): a session-level error would stop acknowledging the batch, and
			// the device would re-send it every session, so none of its later writes would
			// ever reach the server. The device records the refusal (sync:operation-rejected).
			const sizeCheck = validateOperationSize(op, this.maxOperationBytes)
			if (!sizeCheck.valid) {
				await this.refuseTerminally(
					op,
					OPERATION_TOO_LARGE_CODE,
					`${sizeCheck.message ?? `Operation "${op.id}" is too large.`} Store large content as a blob, or raise maxOperationBytes on the server and the client together.`,
				)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Content-hash verification (CORE-1, protocol v2) runs on the operation exactly
			// as uploaded, BEFORE any schema transform (which rewrites data) and before any
			// validator or store sees it. Only plaintext version-2 ids are verified here: an
			// envelope's id covers the plaintext, which only the clients can check (they do,
			// after decryption), and a version-1 id never covered every field.
			const integrity = await this.checkUploadIntegrity(op)
			if (integrity !== null) {
				if (integrity.code === INVALID_OPERATION_ID) this.invalidOperationIds += 1
				await this.refuseTerminally(op, integrity.code, integrity.message)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Transforms at fold time (RT-84): the operation is stored exactly as uploaded
			// (plus the hash version the server verified, and a beta.13 clear made explicit,
			// both identical under its id), never as a transformed rewrite under its id.
			// Authorization, validators and constraint checks judge its view in the server
			// schema; every store folds that same view.
			const storedOp = this.declareVerifiedHashVersion(op)
			const view = this.schemaView(storedOp)
			if (!view.ok) {
				await this.refuseTerminally(op, view.code, view.message)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}
			const serverOp = view.op

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
					if (retriable) {
						this.sendOperationRejected(serverOp, decision.code, decision.message, true)
					} else {
						await this.refuseTerminally(serverOp, decision.code, decision.message)
					}
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
					// Recorded first, durably: the handshake then counts its sequence as
					// resolved, and a resubmission is acknowledged without being handed to
					// the validator again (RT-43).
					await this.recordResolution(op, 'ignored', null, null)
					acknowledgedThrough = op.sequenceNumber
					continue
				}
				// action === 'accept' falls through to normal materialization.
			}

			// What the write points at (foreign-key parents, blob content) must be inside
			// what this writer may read (RT-11, RT-13).
			const references = await this.authorizeReferences(serverOp)
			if (!references.allowed) {
				await this.refuseTerminally(serverOp, references.code, references.message)
				rejectedOperations += 1
				acknowledgedThrough = op.sequenceNumber
				continue
			}

			// Re-check authorization inside the store's apply critical section against the
			// row as it is at commit time, so a concurrent ownership change or same-id
			// insert cannot slip in between the pre-check above and this write.
			const uplinkScopes = this.uplinkScopes()
			const applyResult = await applyServerOperation(this.store, storedOp, undefined, {
				view: serverOp,
				authorize: (stored) => authorizeUplinkWrite(serverOp, stored, uplinkScopes),
				// Cascades and set-nulls of a delete are judged against the same scope (RT-10).
				authorizeSideEffect: (effect, stored) => authorizeUplinkWrite(effect, stored, uplinkScopes),
				// A client without the sequence-reservation capability may legitimately
				// produce two operations under one sequence: store the pair (RT-37).
				legacySequenceWriter: !this.sequenceReservation,
				onLegacySequencePair: (pair) => this.recordLegacySequencePair(pair),
				isAuthoredSideEffect: (effect) =>
					(authoredCopies.get(serverOp.id) ?? []).some((copy) =>
						isAuthoredCopyOfSideEffect(copy, serverOp.id, effect),
					),
			})
			for (const effect of applyResult.deferredSideEffects ?? []) {
				const copyIds = (authoredCopies.get(serverOp.id) ?? [])
					.filter((copy) => isAuthoredCopyOfSideEffect(copy, serverOp.id, effect))
					.map((copy) => copy.id)
				deferredEffects.push({ parent: storedOp, effect, copyIds })
			}
			if (applyResult.rejection) {
				// A SEQUENCE_CONFLICT is not final: the client renumbers the operation and
				// resubmits it under the same id, so it is never remembered as refused.
				if (
					applyResult.rejection.retriable ||
					applyResult.rejection.code === SEQUENCE_CONFLICT_CODE
				) {
					this.sendOperationRejected(
						serverOp,
						applyResult.rejection.code,
						applyResult.rejection.message,
						applyResult.rejection.retriable,
					)
				} else {
					await this.refuseTerminally(
						serverOp,
						applyResult.rejection.code,
						applyResult.rejection.message,
					)
				}
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
				storedInBatch.add(op.id)
				uniqueOperations += 1
				acknowledgedThrough = op.sequenceNumber
			} else {
				storedInBatch.add(op.id)
				duplicateOperations += 1
				acknowledgedThrough = op.sequenceNumber
			}
		}

		// Derive the server's copy of every deferred effect whose authored copy did not
		// end up stored (refused, rate-limited, or not reached in this batch): the
		// referential effect of an applied delete is never left undone (RT-69).
		applied.push(...(await this.deriveUncoveredSideEffects(deferredEffects, storedInBatch)))

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

	/**
	 * For each delete of this session's node in an upload batch, the batch's later
	 * operations of the same node that name it as a causal parent: candidates for the
	 * author's own copies of its cascades and set-nulls (RT-69). Indexed by the delete's
	 * id, in the server's schema (field names as the server derives effects).
	 */
	private indexAuthoredSideEffectCopies(operations: Operation[]): Map<string, Operation[]> {
		const copies = new Map<string, Operation[]>()
		const deletes = new Set<string>()
		for (const op of operations) {
			if (op.nodeId !== this.clientNodeId) continue
			const parents = op.causalDeps.filter((dep) => deletes.has(dep))
			if (parents.length > 0) {
				const view = this.schemaView(op)
				if (view.ok) {
					for (const parent of parents) {
						copies.set(parent, [...(copies.get(parent) ?? []), view.op])
					}
				}
			}
			if (op.type === 'delete') deletes.add(op.id)
		}
		return copies
	}

	/**
	 * The referential effects of a delete that arrived again as a stored duplicate and
	 * are still undone (RT-73): effects the author covers later in this batch are
	 * deferred like a fresh delete's (derived after the batch unless a copy is stored);
	 * the rest are derived now. Derived ids are deterministic, so a concurrent retry or
	 * another instance stores the same operations.
	 *
	 * @returns The derived operations (to relay)
	 */
	private async resumeStoredDeleteEffects(
		op: Operation,
		authoredCopies: Map<string, Operation[]>,
		deferredEffects: DeferredSideEffect[],
	): Promise<Operation[]> {
		const view = this.schemaView(op)
		if (!view.ok) return []
		const serverDelete = view.op
		const uplinkScopes = this.uplinkScopes()
		const effects = await undoneSideEffectsOfStoredDelete(this.store, serverDelete, (effect, row) =>
			authorizeUplinkWrite(effect, row, uplinkScopes),
		)
		const derive: SideEffectOp[] = []
		for (const effect of effects) {
			const copyIds = (authoredCopies.get(serverDelete.id) ?? [])
				.filter((copy) => isAuthoredCopyOfSideEffect(copy, serverDelete.id, effect))
				.map((copy) => copy.id)
			if (copyIds.length > 0) deferredEffects.push({ parent: serverDelete, effect, copyIds })
			else derive.push(effect)
		}
		return derive.length > 0 ? deriveServerSideEffects(this.store, serverDelete, derive) : []
	}

	/**
	 * Derive the server's copy of each deferred side effect unless one of the author's
	 * copies is stored (applied or already held). A store with the batch lookup is asked
	 * again, so a copy stored by a concurrent session counts too.
	 */
	private async deriveUncoveredSideEffects(
		deferred: DeferredSideEffect[],
		storedInBatch: Set<string>,
	): Promise<Operation[]> {
		if (deferred.length === 0) return []
		const unresolved = [
			...new Set(deferred.flatMap((d) => d.copyIds).filter((id) => !storedInBatch.has(id))),
		]
		const storedElsewhere: Map<string, unknown> =
			unresolved.length > 0 ? await this.findStoredOperationIds(unresolved) : new Map()
		const derived: Operation[] = []
		for (const { parent, effect, copyIds } of deferred) {
			if (copyIds.some((id) => storedInBatch.has(id) || storedElsewhere.has(id))) continue
			derived.push(...(await deriveServerSideEffects(this.store, parent, [effect])))
		}
		return derived
	}

	/** {@link ServerStore.findStoredOperations} by id; empty without it or on a failed read. */
	private async findStoredOperationIds(ids: string[]): Promise<Map<string, unknown>> {
		if (!this.store.findStoredOperations) return new Map()
		try {
			return await this.store.findStoredOperations(ids)
		} catch (error) {
			console.warn(
				`[kora] findStoredOperations failed; deriving the server's side effects: ${error instanceof Error ? error.message : String(error)}`,
			)
			return new Map()
		}
	}

	/**
	 * The operation as the server schema reads it (transforms at fold time, RT-84): the
	 * view authorization, validators, constraint checks and scope filters judge, and the
	 * one the server stores fold (core `operationSchemaView`, same transforms). Never
	 * stored: the store keeps the operation as uploaded. An envelope operation is opaque
	 * to the server (NEW-ENC-1) and judged as is; devices transform after decryption.
	 */
	private schemaView(
		op: Operation,
	): { ok: true; op: Operation } | { ok: false; code: string; message: string } {
		let view: Operation | null
		try {
			view = operationSchemaView(op, this.schemaVersion, this.operationTransforms)
		} catch (error) {
			return {
				ok: false,
				code: SCHEMA_TRANSFORM_INVALID_CODE,
				message: `Operation "${op.id}" cannot be read in server schema v${this.schemaVersion}: ${error instanceof Error ? error.message : String(error)}`,
			}
		}
		if (view === null) {
			return {
				ok: false,
				code: 'SCHEMA_TRANSFORM_UNAVAILABLE',
				message: `Operation "${op.id}" cannot be transformed from schema v${op.schemaVersion} to server schema v${this.schemaVersion}.`,
			}
		}
		return { ok: true, op: view }
	}

	/**
	 * Integrity checks on an uploaded operation before anything else judges it:
	 * - a version-2 plaintext id must be the content hash (`INVALID_OPERATION_ID`);
	 * - an unknown declared hash version is refused the same way;
	 * - with required encryption, a data-bearing plaintext operation is refused
	 *   (`PLAINTEXT_REJECTED`) unless the plaintext migration window is open.
	 *
	 * @returns null when the operation passes, or the refusal
	 */
	private async checkUploadIntegrity(
		op: Operation,
	): Promise<{ code: string; message: string } | null> {
		// Defense in depth: the handshake already refused a server node id (RT-61).
		if (this.isServerAuthorNodeId(op.nodeId)) {
			return {
				code: 'INVALID_NODE_ID',
				message: `Operation "${op.id}" is authored by "${op.nodeId}", a server node id. A device may never upload operations under one.`,
			}
		}
		const declared = op.hashVersion
		if (declared !== undefined && declared !== 1 && declared !== 2) {
			return {
				code: INVALID_OPERATION_ID,
				message: `Operation "${op.id}" declares unknown content-hash version ${String(declared)}. Upgrade the server or the client so both speak the same protocol version.`,
			}
		}
		if (op.encrypted === undefined) {
			if (
				this.encryptionPolicy.required &&
				!this.encryptionPolicy.allowPlaintextMigration &&
				(op.data !== null || op.previousData !== null)
			) {
				return {
					code: PLAINTEXT_REJECTED,
					message: `Operation "${op.id}" is plaintext but this server requires end-to-end encryption. Enable sync encryption on the client, or open a plaintext migration window (encryption.allowPlaintextMigration) on the server.`,
				}
			}
			// A protocol-1 encrypted payload: its id covers the plaintext, which the server
			// never sees, so it cannot be checked here (the receivers refuse the format).
			if (
				SyncEncryptor.isEncryptedPayload(op.data) ||
				SyncEncryptor.isEncryptedPayload(op.previousData)
			) {
				return null
			}
			// Every plaintext id is verified, version 1 included (RT-64): an operation that
			// declares no version must carry its version-1 (or version-2) content hash, so
			// omitting `hashVersion` skips nothing and no client stores an op under a chosen id.
			const integrity = await verifyInboundOperation(op, {
				encrypted: false,
				absentVersion: 'verify-ids',
				schema: this.store.getSchema(),
			})
			if (
				integrity.ok &&
				integrity.matchedVersion !== undefined &&
				integrity.declarable !== false
			) {
				this.matchedHashVersions.set(op, integrity.matchedVersion)
			}
			if (integrity.ok && integrity.restoredData !== undefined) {
				this.restoredLegacyData.set(op, integrity.restoredData)
			}
			// Every replica folds a version-1 update in its canonical body: a previousData key
			// absent from data is a clear (core canonicalizeLegacyOperation). beta.13 only
			// ever produced that shape from `undefined` members, whose id covers the clear;
			// an id that verifies WITHOUT the clear names a body no beta.13 wrote, and storing
			// it would let authorization judge one body while every fold applies another.
			if (
				integrity.ok &&
				declared === undefined &&
				integrity.restoredData === undefined &&
				canonicalizeLegacyOperation(op) !== op
			) {
				return {
					code: INVALID_OPERATION_ID,
					message: `Operation "${op.id}" is a version-1 update whose previousData names fields its data lacks, but its id does not cover clearing them. No Kora client writes this shape; it is refused and never stored or relayed.`,
				}
			}
			if (!integrity.ok && declared === undefined && this.acceptsUnverifiedLegacyId(op)) {
				// RT-71: a beta.13 (protocol 1) client hashed `undefined` members as `null`;
				// the JSON it uploaded no longer holds them, so the id cannot always be
				// rebuilt. The operation is stored unverified (no declared version), as every
				// beta.13 operation was before RT-64. This skips no protection RT-64 needs:
				// the ids the server derives are keyed (HMAC), so no client can predict and
				// pre-store one, and a protocol-2 session never reaches this branch.
				this.reportUnverifiedLegacyOperation(op)
				const restored = restoreUndefinedFromPrevious(op)
				if (restored !== op.data) this.restoredLegacyData.set(op, restored)
				return null
			}
			if (!integrity.ok) {
				return {
					code: INVALID_OPERATION_ID,
					message:
						declared === 2
							? `Operation "${op.id}" does not match its content hash (hash version 2): its id, data, previousData, sequenceNumber, causalDeps or schemaVersion was altered after it was created. It is refused and never stored or relayed.`
							: `Operation "${op.id}" does not match its content hash (hash version 1: type, collection, recordId, data, timestamp, nodeId, atomicOps): its id was not computed from its content, or the content was altered. It is refused and never stored or relayed.`,
				}
			}
		}
		return null
	}

	/**
	 * Whether an undeclared version-1 id that does not verify is accepted unverified
	 * (RT-71): only from a protocol-1 session (Kora <= beta.13), and only for the
	 * session's own node.
	 */
	private acceptsUnverifiedLegacyId(op: Operation): boolean {
		return this.clientProtocolVersion < SYNC_PROTOCOL_VERSION && op.nodeId === this.clientNodeId
	}

	/** Log, count and emit an operation accepted with an unverified legacy id (RT-71). */
	private reportUnverifiedLegacyOperation(op: Operation): void {
		this.unverifiedLegacyOperations++
		const message = `Operation "${op.id}" from protocol-1 node "${op.nodeId}" does not match its version-1 content hash (Kora <= beta.13 hashed undefined members as null, and the JSON upload no longer holds them). It is stored unverified. Upgrade the client.`
		this.logger?.log({
			timestamp: Date.now(),
			level: 'warn',
			event: 'session.unverified_legacy_operation',
			sessionId: this.sessionId,
			nodeId: op.nodeId,
			details: { operationId: op.id, collection: op.collection, type: op.type, message },
		})
		this.emitter?.emit({
			type: 'sync:unverified-legacy-operation',
			nodeId: op.nodeId,
			operationId: op.id,
			collection: op.collection,
			message,
		})
	}

	/** Operations this session accepted with an unverified legacy id (RT-71). */
	getUnverifiedLegacyOperationCount(): number {
		return this.unverifiedLegacyOperations
	}

	/**
	 * The operation as the server stores it: an undeclared plaintext id this server
	 * verified declares the version it matched (1, or 2 when the declaration was lost),
	 * so receivers verify it too (RT-64). An absent version is left only on ids nobody
	 * could verify (protocol-1 encrypted payloads, server-side transforms).
	 */
	private declareVerifiedHashVersion(op: Operation): Operation {
		if (op.hashVersion !== undefined) return op
		const matched = this.matchedHashVersions.get(op)
		// A beta.13 update that cleared fields with `undefined` is stored with those fields
		// `null` (RT-71): what the writer applied, and the same version-1 hash.
		const restored = this.restoredLegacyData.get(op)
		const content = restored === undefined ? op : { ...op, data: restored }
		return matched === undefined ? content : { ...content, hashVersion: matched }
	}

	/**
	 * True for a node id that is (or was) the server's own: the `kora:` namespace, the
	 * store's node id, and every id the server advertises or folds as authoritative
	 * (other instances, legacy server node ids, configured extras). No device may use one
	 * (RT-61), whether or not it has history yet.
	 */
	private isServerAuthorNodeId(nodeId: string): boolean {
		if (nodeId.startsWith(RESERVED_PRINCIPAL_PREFIX)) return true
		if (nodeId === this.store.getNodeId()) return true
		if (this.serverAuthoritativeNodeIds().includes(nodeId)) return true
		// Every id the deployment ever held authoritative, revoked ones included (RT-81):
		// devices may still hold it as authoritative (until they learn the revocation).
		if (this.store.getEverAuthoritativeNodeIds?.().includes(nodeId)) return true
		return this.store.getAuthoritativeNodeIds?.().includes(nodeId) ?? false
	}

	/**
	 * The authoritative ids a handshake advertises (RT-75): only explicit ones (legacy
	 * server node ids, configured extras). Every `kora:server:` id is authoritative by
	 * prefix on every replica, and listing instance ids would make the list differ per
	 * instance and per start, which devices would have to treat as news.
	 */
	/** The handshake's explicit revocations (RT-81), when the deployment has any. */
	private advertisedRevocations(): { revokedAuthoritativeNodeIds?: string[] } {
		const revoked = (this.store.getRevokedAuthoritativeNodeIds?.() ?? []).filter(
			(id) => !isServerNodeId(id),
		)
		return revoked.length > 0 ? { revokedAuthoritativeNodeIds: revoked } : {}
	}

	private advertisedAuthoritativeNodeIds(): string[] {
		return [...new Set(this.serverAuthoritativeNodeIds())].filter((id) => !isServerNodeId(id))
	}

	/** Node ids this server authors operations under (protocol v2 handshake response). */
	private serverAuthoritativeNodeIds(): string[] {
		if (this.authoritativeNodeIds !== null) return [...this.authoritativeNodeIds]
		// Exactly the ids the server stores fold with (seam 3): a client that folded with
		// a different set would resolve `merge('server-authoritative')` differently.
		return this.store.getAuthoritativeNodeIds?.() ?? [this.store.getNodeId()]
	}

	/**
	 * A protocol-1 client (Kora <= beta.13) is served for one release (beta.14) with a
	 * deprecation warning: its operation ids are version-1 hashes and its encrypted
	 * payloads have no envelope binding.
	 */
	private warnLegacyProtocol(nodeId: string): void {
		const message = `Client node "${nodeId}" speaks sync protocol ${String(this.clientProtocolVersion)}; this server speaks ${String(SYNC_PROTOCOL_VERSION)}. Protocol 1 clients (Kora <= beta.13) are accepted in beta.14 only and will be refused by the next release. Upgrade the client.`
		this.logger?.log({
			timestamp: Date.now(),
			level: 'warn',
			event: 'session.protocol_deprecated',
			sessionId: this.sessionId,
			nodeId,
			details: {
				code: PROTOCOL_V1_DEPRECATED,
				clientProtocolVersion: this.clientProtocolVersion,
				serverProtocolVersion: SYNC_PROTOCOL_VERSION,
				message,
			},
		})
		this.emitter?.emit({
			type: 'sync:protocol-deprecated',
			nodeId,
			clientProtocolVersion: this.clientProtocolVersion,
			serverProtocolVersion: SYNC_PROTOCOL_VERSION,
			message,
		})
	}

	/** The in-scope operations a version-vector client is missing (not yet sent). */
	private async collectDeltaOperations(clientVector: Map<string, number>): Promise<Operation[]> {
		const serverVector = await this.readServerVector()
		const missing: Operation[] = []

		for (const [nodeId, serverSeq] of serverVector) {
			const clientSeq = clientVector.get(nodeId) ?? 0
			// A legacy pair (two operations under one (node, sequence), RT-37) at or below
			// the client's entry: the client may hold only one of them, and the range read
			// below starts above its entry, so both are sent again (RT-48). The client
			// dedups by id; pairs are few (legacy writers only), so the resend is small.
			const pairs =
				clientSeq > 0 && this.store.getSequencePairOperations
					? await this.store.getSequencePairOperations(nodeId, Math.min(clientSeq, serverSeq))
					: []
			if (serverSeq > clientSeq || pairs.length > 0) {
				const range =
					serverSeq > clientSeq
						? await this.store.getOperationRange(nodeId, clientSeq + 1, serverSeq)
						: []
				const ops = [...pairs, ...range]
				const snapshots = await this.scopeSnapshotsFor(ops)
				for (const op of ops) {
					const snapshot = snapshots.get(op.id) ?? null
					if (await this.operationVisibleToClient(op, snapshot)) {
						const entry = await this.scopeEntryFor(op, snapshot)
						if (entry) missing.push(entry)
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
	 * Stream the gap-free server->client delivery stream, resuming just after
	 * `fromDeliverySeq`. Operations are scanned in server delivery-sequence order
	 * (commit order), scope-filtered for this session, and sent in batches that chain:
	 * each batch's `baseDeliverySequence` equals the previous batch's
	 * `maxDeliverySequence` (the first batch bases on `fromDeliverySeq`). The client
	 * applies a batch only when its watermark equals the base and advances the
	 * watermark to the max, so a dropped batch stalls the watermark and is recovered by
	 * a re-send from the acknowledged position. Because delivery-sequence order respects
	 * causal order (a dependency is always committed, and thus sequenced, before its
	 * dependent), no topological sort is needed.
	 *
	 * Batches go out as each scan chunk is filtered (SRV-5): the server holds at most
	 * one scan chunk plus two batches per stream, never the whole backlog, and the
	 * first batch reaches the client after one chunk. One full batch is held back so
	 * the stream's last batch can be marked `isFinal` (one-batch lookahead). The final
	 * batch carries the highest sequence scanned, not merely the last in-scope one, so
	 * an out-of-scope tail is not re-scanned. Every sent batch advances the send cursor
	 * ({@link lastSentDeliverySeq}). Between batches the stream waits for the client to
	 * drain its socket (backpressure).
	 *
	 * @param fromDeliverySeq - The chain base: the client's watermark or the send cursor
	 * @param finalizeWhenEmpty - Send an empty final batch even when nothing new was
	 *   scanned (the handshake stream, so the client completes initial sync)
	 */
	private async streamDelivery(
		fromDeliverySeq: number,
		finalizeWhenEmpty: boolean,
	): Promise<{ sentOperations: number; maxScanned: number }> {
		const batchSize = Math.max(this.batchSize, 1)
		const scanChunk = batchSize * 5
		let scanCursor = fromDeliverySeq
		let maxScanned = fromDeliverySeq
		let base = fromDeliverySeq
		let batchIndex = 0
		let sentOperations = 0
		let pending: DeliverableOperation[] = []
		let held: DeliverableOperation[] | null = null

		const live = (): boolean => this.state !== 'closed' && this.transport.isConnected()
		const send = async (slice: DeliverableOperation[], isFinal: boolean): Promise<void> => {
			const last = slice[slice.length - 1]
			const lastSeq = last ? last.deliverySequence : base
			// The final batch carries the max scanned sequence (>= lastSeq) so the client
			// skips past any out-of-scope operations above the last in-scope one.
			const max = isFinal ? Math.max(maxScanned, lastSeq) : lastSeq
			this.sendDeliveryBatch(slice, base, max, batchIndex, isFinal)
			batchIndex += 1
			base = max
			sentOperations += slice.filter((item) => !item.retraction).length
			this.recordDeliverySent(max)
			await this.waitForSendWindow()
		}

		while (live()) {
			const chunk = await this.store.getOperationsAfterDelivery(scanCursor, scanChunk)
			const last = chunk[chunk.length - 1]
			if (last === undefined) break
			const deliverable = await this.filterDeliveryChunk(chunk)
			pending.push(...deliverable)
			// Cut full batches. A batch never ends on a scope entry: the entry and the
			// operation that triggered it share one delivery sequence, and a batch max of
			// that sequence would claim the trigger was delivered too. (The trigger always
			// follows its entry in the same chunk, so the extension stays in `pending`.)
			while (pending.length >= batchSize && live()) {
				let end = batchSize
				while (end < pending.length && pending[end - 1]?.scopeEntry === true) end += 1
				if (pending[end - 1]?.scopeEntry === true) break
				const slice = pending.slice(0, end)
				pending = pending.slice(end)
				if (held) await send(held, false)
				held = slice
			}
			scanCursor = last.deliverySequence
			// maxScanned counts every operation scanned, including excluded (own or
			// out-of-scope) ones, so the final max advances the watermark past them.
			maxScanned = scanCursor
			if (chunk.length < scanChunk) break
		}
		if (!live()) return { sentOperations, maxScanned }

		if (held && pending.length > 0) {
			await send(held, false)
			await send(pending, true)
		} else if (held) {
			await send(held, true)
		} else if (pending.length > 0) {
			await send(pending, true)
		} else if (finalizeWhenEmpty || maxScanned > fromDeliverySeq) {
			// Nothing in scope after the cursor. On a handshake, a single empty final batch
			// lets the client advance past an out-of-scope tail and complete initial sync;
			// during streaming it advances the watermark past newly scanned out-of-scope
			// operations. With nothing scanned at all, a live push sends nothing.
			await send([], true)
		}
		return { sentOperations, maxScanned }
	}

	/**
	 * Filter one scan chunk of the delivery log down to what this session receives:
	 * visible operations (each preceded by its scope-entry insert, RT-19) and
	 * retractions. The records the decisions need are fetched for the whole chunk at
	 * once (LMS #11), one batched read per collection instead of one query per op.
	 */
	private async filterDeliveryChunk(chunk: DeliveredOperation[]): Promise<DeliverableOperation[]> {
		const deliverable: DeliverableOperation[] = []
		const clientNodeId = this.clientNodeId
		const candidates = chunk.filter(
			(delivered) =>
				// The client's own operations are skipped above the inclusion point: it
				// uploaded them itself. A full resync still recovers its own history.
				!(
					clientNodeId !== null &&
					delivered.operation.nodeId === clientNodeId &&
					delivered.deliverySequence > this.ownOperationsIncludedThrough
				),
		)
		this.recordLookupCache = await this.prefetchRecordsFor(candidates)
		try {
			for (const delivered of candidates) {
				const snapshot = delivered.scopeSnapshot ?? null
				if (await this.operationVisibleToClient(delivered.operation, snapshot)) {
					// The scope-entry shares the trigger's delivery sequence and precedes it,
					// so a resend from any watermark regenerates it (same id) with its trigger.
					const entry = await this.scopeEntryFor(delivered.operation, snapshot)
					if (entry) {
						deliverable.push({
							operation: entry,
							deliverySequence: delivered.deliverySequence,
							scopeEntry: true,
						})
					}
					deliverable.push(delivered)
				} else if (await this.scopeRetractionFor(delivered.operation, snapshot)) {
					deliverable.push({ ...delivered, retraction: true })
				}
			}
		} finally {
			this.recordLookupCache = null
		}
		return deliverable
	}

	/**
	 * Read, in one batched query per collection, every record the visibility decisions
	 * for these operations may look up, when the store supports batched reads. Returns
	 * null (per-operation lookups) otherwise. Over-fetching is harmless: the chunk
	 * bounds it.
	 */
	private async prefetchRecordsFor(
		delivered: DeliveredOperation[],
	): Promise<Map<string, MaterializedRecord | null> | null> {
		const store = this.store
		if (!store.findRecordsByIds || delivered.length === 0) return null
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		const subsets = this.syncQuerySubsets.length > 0
		const idsByCollection = new Map<string, Set<string>>()
		for (const { operation: op, scopeSnapshot } of delivered) {
			const snapshot = scopeSnapshot ?? null
			const needsRecord =
				subsets ||
				(snapshot?.post
					? snapshotLacksScopeFields(op.collection, { pre: null, post: snapshot.post }, scopes)
					: missingScopeFields(op, scopes).length > 0) ||
				(snapshot !== null &&
					scopes !== undefined &&
					(snapshotLacksScopeFields(op.collection, snapshot, scopes) ||
						(op.type === 'update' && snapshotEntersScopes(op, snapshot, scopes))))
			if (!needsRecord) continue
			let ids = idsByCollection.get(op.collection)
			if (!ids) {
				ids = new Set()
				idsByCollection.set(op.collection, ids)
			}
			ids.add(op.recordId)
		}
		if (idsByCollection.size === 0) return null
		const cache = new Map<string, MaterializedRecord | null>()
		try {
			for (const [collection, ids] of idsByCollection) {
				const rows = await store.findRecordsByIds(collection, [...ids])
				for (const id of ids) cache.set(recordCacheKey(collection, id), rows.get(id) ?? null)
			}
		} catch {
			// A failed batched read falls back to per-operation lookups.
			return null
		}
		return cache
	}

	/** Build, track, and send one chained delivery-stream batch. */
	private sendDeliveryBatch(
		slice: DeliverableOperation[],
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
		stored: Operation,
		snapshot: OperationScopeSnapshot | null = null,
	): Promise<boolean> {
		// Judged on the operation as the server schema reads it (RT-84): a stored
		// operation of an older schema version names its fields as its author did.
		const judged = this.schemaView(stored)
		const op = judged.ok ? judged.op : stored
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		const subsets = this.syncQuerySubsets
		if (snapshot?.post) {
			// A snapshot captured before a scope field existed lacks it: judge that field
			// on the current row instead of as "no value" (RT-20).
			let current: MaterializedRecord | undefined
			let post: Record<string, unknown> | null = snapshot.post
			if (snapshotLacksScopeFields(op.collection, { pre: null, post }, scopes)) {
				current = await this.lookupRecordFields(op.collection, op.recordId)
				post = snapshotValuesWithFallback(op.collection, post, scopes, current)
			}
			if (!post || !recordMatchesScopes(op.collection, { ...post, id: op.recordId }, scopes)) {
				return false
			}
			if (subsets.length === 0) return true
			current ??= await this.lookupRecordFields(op.collection, op.recordId)
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

	/**
	 * Where the store already holds each of `operations` (by id), in one store read.
	 * Null when the store cannot answer by id (a custom store without
	 * `findStoredOperations`, or the read failed): callers then fall back to a
	 * per-operation (node, sequence) lookup and the store's own dedup at apply.
	 */
	private async findStoredOperations(
		operations: Operation[],
	): Promise<Map<string, StoredOperationKey>> {
		if (!this.store.findStoredOperations) return new Map()
		try {
			return await this.store.findStoredOperations(operations.map((op) => op.id))
		} catch (error) {
			console.warn(
				`[kora] findStoredOperations failed; judging the batch without it: ${error instanceof Error ? error.message : String(error)}`,
			)
			return new Map()
		}
	}

	/**
	 * True when the batch lookup alone shows `op` is already stored and may be
	 * acknowledged as a duplicate with no further store work (RT-31, RT-39): this
	 * device's own operation stored under its node (its sequence repair may have
	 * renumbered it, keeping the id), or any other operation stored under exactly its
	 * (node, sequence, id), such as one the server itself delivered and the client
	 * echoed back. Never true for a store without the batch lookup.
	 */
	private isStoredDuplicate(op: Operation, batch: Map<string, StoredOperationKey>): boolean {
		const known = batch.get(op.id)
		if (!known || known.nodeId !== op.nodeId) return false
		const own = op.nodeId === this.clientNodeId && op.timestamp.nodeId === op.nodeId
		return own || known.sequenceNumber === op.sequenceNumber
	}

	/**
	 * The operation the store holds under `op`'s id (at the node and sequence the batch
	 * lookup found), or null when it cannot be read (the upload is then judged like any
	 * other: verified, validated, charged, and deduplicated by the store at apply).
	 */
	private async loadStoredOperation(
		op: Operation,
		batch: Map<string, StoredOperationKey>,
	): Promise<Operation | null> {
		const known = batch.get(op.id)
		if (!known) return null
		try {
			const range = await this.store.getOperationRange(
				known.nodeId,
				known.sequenceNumber,
				known.sequenceNumber,
			)
			return range.find((candidate) => candidate.id === op.id) ?? null
		} catch (error) {
			console.warn(
				`[kora] could not load stored operation ${op.id}; judging the upload as new: ${error instanceof Error ? error.message : String(error)}`,
			)
			return null
		}
	}

	/**
	 * Refuse an upload that reuses a stored operation's id with different content (RT-77):
	 * terminal, nothing recorded or derived, logged and emitted as tampering. An honest
	 * client never does this (ids are content hashes), so the rejection only reaches a
	 * forger. No resolution is recorded: the id belongs to the stored operation.
	 */
	private refuseForgedDuplicate(op: Operation, storedCopy: Operation): void {
		this.forgedDuplicates += 1
		const message = `Operation "${op.id}" reuses the id of an operation the server stores, with different content (${storedCopy.type} ${storedCopy.collection}/${storedCopy.recordId} is stored; ${op.type} ${op.collection}/${op.recordId} was sent). Operation ids are content hashes, so this upload was altered. It is refused and has no effect.`
		this.logger?.log({
			timestamp: Date.now(),
			level: 'warn',
			event: 'session.forged_duplicate',
			sessionId: this.sessionId,
			nodeId: this.clientNodeId ?? undefined,
			details: {
				operationId: op.id,
				uploadedNodeId: op.nodeId,
				uploaded: { type: op.type, collection: op.collection, recordId: op.recordId },
				stored: {
					type: storedCopy.type,
					collection: storedCopy.collection,
					recordId: storedCopy.recordId,
				},
			},
		})
		this.emitter?.emit({
			type: 'sync:forged-duplicate',
			nodeId: op.nodeId,
			operationId: op.id,
			collection: op.collection,
			message,
		})
		this.sendOperationRejected(op, FORGED_DUPLICATE_CODE, message, false)
	}

	/** Uploads refused for reusing a stored id with other content (RT-77). */
	getForgedDuplicateCount(): number {
		return this.forgedDuplicates
	}

	/**
	 * The recorded resolutions of the batch's own-node operations that the lookup did
	 * not find stored (RT-43, RT-47). Asked only for this session's own node, so the
	 * answer never reveals another device's (or tenant's) refusals.
	 */
	private async findResolutions(
		operations: Operation[],
		stored: Map<string, StoredOperationKey>,
	): Promise<Map<string, OperationResolution>> {
		const nodeId = this.clientNodeId
		if (!this.store.findOperationResolutions || nodeId === null) return new Map()
		const ids = operations
			.filter((op) => op.nodeId === nodeId && op.timestamp.nodeId === nodeId && !stored.has(op.id))
			.map((op) => op.id)
		if (ids.length === 0) return new Map()
		let found: Map<string, OperationResolution>
		try {
			found = await this.store.findOperationResolutions(nodeId, ids)
		} catch (error) {
			console.warn(
				`[kora] findOperationResolutions failed; judging the batch without it: ${error instanceof Error ? error.message : String(error)}`,
			)
			return new Map()
		}
		// Only ids the lookup did NOT find stored are asked for, so a `stored-elsewhere`
		// hit here is stale: it claims a stored copy the lookup has just disproved (the
		// copy was lost by a restore, RT-51). Acking on it would drop the operation, so it
		// is forgotten and the operation is judged normally (its real outcome is then
		// recorded in its place).
		for (const [id, resolution] of found) {
			if (resolution.outcome !== 'stored-elsewhere') continue
			found.delete(id)
			await this.store.deleteOperationResolution?.(nodeId, id)
		}
		return found
	}

	/** The highest resolved sequence of `nodeId` (0 without the store method or on error). */
	private async resolvedThrough(nodeId: string): Promise<number> {
		if (!this.store.getResolvedThrough) return 0
		try {
			return await this.store.getResolvedThrough(nodeId)
		} catch (error) {
			console.warn(
				`[kora] getResolvedThrough failed; advertising the stored maximum: ${error instanceof Error ? error.message : String(error)}`,
			)
			return 0
		}
	}

	/**
	 * Durably record how this session's own operation was resolved without being stored
	 * under its sequence. Awaited before the answer is sent: a failure propagates (the
	 * batch fails and is not acknowledged), so the client never acts on a resolution the
	 * server could forget.
	 */
	private async recordResolution(
		op: Operation,
		outcome: OperationResolutionOutcome,
		code: string | null,
		message: string | null,
	): Promise<void> {
		if (!this.store.recordOperationResolution || op.nodeId !== this.clientNodeId) return
		await this.store.recordOperationResolution({
			operationId: op.id,
			nodeId: op.nodeId,
			sequenceNumber: op.sequenceNumber,
			outcome,
			code,
			message,
		})
	}

	/**
	 * Refuse an operation for good (non-retriable): remember the refusal (RT-47), then
	 * tell the client. A resubmission of the same id is answered with this rejection
	 * without being judged again.
	 */
	private async refuseTerminally(op: Operation, code: string, message: string): Promise<void> {
		await this.recordResolution(op, 'refused', code, message)
		this.sendOperationRejected(op, code, message, false)
	}

	/**
	 * An own operation acknowledged as a duplicate of the copy stored under ANOTHER
	 * sequence (the client's sequence repair renumbered it, keeping its id): record the
	 * submitted sequence as resolved, so the handshake does not read it as lost (RT-43).
	 */
	private async noteStoredElsewhere(
		op: Operation,
		stored: Map<string, StoredOperationKey>,
	): Promise<void> {
		const known = stored.get(op.id)
		if (
			!known ||
			known.nodeId !== op.nodeId ||
			known.sequenceNumber === op.sequenceNumber ||
			op.nodeId !== this.clientNodeId
		) {
			return
		}
		await this.recordResolution(op, 'stored-elsewhere', null, null)
	}

	/** Refuse the rest of a batch for the per-minute ingest budget (retriable). */
	private sendRateLimited(): void {
		this.sendError(
			'RATE_LIMIT',
			`Session exceeded operation rate limit (${String(this.rateLimiter.limit)} ops/min for this device; a signed-in user's devices also share a per-user budget); retry in ${String(this.rateLimiter.retryAfterMs())} ms`,
			true,
		)
	}

	/**
	 * True when the store already holds exactly this operation (same node, sequence and
	 * id). Answered from the batch lookup when the store supports it.
	 */
	private async isStoredOperation(
		op: Operation,
		batch: Map<string, StoredOperationKey>,
	): Promise<boolean> {
		const known = batch.get(op.id)
		if (known) return known.nodeId === op.nodeId && known.sequenceNumber === op.sequenceNumber
		if (this.store.findStoredOperations) return false
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
		const current = snapshotLacksScopeFields(op.collection, snapshot, scopes)
			? await this.lookupRecordFields(op.collection, op.recordId)
			: undefined
		return snapshotExitsScopes(op, snapshot, scopes, current)
	}

	/**
	 * The scope-entry operation to send before `op` when `op` moved an existing record
	 * into this session's download scope (RT-19), or null. Judged on the store's own
	 * pre/post snapshot; built from the record's CURRENT row, and only while that row
	 * is live and still inside the scope (a record that has since left again, or was
	 * deleted, gets no entry: its later operations retract or delete it anyway).
	 * Operations without a snapshot (legacy rows, custom stores) never produce one.
	 */
	private async scopeEntryFor(
		op: Operation,
		snapshot: OperationScopeSnapshot | null,
	): Promise<Operation | null> {
		const scopes = this.authContext?.downlinkScopes ?? this.authContext?.scopes
		const schema = this.store.getSchema()
		if (!scopes || !snapshot || !schema || op.type !== 'update') return null
		// Cheap pre-check on the snapshot alone; the row is read only for a candidate.
		if (
			!snapshotLacksScopeFields(op.collection, snapshot, scopes) &&
			!snapshotEntersScopes(op, snapshot, scopes)
		) {
			return null
		}
		const current = await this.lookupRecordFields(op.collection, op.recordId)
		if (!current || current._deleted === 1 || current._deleted === true) return null
		if (!snapshotEntersScopes(op, snapshot, scopes, current)) return null
		if (!recordMatchesScopes(op.collection, { ...current, id: op.recordId }, scopes)) return null
		let fieldVersions: RecordFieldVersions | null = null
		if (this.store.getRecordFieldVersions) {
			try {
				fieldVersions = await this.store.getRecordFieldVersions(op.collection, op.recordId)
			} catch {
				// Fall back to a single whole-row stamp below.
			}
		}
		// W7 / RT-29 (B2): the record's fold state rides on the entry (filtered to its fields).
		const foldState = await this.store
			.getRecordFoldState?.(op.collection, op.recordId)
			.catch(() => null)
		let timestamp = fieldVersions?.latest ?? op.timestamp
		if (!fieldVersions && this.store.getRecordLatestTimestamp) {
			try {
				timestamp =
					(await this.store.getRecordLatestTimestamp(op.collection, op.recordId)) ?? timestamp
			} catch {
				// Fall back to the trigger's timestamp: still at or above every field it wrote.
			}
		}
		return buildScopeEntryOperation({
			trigger: op,
			row: current,
			schema,
			timestamp,
			fieldVersions,
			foldState,
			schemaVersion: this.schemaVersion,
		})
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
		const cached = this.recordLookupCache?.get(recordCacheKey(collection, recordId))
		if (cached !== undefined) return cached ?? undefined
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

	/** A legacy client's duplicate pair was stored (RT-37): count it and log it. */
	private recordLegacySequencePair(pair: LegacySequencePair): void {
		this.legacySequencePairs += 1
		this.logger?.log({
			timestamp: Date.now(),
			level: 'warn',
			event: 'session.legacy_sequence_pair',
			sessionId: this.sessionId,
			nodeId: pair.nodeId,
			details: {
				operationId: pair.operationId,
				sequenceNumber: pair.sequenceNumber,
				holderIds: pair.holderIds,
				legacyWriter: pair.legacyWriter,
				message: pair.legacyWriter
					? 'A client without the sequenceReservation capability (Kora <= beta.13) uploaded a second operation under a held sequence number. Both are stored and delivered. Upgrade the client.'
					: 'An operation shares its sequence number with one stored before sequence enforcement (Kora <= beta.12). Both are stored.',
			},
		})
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

	private handleTransportClose(): void {
		if (this.state === 'closed') return
		this.state = 'closed'
		this.clearSessionTimers()
		this.flushOrphanedRelays()
		this.emitter?.emit({ type: 'sync:disconnected', reason: 'transport closed' })
		this.onClose?.(this.sessionId)
	}
}

/** Key of a record in the delivery chunk's prefetch cache. */
function recordCacheKey(collection: string, recordId: string): string {
	return `${collection}\u0000${recordId}`
}

/**
 * One item of a session's delivery stream: a stored operation, a retraction of its
 * record, or a synthesized scope entry sharing the triggering operation's sequence.
 */
type DeliverableOperation = DeliveredOperation & { retraction?: boolean; scopeEntry?: boolean }

/**
 * The wire format a serializer frames messages with: its own report when it has one, protobuf
 * for the fixed protobuf serializer, and JSON otherwise.
 */
function framingWireFormat(serializer: MessageSerializer): WireFormat {
	if (typeof serializer.getWireFormat === 'function') return serializer.getWireFormat()
	if (serializer instanceof ProtobufMessageSerializer) return 'protobuf'
	return 'json'
}

/** True when every identifier of `op` can be stored and looked up by every store (RT-65). */
function operationIdentifiersStorable(op: Operation): boolean {
	return (
		isStorableIdentifier(op.id) &&
		isStorableIdentifier(op.nodeId) &&
		isStorableIdentifier(op.collection) &&
		isStorableIdentifier(op.recordId) &&
		(Array.isArray(op.causalDeps) ? op.causalDeps.every(isStorableIdentifier) : true)
	)
}
