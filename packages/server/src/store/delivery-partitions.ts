import { createHash } from 'node:crypto'
import type { AccessRule, SchemaDefinition } from '@korajs/core'
import { getCollectionScopeBindings } from '@korajs/core'
import { canonicalize, scopeBranches } from '@korajs/core/internal'
import type { CollectionScope } from '@korajs/core/internal'
import { scopeSnapshotFingerprint } from './scope-snapshot'
import type { DeliveredOperation, OperationScopeSnapshot } from './server-store'

/**
 * Visibility index for the delivery stream (C2, `docs/design/fast-first-sync.md` section 2).
 *
 * The index only NARROWS what a session reads; `filterDeliveryChunk` stays the single
 * authority on what it receives. Every function here therefore errs towards MORE keys
 * (the superset invariant): a false positive costs one wasted judgment, a false negative
 * is a lost operation the watermark cannot recover. When in doubt an operation is filed
 * under the collection's "unknown" key, which every session that reads the collection
 * includes.
 */

/** Meta key holding the fingerprint of the partition fields the index was built under. */
export const DELIVERY_PARTITION_FIELDS_KEY = 'delivery_partition_fields'

/**
 * Meta key of the contiguous frontier: every operation (and every sequence reserved
 * without one) at or below it has its index rows. Absent or `0` means nothing is covered.
 */
export const DELIVERY_PARTITIONS_THROUGH_KEY = 'delivery_partitions_through'

/** Meta key recording the delivery counter when the index was last reset (diagnostics). */
export const DELIVERY_PARTITIONS_FROM_KEY = 'delivery_partitions_from'

/** Operations indexed per backfill transaction. */
export const DELIVERY_PARTITION_BACKFILL_CHUNK = 5000

/**
 * Most sources (partition keys, collections and nodes together) one indexed read
 * accepts. Above it the caller collapses `$in` grants to their collection and, if that
 * is still too many, reads through the global scan. A read costs
 * O(|sources| x log n + |sources| x limit), which stops beating the scan around here.
 */
export const MAX_DELIVERY_SOURCES = 256

/** The value segment of a collection's "unknown" key (`collection \0 ?`). */
const UNKNOWN_SEGMENT = '?'

/**
 * Where the operations of a read can be found: partition keys, whole collections
 * (a read no partition field narrows) and nodes (the session's own accepted writes).
 */
export interface DeliverySources {
	/** Keys from {@link partitionKey} and {@link unknownPartitionKey}. */
	partitionKeys: readonly bigint[]
	/** Collections read in full, through `idx_collection_delivery`. */
	collections: readonly string[]
	/** Nodes whose operations are read, through `idx_node_delivery`. */
	nodeIds: readonly string[]
}

/** Result of `getOperationsAfterDeliveryIn`. */
export interface DeliveryIndexRead {
	/**
	 * Operations of the sources after the cursor and at or below {@link coveredThrough},
	 * in delivery order, without duplicates. Empty when {@link complete} is false.
	 */
	operations: DeliveredOperation[]
	/**
	 * True when the index answered. False means it cannot be trusted for this read (it is
	 * rebuilding, an index is invalid, the sources exceed {@link MAX_DELIVERY_SOURCES}, or
	 * the instance runs another partition plan): the caller reads through the global scan.
	 */
	complete: boolean
	/**
	 * The index covers every sequence up to this one (`max(cursor, through)`, with
	 * `through` read BEFORE the query). When fewer than `limit` operations come back,
	 * nothing the sources hold lies in `(cursor, coveredThrough]`; when `limit` come back,
	 * only the range up to the last one returned is known to be exhausted. The caller reads
	 * the tail above `coveredThrough` through the global scan.
	 */
	coveredThrough: number
}

/** The partition fields of every collection and the fingerprint they were derived under. */
export interface DeliveryPartitionPlan {
	/**
	 * `P(c)` per collection: the fields an operation of `c` is indexed under, sorted.
	 * Collections without an entry are indexed under their unknown key only.
	 */
	readonly fields: ReadonlyMap<string, readonly string[]>
	/**
	 * Fingerprint of `fields` and of the scalar fields scope snapshots capture. A change
	 * rebuilds the index, in the same step that recomputes snapshots (RT-20).
	 */
	readonly fingerprint: string
}

/** Collection-keyed extra partition fields (`KoraSyncServer` option `deliveryPartitions`). */
export type DeliveryPartitionOverrides = Readonly<Record<string, readonly string[]>>

/**
 * Every record field an access rule's compiled scope can constrain. Mirrors
 * `compileBranches` in `@korajs/core`: `owner`, `member` and `memberOfKey` compile to a
 * predicate on their field, `where` to one on each key it names, `or` and `and` to their
 * children's; `anyone`, `serverOnly` and `custom` constrain nothing.
 *
 * @param rule - A read rule
 * @param into - Receives the field names
 */
export function accessRuleFields(rule: AccessRule | null, into: Set<string>): void {
	if (rule === null) return
	switch (rule.kind) {
		case 'owner':
		case 'member':
		case 'memberOfKey':
			into.add(rule.field)
			return
		case 'where':
			for (const field of Object.keys(rule.equals)) into.add(field)
			return
		case 'or':
		case 'and':
			for (const child of rule.rules) accessRuleFields(child, into)
			return
		case 'anyone':
		case 'serverOnly':
		case 'custom':
			return
	}
}

/**
 * Derive `P(c)` for every collection of `schema` and fingerprint the result.
 *
 * `P(c)` is the union of:
 * - the scope bindings' record fields (`schema.sync` rules, else `collection.scope`);
 * - every field an access read rule of `c` names, recursively through `or` and `and`;
 * - for the memberships collection: `userId` (a user's own rows are always sent) and `group`;
 * - for each group collection: `id` (deletion, restore and revival of a group) and its
 *   owner field;
 * - the `overrides` for providers whose scopes name fields the schema does not declare
 *   (`TokenAuthProvider` scopes are arbitrary maps, so they cannot be inferred).
 *
 * Fields the collection does not declare are kept: a scope can name a field only
 * the provider knows, and an operation whose snapshot lacks it falls under the unknown key.
 *
 * @param schema - The server schema
 * @param overrides - Extra partition fields per collection
 */
export function deriveDeliveryPartitionPlan(
	schema: SchemaDefinition,
	overrides: DeliveryPartitionOverrides = {},
): DeliveryPartitionPlan {
	const access = schema.access
	const fields = new Map<string, readonly string[]>()
	const names = new Set<string>([...Object.keys(schema.collections), ...Object.keys(overrides)])
	for (const collection of [...names].sort()) {
		const set = new Set<string>()
		for (const field of Object.keys(getCollectionScopeBindings(schema, collection) ?? {})) {
			set.add(field)
		}
		accessRuleFields(access?.collections[collection]?.read ?? null, set)
		if (access?.memberships === collection) {
			set.add('userId')
			set.add('group')
		}
		const groupOwner = access?.groups[collection]?.owner
		if (groupOwner !== undefined) {
			set.add('id')
			set.add(groupOwner)
		}
		for (const field of overrides[collection] ?? []) set.add(field)
		if (set.size > 0) fields.set(collection, [...set].sort())
	}
	// The scalar fields snapshots capture are part of it: a partition field absent from a
	// snapshot is filed under the unknown key, so the index follows the snapshot rebuild.
	const body = [...fields]
		.map(
			([collection, list]) =>
				`${JSON.stringify(collection)}:${list.map((f) => JSON.stringify(f)).join(',')}`,
		)
		.join('|')
	const fingerprint = `dp1:${createHash('sha256')
		.update(`${scopeSnapshotFingerprint(schema)}#${body}`)
		.digest('hex')}`
	return { fields, fingerprint }
}

/** Signed 64-bit integer of the first eight bytes of a SHA-256 digest. */
function hash64(input: string): bigint {
	const digest = createHash('sha256').update(input).digest()
	return digest.readBigInt64BE(0)
}

/**
 * The key of `value` in field `field` of `collection`:
 * `int64(sha256(collection \0 field \0 canonicalJSON(value)))`. A 64-bit hash is enough
 * because a collision only adds rows to a read, never removes one.
 *
 * @param collection - Collection name
 * @param field - A field of `P(collection)`
 * @param value - The field's value in a scope snapshot (scalar or null)
 */
export function partitionKey(collection: string, field: string, value: unknown): bigint {
	return hash64(`${collection}\0${field}\0${canonicalize(value)}`)
}

/**
 * The key every session that reads `collection` includes: operations whose scope the
 * index cannot place (no snapshot, or a snapshot lacking a partition field).
 */
export function unknownPartitionKey(collection: string): bigint {
	return hash64(`${collection}\0${UNKNOWN_SEGMENT}`)
}

/**
 * The keys an operation is filed under, from its scope snapshot: for each field of
 * `P(collection)` the value it has in the PRE and in the POST image (a retraction is
 * found through pre, a scope entry and plain visibility through post), plus the unknown
 * key when it cannot be placed.
 *
 * An absent snapshot, an unknown post image (`post: null` on an operation that is not a
 * first insert is how RT-14 records "unknown"), or a side that lacks a partition field
 * gives the unknown key. A `pre` of `null` means the record did not exist, so it can
 * hold no retraction and adds no key.
 *
 * @param plan - The partition plan
 * @param collection - The operation's collection
 * @param snapshot - Its stored scope snapshot, or null
 * @returns Distinct keys; empty only for a collection without partition fields, which
 *   sessions read whole through `idx_collection_delivery` and which needs no rows
 */
export function partitionKeysOf(
	plan: DeliveryPartitionPlan,
	collection: string,
	snapshot: OperationScopeSnapshot | null,
): bigint[] {
	const keys = new Map<string, bigint>()
	const add = (key: bigint): void => {
		keys.set(key.toString(), key)
	}
	const list = plan.fields.get(collection)
	// No partition field: every read of the collection is collection-wide (a scope on any
	// field is a miss), so a row per operation would never be read.
	if (!list || list.length === 0) return []
	if (snapshot === null) {
		add(unknownPartitionKey(collection))
		return [...keys.values()]
	}
	if (snapshot.post === null) add(unknownPartitionKey(collection))
	for (const image of [snapshot.pre, snapshot.post]) {
		if (image === null) continue
		for (const field of list) {
			if (!Object.prototype.hasOwnProperty.call(image, field)) {
				// Snapshot gap (RT-20): captured before this field existed.
				add(unknownPartitionKey(collection))
				continue
			}
			add(partitionKey(collection, field, image[field]))
		}
	}
	if (keys.size === 0) add(unknownPartitionKey(collection))
	return [...keys.values()]
}

/** A scope that constrains a field `P(c)` does not contain. */
export interface PartitionMiss {
	collection: string
	field: string
}

/**
 * Sources for reading `collection` under `scope`.
 *
 * For each branch of the scope one partition field it constrains by equality or `$in`
 * (the first in `P(c)` order) gives that field's value keys, plus the unknown key. A
 * branch that constrains no partition field makes the whole collection a source (a
 * superset). A branch that constrains only fields outside `P(c)` is a miss: the
 * collection is read whole and the miss is reported, so the developer can declare
 * `scope` or `deliveryPartitions`.
 *
 * @param plan - The partition plan
 * @param collection - The collection
 * @param scope - The collection's scope for the session; null or an empty branch list reads nothing
 * @returns Sources and the misses found
 */
export function deliverySourcesForScope(
	plan: DeliveryPartitionPlan,
	collection: string,
	scope: CollectionScope | null | undefined,
): { sources: DeliverySources; misses: PartitionMiss[] } {
	const keys = new Map<string, bigint>()
	const misses: PartitionMiss[] = []
	let wholeCollection = false
	const list = plan.fields.get(collection) ?? []
	for (const branch of scopeBranches(scope)) {
		const constrained = list.find((field) => Object.prototype.hasOwnProperty.call(branch, field))
		if (constrained === undefined) {
			wholeCollection = true
			for (const field of Object.keys(branch)) {
				if (!misses.some((m) => m.field === field)) misses.push({ collection, field })
			}
			continue
		}
		const predicate = branch[constrained]
		const values =
			predicate !== null && typeof predicate === 'object' && !Array.isArray(predicate)
				? ((predicate as { $in?: unknown }).$in as readonly unknown[] | undefined)
				: [predicate]
		if (!Array.isArray(values) && values !== undefined) {
			wholeCollection = true
			continue
		}
		for (const value of values ?? []) {
			const key = partitionKey(collection, constrained, value)
			keys.set(key.toString(), key)
		}
		const unknown = unknownPartitionKey(collection)
		keys.set(unknown.toString(), unknown)
	}
	return {
		sources: {
			partitionKeys: wholeCollection ? [] : [...keys.values()],
			collections: wholeCollection ? [collection] : [],
			nodeIds: [],
		},
		misses,
	}
}

/** Number of sources in a read. */
export function deliverySourceCount(sources: DeliverySources): number {
	return sources.partitionKeys.length + sources.collections.length + sources.nodeIds.length
}

/**
 * Merge ascending sequence lists into one ascending list without duplicates, at most
 * `limit` long (a k-way merge by repeated minimum; lists are short and few).
 */
export function mergeSequences(lists: readonly (readonly number[])[], limit: number): number[] {
	const cursors = lists.map(() => 0)
	const out: number[] = []
	while (out.length < limit) {
		let best: number | null = null
		for (let i = 0; i < lists.length; i++) {
			const value = lists[i]?.[cursors[i] ?? 0]
			if (value !== undefined && (best === null || value < best)) best = value
		}
		if (best === null) break
		out.push(best)
		for (let i = 0; i < lists.length; i++) {
			while ((lists[i]?.[cursors[i] ?? 0] ?? Number.POSITIVE_INFINITY) === best) {
				cursors[i] = (cursors[i] ?? 0) + 1
			}
		}
	}
	return out
}
