/**
 * Stable server identity (RT-61, RT-62, RT-64).
 *
 * Every operation the server authors (route writes, cascades, set-nulls, constraint
 * corrections) is authored by a node id in the reserved namespace
 * `kora:server:<deploymentId>:<instanceId>`:
 *
 * - `deploymentId` is generated once per database and persisted in `kora_server_meta`,
 *   so every instance that shares the database (and every restart) belongs to one
 *   deployment.
 * - `instanceId` is distinct per running instance, so two instances never author the
 *   same `(nodeId, sequenceNumber)`: SQLite persists one (a SQLite database has one
 *   writer process), Postgres allocates a fresh one from a counter in the database on
 *   every start unless the operator configures a stable `instanceId` per instance.
 *
 * Authority (`merge('server-authoritative')`) is the prefix rule: any operation whose
 * node id starts with {@link SERVER_NODE_PREFIX} is authoritative, on the server and on
 * every device. Devices can never use a `kora:` node id (the session refuses it at
 * handshake). Server node ids written before this release (random per-process ids, or
 * an id the operator configured) are recorded once, at the first start of this release,
 * in a persisted list of legacy authoritative ids that the handshake keeps advertising,
 * so earlier server decisions keep winning everywhere.
 *
 * Server-derived operation ids (cascades, corrections) are keyed with a persisted,
 * deployment-wide secret (HMAC-SHA-256), so a writer cannot predict them and occupy one
 * first; every instance of the deployment derives the same id for the same effect.
 */
import { KoraError, generateUUIDv7 } from '@korajs/core'

/** Prefix of every node id the server authors under. */
export const SERVER_NODE_PREFIX = 'kora:server:'

/** Prefix reserved for Kora itself; no device may use a node id that starts with it. */
export const RESERVED_NODE_PREFIX = 'kora:'

/** `kora_server_meta` key: the deployment id, generated once per database. */
export const SERVER_DEPLOYMENT_ID_KEY = 'server_deployment_id'

/** `kora_server_meta` key: the deployment's derivation secret (hex), generated once. */
export const SERVER_DERIVATION_SECRET_KEY = 'server_derivation_secret'

/** `kora_server_meta` key: the persisted instance id of a single-writer (SQLite) database. */
export const SERVER_INSTANCE_ID_KEY = 'server_instance_id'

/** `kora_server_meta` key: the counter Postgres instances draw their instance ids from. */
export const SERVER_INSTANCE_COUNTER_KEY = 'server_instance_counter'

/** `kora_server_meta` key: JSON array of legacy authoritative node ids. */
export const SERVER_LEGACY_AUTHORITY_KEY = 'server_legacy_authoritative_node_ids'

/** `kora_server_meta` key: set once the legacy server node ids were collected from the log. */
export const SERVER_LEGACY_SCAN_KEY = 'server_legacy_authority_scan_v1'

const INSTANCE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** Domain tag of keyed server-derived ids (never equal to a content hash input). */
const SERVER_DERIVED_DOMAIN = 'kora/server-derived/v1'

/** Thrown for an invalid server identity configuration. */
export class ServerIdentityError extends KoraError {
	constructor(message: string, context?: Record<string, unknown>) {
		super(message, 'INVALID_SERVER_IDENTITY', context)
		this.name = 'ServerIdentityError'
	}
}

/** Identity options every server store accepts. */
export interface ServerIdentityOptions {
	/**
	 * Deprecated. A plain id (for example one set before beta.14) is no longer the id the
	 * server authors under: it is recorded as a legacy authoritative id, so operations
	 * already stored under it keep their authority, and no device may use it. An id in
	 * the `kora:server:` namespace is used verbatim (it must then be unique per instance).
	 */
	nodeId?: string
	/**
	 * Stable id of this instance within the deployment (`[A-Za-z0-9._-]`, at most 64
	 * characters). Must be distinct per running instance. SQLite persists one on its own;
	 * Postgres allocates a new one per start when it is not configured.
	 */
	instanceId?: string
	/** Extra node ids whose operations win `merge('server-authoritative')` fields. */
	authoritativeNodeIds?: string[]
}

/** The configuration part of an identity, validated. */
export interface ConfiguredIdentity {
	/** A `kora:server:` node id configured verbatim, or null. */
	verbatimNodeId: string | null
	/** A configured plain node id (the id the server authored under before beta.14), or null. */
	legacyNodeId: string | null
	/** A configured instance id, or null. */
	instanceId: string | null
	/** Configured ids that are explicit (legacy) authorities: a plain `nodeId` and the extras. */
	explicitAuthorities: string[]
}

/**
 * Validate the identity options of a store.
 *
 * @throws {ServerIdentityError} For a `kora:` node id outside `kora:server:`, or a malformed instance id
 */
export function parseIdentityOptions(options: ServerIdentityOptions): ConfiguredIdentity {
	let verbatimNodeId: string | null = null
	let legacyNodeId: string | null = null
	const explicitAuthorities: string[] = []
	const { nodeId, instanceId } = options
	if (nodeId !== undefined) {
		if (typeof nodeId !== 'string' || nodeId.length === 0) {
			throw new ServerIdentityError('Server nodeId must be a non-empty string.', { nodeId })
		}
		if (nodeId.startsWith(SERVER_NODE_PREFIX)) {
			if (nodeId.length === SERVER_NODE_PREFIX.length) {
				throw new ServerIdentityError(`Server nodeId "${nodeId}" has nothing after the prefix.`)
			}
			verbatimNodeId = nodeId
		} else if (nodeId.startsWith(RESERVED_NODE_PREFIX)) {
			throw new ServerIdentityError(
				`Server nodeId "${nodeId}" is in the reserved "kora:" namespace. Leave nodeId unset (the server derives "kora:server:<deployment>:<instance>"), or set instanceId.`,
				{ nodeId },
			)
		} else {
			legacyNodeId = nodeId
			explicitAuthorities.push(nodeId)
		}
	}
	if (instanceId !== undefined && !INSTANCE_ID_PATTERN.test(instanceId)) {
		throw new ServerIdentityError(
			`Server instanceId "${String(instanceId)}" must match ${INSTANCE_ID_PATTERN.source}.`,
			{ instanceId },
		)
	}
	for (const extra of options.authoritativeNodeIds ?? []) {
		if (typeof extra === 'string' && extra.length > 0 && !extra.startsWith(RESERVED_NODE_PREFIX)) {
			explicitAuthorities.push(extra)
		}
	}
	return { verbatimNodeId, legacyNodeId, instanceId: instanceId ?? null, explicitAuthorities }
}

/** The node id of an instance of a deployment. */
export function serverNodeIdFor(deploymentId: string, instanceId: string): string {
	return `${SERVER_NODE_PREFIX}${deploymentId}:${instanceId}`
}

/** Prefix shared by every instance node id of one deployment. */
export function deploymentNodePrefix(deploymentId: string): string {
	return `${SERVER_NODE_PREFIX}${deploymentId}:`
}

/** True for a node id the server authors under (current or any instance of any deployment). */
export function isServerNodeId(nodeId: string): boolean {
	return nodeId.startsWith(SERVER_NODE_PREFIX)
}

/** A new deployment id (UUID v7, so deployments sort by creation). */
export function generateDeploymentId(): string {
	return generateUUIDv7()
}

/** A new random instance id (memory stores, which persist nothing). */
export function generateInstanceId(): string {
	return generateUUIDv7()
}

/** A new 256-bit derivation secret, hex encoded. */
export function generateDerivationSecret(): string {
	const bytes = new Uint8Array(32)
	globalThis.crypto.getRandomValues(bytes)
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Parse the persisted legacy list (tolerates a missing or malformed value). */
export function parseLegacyAuthorities(value: string | null | undefined): string[] {
	if (typeof value !== 'string' || value.length === 0) return []
	try {
		const parsed: unknown = JSON.parse(value)
		return Array.isArray(parsed)
			? parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
			: []
	} catch {
		return []
	}
}

/** Canonical (sorted, unique, no reserved ids) form of a legacy list. */
export function normalizeLegacyAuthorities(ids: Iterable<string>): string[] {
	return [
		...new Set([...ids].filter((id) => id.length > 0 && !id.startsWith(RESERVED_NODE_PREFIX))),
	].sort()
}

/**
 * The authority set the server folds with: every `kora:server:` node id, plus the
 * explicit (legacy and configured) ids. A `Set` whose `has` also applies the prefix
 * rule, so it can be passed as `FoldOptions.authoritativeNodeIds`.
 */
export class ServerAuthoritySet extends Set<string> {
	override has(nodeId: string): boolean {
		return isServerNodeId(nodeId) || super.has(nodeId)
	}
}

/**
 * The operation ids of every stamp with authority class 1 in a serialized fold state:
 * the writes that won a `merge('server-authoritative')` field because their node was
 * authoritative when the server folded them.
 *
 * Reads stamps only from their positions in the fold-state format (RT-76): the
 * record's `cr`/`w`/`d`/`u` registers and each field kind's stamp members. Values
 * (`v`, element values, key values, resolver bases) are never walked: a device writes
 * them, and a json value shaped like a stamp must not name an authority. The format
 * version is not enforced (the scan reads states a pre-release fold build wrote);
 * anything that does not have the expected shape is skipped.
 */
export function authoritativeStampOpIds(stateJson: string): string[] {
	let parsed: unknown
	try {
		parsed = JSON.parse(stateJson)
	} catch {
		return []
	}
	if (!isObject(parsed)) return []
	const found = new Set<string>()
	const stamp = (value: unknown): void => {
		if (
			isObject(value) &&
			value.c === 1 &&
			typeof value.t === 'string' &&
			typeof value.o === 'string'
		) {
			found.add(value.o)
		}
	}
	/** `{ s: Stamp, ... }` members (shape registers, base/best/reset registers, map keys). */
	const wrapped = (value: unknown): void => {
		if (isObject(value)) stamp(value.s)
	}
	for (const key of ['cr', 'w', 'd', 'u'] as const) stamp(parsed[key])
	const fields = isObject(parsed.f) ? parsed.f : {}
	for (const field of Object.values(fields)) {
		if (!isObject(field)) continue
		switch (field.k) {
			case 'reg':
			case 'res':
				for (const entry of asArray(field.e)) wrapped(entry)
				break
			case 'set':
				wrapped(field.sh)
				stamp(field.clr)
				for (const element of Object.values(isObject(field.el) ? field.el : {})) {
					if (!isObject(element)) continue
					stamp(element.a)
					wrapped(element.f)
					stamp(element.r)
				}
				break
			case 'map':
				wrapped(field.sh)
				stamp(field.clr)
				for (const keyState of Object.values(isObject(field.keys) ? field.keys : {})) {
					wrapped(keyState)
				}
				break
			case 'ctr':
				wrapped(field.base)
				for (const delta of asArray(field.d)) wrapped(delta)
				break
			case 'max':
			case 'min':
				wrapped(field.best)
				wrapped(field.reg)
				break
			case 'rt':
				wrapped(field.reset)
				for (const updateStamp of Object.values(isObject(field.u) ? field.u : {})) {
					stamp(updateStamp)
				}
				break
			default:
				break
		}
	}
	return [...found]
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : []
}

/** Imported HMAC keys, per secret. */
const derivationKeys = new Map<string, Promise<CryptoKey>>()

function derivationKey(secretHex: string): Promise<CryptoKey> {
	let key = derivationKeys.get(secretHex)
	if (!key) {
		const bytes = new Uint8Array(secretHex.length / 2)
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Number.parseInt(secretHex.slice(i * 2, i * 2 + 2), 16)
		}
		key = globalThis.crypto.subtle.importKey(
			'raw',
			bytes,
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign'],
		)
		derivationKeys.set(secretHex, key)
	}
	return key
}

/**
 * Keyed id of a server-derived operation (a cascade, a set-null, a constraint
 * correction): HMAC-SHA-256 under the deployment's secret over the JSON array
 * `[domain, parent, rule, target]`, hex encoded. Deterministic for every instance of
 * the deployment (idempotent across instances and retries), unpredictable for anyone
 * without the secret (RT-64): no client can store an operation under it first.
 *
 * @param secretHex - The deployment's derivation secret
 * @param parentOpId - Id (or composite key) of the operation whose application produced the effect
 * @param ruleId - Stable id of the rule (for example `server/relation:<name>:cascade`)
 * @param targetRecordId - Id of the record the effect writes
 */
export async function deriveKeyedServerOpId(
	secretHex: string,
	parentOpId: string,
	ruleId: string,
	targetRecordId: string,
): Promise<string> {
	for (const [name, value] of [
		['parentOpId', parentOpId],
		['ruleId', ruleId],
		['targetRecordId', targetRecordId],
	] as const) {
		if (typeof value !== 'string' || value.length === 0) {
			throw new ServerIdentityError(`deriveServerOperationId: ${name} must be a non-empty string`, {
				[name]: value,
			})
		}
	}
	const key = await derivationKey(secretHex)
	// A JSON array has one serialization: unambiguous framing of the four strings.
	const canonical = JSON.stringify([SERVER_DERIVED_DOMAIN, parentOpId, ruleId, targetRecordId])
	const mac = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(canonical))
	return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, '0')).join('')
}
