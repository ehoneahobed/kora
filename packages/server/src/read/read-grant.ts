import { createHash } from 'node:crypto'
import type { AccessDefinition, SchemaDefinition } from '@korajs/core'
import { accessReadGrant } from '../access/access-authorizer'
import { type ValidAccessGrant, grantIntervals, validAccessGrants } from '../access/access-grants'
import { storeIndexesAccess } from '../access/access-guard'
import {
	type MembershipInterval,
	cachedAccessReadRulesFingerprint,
} from '../access/membership-index'
import { NoAuthProvider } from '../auth/no-auth'
import { ScopeRequiredError, resolveSessionScopes } from '../scopes/resolve-session-scopes'
import { InvalidScopePredicateError } from '../scopes/scope-predicate-errors'
import { type ScopeMap, normalizeScopeMap } from '../scopes/server-scope-filter'
import type { AccessIndexState, MaterializedRecord, ServerStore } from '../store/server-store'
import type { AuthContext, AuthProvider } from '../types'

/**
 * The read grant: the one place that turns a principal into the set of records it may read.
 *
 * A sync session computes it at its handshake and recompiles it on every membership change;
 * the read-through endpoint (first-visit parity S2) computes it per request. Both call the
 * functions below, so the two read paths cannot drift: a record the endpoint returns is a
 * record the session's delivery stream would deliver under the same credential, scope and
 * memberships.
 */

/**
 * The most values one compiled access grant may hold. A user can belong to many groups, so a
 * compiled grant is not held to the provider-grant value limit.
 */
export const MAX_ACCESS_GRANT_VALUES = 10_000

/**
 * The download scope of a collection that has no access rules: the provider's grant for it
 * (`{}` when the provider grants everything), or null when it is denied.
 *
 * @param authContext - The authenticated context, with its resolved scopes
 * @param collection - The collection
 */
export function sessionDownlinkScope(
	authContext: AuthContext | null | undefined,
	collection: string,
): Record<string, unknown> | null {
	const scopes = authContext?.downlinkScopes ?? authContext?.scopes
	if (scopes === undefined) return {}
	return Object.prototype.hasOwnProperty.call(scopes, collection)
		? (scopes[collection] as Record<string, unknown>)
		: null
}

/** The result of {@link applyAccessGrant}. */
export type AccessGrantApplied =
	| { ok: true; downlink: ScopeMap | undefined; uplink: ScopeMap | undefined }
	| { ok: false; failure: { ok: false; code: string; message: string; reason: string } }

/**
 * Replace the grant of every access collection with the one the rules compile to.
 * Downlink: the compiled read grant (a collection the user may not read is left out, which
 * denies it). Uplink: unrestricted, because the write rules decide each write at decision
 * time. Collections without rules keep the provider's grant; when the provider grants
 * everything (an undefined map), they stay unrestricted.
 *
 * @param schema - The server schema (null: nothing to replace)
 * @param accessGrant - The compiled read grant of the access collections, or null when the
 *   schema declares no rules or none was compiled
 * @param downlink - The provider's downlink grant
 * @param uplink - The provider's uplink grant
 */
export function applyAccessGrant(
	schema: SchemaDefinition | null,
	accessGrant: Record<string, Record<string, unknown>> | null,
	downlink: ScopeMap | undefined,
	uplink: ScopeMap | undefined,
): AccessGrantApplied {
	const access = schema?.access
	if (!schema || !access || accessGrant === null) return { ok: true, downlink, uplink }
	const accessCollections = Object.keys(access.collections)
	const expand = (map: ScopeMap | undefined): ScopeMap => {
		if (map !== undefined) return { ...map }
		const all: ScopeMap = {}
		for (const name of Object.keys(schema.collections)) all[name] = {}
		return all
	}
	const nextDown = expand(downlink)
	const nextUp = expand(uplink)
	const compiled: ScopeMap = {}
	for (const name of accessCollections) {
		delete nextDown[name]
		nextUp[name] = {}
		const grant = Object.prototype.hasOwnProperty.call(accessGrant, name)
			? accessGrant[name]
			: undefined
		if (grant !== undefined) compiled[name] = grant
	}
	try {
		Object.assign(nextDown, normalizeScopeMap(compiled, MAX_ACCESS_GRANT_VALUES))
	} catch (error) {
		return {
			ok: false,
			failure: {
				ok: false,
				code: 'SCOPE_PREDICATE_LIMIT',
				message: error instanceof Error ? error.message : 'Access grant too large',
				reason: 'access grant too large',
			},
		}
	}
	return { ok: true, downlink: nextDown, uplink: nextUp }
}

/**
 * A principal's capability grants (`AuthContext.accessGrants`) as membership intervals, for
 * the groups whose record exists: a deleted group grants nothing, as for its members.
 *
 * @param store - The server store
 * @param access - The schema's access definition (absent: no grants)
 * @param accessGrants - The credential's grants
 * @param userId - The principal (null for an anonymous one)
 * @param now - Server time, for grant expiry
 * @returns The intervals, and the group of every valid grant (live or not)
 */
export async function readGrantedIntervalsFor(
	store: ServerStore,
	access: AccessDefinition | undefined,
	accessGrants: AuthContext['accessGrants'],
	userId: string | null,
	now: number,
): Promise<{ intervals: MembershipInterval[]; groups: Set<string> }> {
	const valid: ValidAccessGrant[] = access ? validAccessGrants(access, accessGrants, now) : []
	const groups = new Set(valid.map((grant) => grant.group))
	if (valid.length === 0) return { intervals: [], groups }
	const live = new Set<string>()
	const isLive = (row: MaterializedRecord | undefined): boolean =>
		row !== undefined && row._deleted !== 1 && row._deleted !== true
	const byCollection = new Map<string, ValidAccessGrant[]>()
	for (const grant of valid) {
		const list = byCollection.get(grant.collection)
		if (list) list.push(grant)
		else byCollection.set(grant.collection, [grant])
	}
	for (const [collection, grants] of byCollection) {
		if (store.findRecordsByIds) {
			let rows: Map<string, MaterializedRecord>
			try {
				rows = await store.findRecordsByIds(
					collection,
					grants.map((grant) => grant.id),
				)
			} catch {
				// Unreadable: these grants give nothing (fail closed).
				continue
			}
			for (const grant of grants) if (isLive(rows.get(grant.id))) live.add(grant.group)
			continue
		}
		for (const grant of grants) {
			let row: MaterializedRecord | undefined
			try {
				row = (
					await store.queryCollection(collection, {
						where: { id: grant.id },
						includeDeleted: true,
						limit: 1,
					})
				)[0]
			} catch {
				row = undefined
			}
			if (isLive(row)) live.add(grant.group)
		}
	}
	return {
		intervals: grantIntervals(
			valid.filter((grant) => live.has(grant.group)),
			userId,
		),
		groups,
	}
}

/** A read the endpoint refuses, with the HTTP status that carries it. */
export interface ReadGrantFailure {
	ok: false
	status: 403 | 409
	code: string
	message: string
	retriable: boolean
}

/** The grant a read is answered under. */
export interface ReadGrant {
	/**
	 * The per-collection download scope: a collection missing from the map is denied; the
	 * map itself undefined means the principal reads every record of every collection (a
	 * server without an auth provider or a schema scope).
	 */
	scopes: ScopeMap | undefined
	/** A hash of the scope map and the read rules: it changes when the grant does. */
	grantKey: string
	/**
	 * Everything the grant was compiled from, as one string (the index generation, the
	 * principal's intervals, the compiled scopes). Two equal strings mean the grant did not
	 * change between two reads (see {@link grantBasis}).
	 */
	basis: string
}

/** What {@link computeReadGrant} needs from the server. */
export interface ReadGrantInput {
	store: ServerStore
	/** The configured auth provider; null (or `NoAuthProvider`) means no authentication. */
	auth: AuthProvider | null
	/** The authenticated context, or null when the server has no real auth provider. */
	context: AuthContext | null
	/** Value limit of a provider grant's `$in` lists (the session's `maxScopePredicateValues`). */
	maxScopePredicateValues?: number | undefined
	/** Server time (injected so tests are deterministic). */
	now: number
}

/**
 * Compute the downlink grant of one principal, exactly as a sync session does at its
 * handshake (`ClientSession`): the provider's scopes resolved against the schema, narrowed by
 * the access rules compiled from the principal's membership intervals as the store holds them
 * now. The client's own scope and query views can only narrow this grant, so a read never
 * takes any scope from the request.
 *
 * Retriable refusals (`ACCESS_RULES_CHANGED`): the membership index is rebuilding, or its
 * generation changed while the intervals were read. Final ones: the store keeps no index.
 *
 * @param input - Store, auth provider, context and clock
 * @returns The grant, or the refusal to answer with
 */
export async function computeReadGrant(
	input: ReadGrantInput,
): Promise<{ ok: true; grant: ReadGrant } | ReadGrantFailure> {
	const { store, auth, context, now } = input
	const schema = store.getSchema()
	const realAuth = auth !== null && !(auth instanceof NoAuthProvider)
	const authenticated = realAuth && schema !== null

	// 1. The provider's grant, resolved against the schema (no handshake scope: a read
	//    carries none, and a client scope could only narrow it).
	const directional = context?.downlinkScopes !== undefined || context?.uplinkScopes !== undefined
	const downlinkAuthScopes = directional
		? (context?.downlinkScopes ?? context?.scopes ?? {})
		: context?.scopes
	let downlink: ScopeMap | undefined
	try {
		const raw = resolveSessionScopes(schema, {
			authScopes: downlinkAuthScopes,
			authenticated,
			onUnresolved: 'throw',
		})
		downlink = raw
			? normalizeScopeMap(raw, input.maxScopePredicateValues)
			: directional
				? {}
				: undefined
	} catch (error) {
		if (error instanceof ScopeRequiredError) {
			return refusal(403, 'SCOPE_REQUIRED', error.message, false)
		}
		if (error instanceof InvalidScopePredicateError) {
			return refusal(403, 'INVALID_SCOPE_PREDICATE', error.message, false)
		}
		return refusal(
			403,
			'SCOPE_PREDICATE_LIMIT',
			error instanceof Error ? error.message : 'Invalid scope predicate',
			false,
		)
	}

	// 2. The access rules, compiled from the memberships as the store holds them now.
	const access = schema?.access
	let accessGrant: Record<string, Record<string, unknown>> | null = null
	let generation: string | null = null
	let intervalsKey = ''
	if (access) {
		if (!storeIndexesAccess(store)) {
			return refusal(
				403,
				'ACCESS_RULES_UNSUPPORTED_STORE',
				'This schema declares access rules, but the server store keeps no membership index.',
				false,
			)
		}
		if (store.isAccessIndexReady?.() === false) return rulesChanged()
		const userId = context !== null && context.anonymous !== true ? context.userId : null
		// The state is read before the intervals and again after them: a rebuild that began,
		// committed or rotated the generation meanwhile shows in the second read.
		const before = await store.getAccessIndexState?.()
		if (before?.rebuilding === true) return rulesChanged()
		const stored = userId !== null ? ((await store.getMembershipIntervals?.(userId)) ?? []) : []
		const granted = await readGrantedIntervalsFor(store, access, context?.accessGrants, userId, now)
		const after = await store.getAccessIndexState?.()
		if (indexUnstable(store, before, after)) return rulesChanged()
		generation = after?.generation ?? null
		const intervals = [...stored, ...granted.intervals]
		intervalsKey = intervalsFingerprint(intervals)
		accessGrant = accessReadGrant(access, { userId }, intervals, now)
	}
	const applied = applyAccessGrant(schema, accessGrant, downlink, downlink)
	if (!applied.ok) {
		return refusal(403, applied.failure.code, applied.failure.message, false)
	}

	const scopes = applied.downlink
	const scopesKey = stableJson(scopes ?? null)
	const rulesKey = cachedAccessReadRulesFingerprint(access)
	return {
		ok: true,
		grant: {
			scopes,
			grantKey: createHash('sha256').update(`${rulesKey}\u0000${scopesKey}`).digest('base64url'),
			basis: `${generation ?? ''}\u0000${rulesKey}\u0000${intervalsKey}\u0000${scopesKey}`,
		},
	}
}

/**
 * The state of everything a grant depends on, read cheaply: the membership index generation
 * and the principal's intervals. The endpoint reads it after the rows and compares it with
 * {@link ReadGrant.basis}; a difference means a membership changed while the read ran.
 *
 * @returns The basis string, or null when the index cannot be judged right now
 */
export async function grantBasis(input: ReadGrantInput): Promise<string | null> {
	const result = await computeReadGrant(input)
	return result.ok ? result.grant.basis : null
}

function indexUnstable(
	store: ServerStore,
	before: AccessIndexState | undefined,
	after: AccessIndexState | undefined,
): boolean {
	if (before?.rebuilding === true || after?.rebuilding === true) return true
	if (store.isAccessIndexReady?.() === false) return true
	return (before?.generation ?? null) !== (after?.generation ?? null)
}

function intervalsFingerprint(intervals: readonly MembershipInterval[]): string {
	return JSON.stringify(
		intervals
			.map((i) => [
				i.group,
				i.source,
				i.recordId,
				i.role,
				i.expiresAt,
				i.joinedSeq,
				i.roleSeq,
				i.leftSeq,
			])
			.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
	)
}

function rulesChanged(): ReadGrantFailure {
	return refusal(
		409,
		'ACCESS_RULES_CHANGED',
		'The access rules or the membership index changed. Try again shortly.',
		true,
	)
}

function refusal(
	status: 403 | 409,
	code: string,
	message: string,
	retriable: boolean,
): ReadGrantFailure {
	return { ok: false, status, code, message, retriable }
}

/** Canonical JSON: object keys sorted, so equal grants have one string. */
function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
	if (value !== null && typeof value === 'object') {
		const record = value as Record<string, unknown>
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
			.join(',')}}`
	}
	if (typeof value === 'number') return Object.is(value, -0) ? '#-0' : `#${String(value)}`
	return JSON.stringify(value) ?? 'null'
}
