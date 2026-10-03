/**
 * Server authority over cross-record rules (W7 step 3).
 *
 * The fold merges ONE record. Rules that span records (Tier-2 `unique` and
 * `capacity` constraints, and referential `restrict` / `cascade` / `set-null`) cannot
 * be folded per record, so the server is their single authority:
 *
 * 1. **Ingest.** An operation that would create a violation against the committed
 *    state is refused before it is stored (`validateIncomingOperationConstraints`,
 *    judging the record as the fold would materialize it after the operation). A
 *    refused operation never enters the log, so no replica folds it.
 * 2. **Race.** Two operations validated concurrently (two sessions, two server
 *    instances) can both commit. After every commit, {@link enforceCrossRecordRules}
 *    re-checks the written record against committed state and emits **corrections**:
 *    ordinary operations authored by the server's node (so they win
 *    `server-authoritative` fields and otherwise merge by HLC like any write).
 *
 * Corrections are deterministic: their ids come from `deriveServerOpId` (keyed with the deployment secret, RT-64) over the
 * losing write and the rule, and their timestamps and data are derived from the fold
 * state, so two detectors (two sessions, two instances, a retry) produce the same
 * operation, which the log stores once. Rule ids start with
 * {@link SERVER_RULE_PREFIX}, so they can never collide with a side effect a client
 * derives for its own copy (a client copy has different content: its own node,
 * clock and sequence; it is a separate operation whose effect is idempotent under
 * the fold).
 *
 * What a correction does (exactly one winner per conflict):
 * - **unique / capacity**: the conflicting group keeps one record, chosen by the
 *   constraint's `onConflict` over the HLC of each record's write to the constrained
 *   fields (`last-write-wins`: the newest; `priority-field`: the highest priority,
 *   ties first-write-wins; every other strategy: the oldest, first-write-wins). Every
 *   other record has its losing write undone on the constrained fields: the fields go
 *   back to the values the record folds to without that write, or the record is
 *   deleted when that write created it (or its old values would still conflict).
 * - **referential, child written under a deleted parent**: `cascade` deletes the child,
 *   `set-null` clears its foreign key, `restrict` revives the parent (the delete loses:
 *   it was only allowed because the reference was not committed yet).
 * - **referential, parent deleted while a restrict child is live**: the parent is
 *   revived.
 * A revival is an update with empty data: it is a write (newer than the delete) that
 * changes no field, so the record comes back with every field's merged value.
 */
import { HybridLogicalClock, foldRecord, isFoldStateLive, materialize } from '@korajs/core'
import type {
	Constraint,
	FoldState,
	HLCTimestamp,
	Operation,
	RecordFieldVersions,
	SchemaDefinition,
} from '@korajs/core'
import { checkConstraints } from '@korajs/merge'
import { deriveServerOpId } from '../apply/derive-server-op-id'
import type { MaterializedRecord, ServerStore } from '../store/server-store'
import { createServerConstraintContext } from './server-constraint-context'

/** Prefix of every rule id the server derives side-effect and correction ids from. */
export const SERVER_RULE_PREFIX = 'server/'

/** HLC logical counter bound (matches `HybridLogicalClock.serialize`). */
const MAX_LOGICAL = 99_999

/**
 * The timestamp of a server operation that must order immediately after `base`:
 * same wall time, next logical tick, authored by `nodeId`. Deterministic (no wall
 * clock), so every detector derives the same one.
 */
export function timestampAfter(base: HLCTimestamp, nodeId: string): HLCTimestamp {
	return base.logical < MAX_LOGICAL
		? { wallTime: base.wallTime, logical: base.logical + 1, nodeId }
		: { wallTime: base.wallTime + 1, logical: 0, nodeId }
}

/** Allocates the next sequence number of the server's node. */
export type ServerSequenceAllocator = () => number

interface CorrectionSpec {
	parent: string
	rule: string
	collection: string
	recordId: string
	type: 'update' | 'delete'
	data: Record<string, unknown> | null
	previousData: Record<string, unknown> | null
	after: HLCTimestamp
}

async function buildCorrection(
	store: ServerStore,
	spec: CorrectionSpec,
	schemaVersion: number,
	nextSequence: ServerSequenceAllocator,
): Promise<Operation> {
	const nodeId = store.getNodeId()
	return {
		id: await deriveServerOpId(
			store,
			spec.parent,
			`${SERVER_RULE_PREFIX}${spec.rule}`,
			spec.recordId,
		),
		nodeId,
		type: spec.type,
		collection: spec.collection,
		recordId: spec.recordId,
		data: spec.data,
		previousData: spec.previousData,
		timestamp: timestampAfter(spec.after, nodeId),
		sequenceNumber: nextSequence(),
		causalDeps: [],
		schemaVersion,
		mutationName: `kora:correction:${spec.rule}`,
	}
}

function stampTimestamp(stamp: { t: string } | null): HLCTimestamp | null {
	return stamp ? HybridLogicalClock.deserialize(stamp.t) : null
}

function maxTimestamp(values: Array<HLCTimestamp | null | undefined>): HLCTimestamp | null {
	let best: HLCTimestamp | null = null
	for (const value of values) {
		if (value && (best === null || HybridLogicalClock.compare(value, best) > 0)) best = value
	}
	return best
}

/** The HLC of a record's newest write to any of `fields` (its creation if none). */
function constrainedVersion(versions: RecordFieldVersions, fields: string[]): HLCTimestamp {
	return maxTimestamp(fields.map((field) => versions.fields[field])) ?? versions.created
}

function comparePriority(a: unknown, b: unknown): number {
	if (typeof a === 'number' && typeof b === 'number') return a - b
	const left = String(a)
	const right = String(b)
	return left < right ? -1 : left > right ? 1 : 0
}

interface GroupMember {
	row: MaterializedRecord
	versions: RecordFieldVersions
	key: HLCTimestamp
}

/** Index of the surviving member of a conflicting group under `constraint`. */
function chooseWinner(members: GroupMember[], constraint: Constraint): GroupMember {
	const byStamp = (a: GroupMember, b: GroupMember): number =>
		HybridLogicalClock.compare(a.key, b.key) || (a.row.id < b.row.id ? -1 : 1)
	const sorted = [...members].sort(byStamp)
	if (constraint.onConflict === 'last-write-wins') return sorted[sorted.length - 1] as GroupMember
	if (constraint.onConflict === 'priority-field' && constraint.priorityField) {
		const field = constraint.priorityField
		let best = sorted[0] as GroupMember
		for (const member of sorted.slice(1)) {
			if (comparePriority(member.row[field], best.row[field]) > 0) best = member
		}
		return best
	}
	return sorted[0] as GroupMember
}

function groupWhere(
	constraint: Constraint,
	row: MaterializedRecord,
): Record<string, unknown> | null {
	const where: Record<string, unknown> =
		constraint.type === 'capacity' ? { ...constraint.where } : {}
	for (const field of constraint.fields) {
		const value = row[field]
		// A null value never conflicts (SQL UNIQUE semantics; the checker cannot match it).
		if (value === null || value === undefined) return null
		where[field] = value
	}
	return where
}

/**
 * The correction that undoes `loser`'s newest write to the constrained fields: its
 * fields go back to the values the record folds to without that write, or the record
 * is deleted when it would not exist without it (or the old values still collide with
 * the winner's).
 */
async function undoConstrainedWrite(
	store: ServerStore,
	schema: SchemaDefinition,
	collection: string,
	constraintIndex: number,
	constraint: Constraint,
	loser: GroupMember,
	winner: GroupMember,
): Promise<CorrectionSpec | null> {
	const ops = (await store.getRecordOperations?.(collection, loser.row.id)) ?? []
	const state = await store.getRecordFoldState?.(collection, loser.row.id)
	const newest = stampTimestamp(state?.u ?? null) ?? loser.key
	const parent = `hlc:${HybridLogicalClock.serialize(loser.key)}`
	const rule = `constraint:${collection}:${constraintIndex}:${constraint.type}`
	const losing = new Set(
		ops
			.filter(
				(op) =>
					HybridLogicalClock.compare(op.timestamp, loser.key) === 0 &&
					op.data !== null &&
					constraint.fields.some((field) => op.data !== null && field in op.data),
			)
			.map((op) => op.id),
	)
	const without = foldRecord(ops, schema, { exclude: losing }).state
	const previous = without && isFoldStateLive(without) ? materialize(without as FoldState) : null
	const collides =
		previous !== null &&
		constraint.fields.every((field) => sameValue(previous[field], winner.row[field]))
	if (previous === null || collides) {
		return {
			parent,
			rule,
			collection,
			recordId: loser.row.id,
			type: 'delete',
			data: null,
			previousData: null,
			after: newest,
		}
	}
	const data: Record<string, unknown> = {}
	const previousData: Record<string, unknown> = {}
	for (const field of constraint.fields) {
		data[field] = previous[field] ?? null
		previousData[field] = loser.row[field] ?? null
	}
	return {
		parent,
		rule,
		collection,
		recordId: loser.row.id,
		type: 'update',
		data,
		previousData,
		after: newest,
	}
}

function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/** Corrections for unique / capacity constraints violated by the record `op` wrote. */
async function uniqueAndCapacityCorrections(
	store: ServerStore,
	schema: SchemaDefinition,
	op: Operation,
): Promise<CorrectionSpec[]> {
	const definition = schema.collections[op.collection]
	if (!definition || op.type === 'delete') return []
	// Only constraints the operation could have violated: it created the record or wrote
	// one of the constrained fields. A write elsewhere never "fixes" legacy data.
	const crossRecord = definition.constraints.filter(
		(constraint) =>
			(constraint.type === 'unique' || constraint.type === 'capacity') &&
			(op.type === 'insert' ||
				constraint.fields.some((field) => op.data !== null && field in op.data)),
	)
	if (crossRecord.length === 0 || !store.getRecordFieldVersions) return []
	const row = await store.findRecord(op.collection, op.recordId)
	if (!row) return []
	const violations = await checkConstraints(
		row,
		op.recordId,
		op.collection,
		{ ...definition, constraints: crossRecord },
		createServerConstraintContext(store),
	)
	const specs: CorrectionSpec[] = []
	for (const violation of violations) {
		const constraint = violation.constraint
		const index = definition.constraints.indexOf(constraint)
		const where = groupWhere(constraint, row)
		if (!where) continue
		const rows = await store.queryCollection(op.collection, { where })
		const members: GroupMember[] = []
		for (const candidate of rows) {
			const versions = await store.getRecordFieldVersions(op.collection, candidate.id)
			if (!versions) continue
			members.push({
				row: candidate,
				versions,
				key: constrainedVersion(versions, constraint.fields),
			})
		}
		if (members.length < 2) continue
		const winner = chooseWinner(members, constraint)
		for (const member of members) {
			if (member === winner) continue
			const spec = await undoConstrainedWrite(
				store,
				schema,
				op.collection,
				index,
				constraint,
				member,
				winner,
			)
			if (spec) specs.push(spec)
		}
	}
	return specs
}

/** Corrections for referential rules involving the record `op` wrote. */
async function referentialCorrections(
	store: ServerStore,
	schema: SchemaDefinition,
	op: Operation,
): Promise<CorrectionSpec[]> {
	if (!store.getRecordFoldState) return []
	const specs: CorrectionSpec[] = []
	const relations = Object.entries(schema.relations ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))

	if (op.type !== 'delete') {
		// The written record as a child: does it reference a deleted parent?
		const child = await store.findRecord(op.collection, op.recordId)
		if (child) {
			for (const [name, relation] of relations) {
				if (relation.from !== op.collection || relation.onDelete === 'no-action') continue
				// Only a write that created the child or set its reference.
				if (op.type !== 'insert' && !(op.data !== null && relation.field in op.data)) continue
				const parentId = child[relation.field]
				if (typeof parentId !== 'string' || parentId.length === 0) continue
				const parent = await store.getRecordFoldState(relation.to, parentId)
				if (!parent || parent.cr === null || isFoldStateLive(parent)) continue
				const deletedAt = stampTimestamp(parent.d)
				const childState = await store.getRecordFoldState(op.collection, op.recordId)
				const after = maxTimestamp([deletedAt, stampTimestamp(childState?.u ?? null)])
				if (!after || !parent.d) continue
				// Keyed on the parent's delete AND the child's newest write: a later revival
				// of the child under the same deleted parent gets a fresh correction.
				const parentKey = `${parent.d.o}|${childState?.u?.o ?? op.id}`
				if (relation.onDelete === 'cascade') {
					specs.push({
						parent: parentKey,
						rule: `relation:${name}:cascade-late`,
						collection: op.collection,
						recordId: op.recordId,
						type: 'delete',
						data: null,
						previousData: null,
						after,
					})
				} else if (relation.onDelete === 'set-null') {
					specs.push({
						parent: parentKey,
						rule: `relation:${name}:set-null-late`,
						collection: op.collection,
						recordId: op.recordId,
						type: 'update',
						data: { [relation.field]: null },
						previousData: { [relation.field]: parentId },
						after,
					})
				} else if (relation.onDelete === 'restrict') {
					const parentAfter = maxTimestamp([deletedAt, stampTimestamp(parent.u)])
					if (!parentAfter) continue
					specs.push({
						parent: `${parent.d.o}`,
						rule: `relation:${name}:restrict-revive`,
						collection: relation.to,
						recordId: parentId,
						type: 'update',
						data: {},
						previousData: null,
						after: parentAfter,
					})
				}
			}
		}
		return specs
	}

	// The deleted record as a parent: a restrict child committed concurrently.
	const deleted = await store.getRecordFoldState(op.collection, op.recordId)
	if (!deleted || deleted.cr === null || isFoldStateLive(deleted) || !deleted.d) return specs
	for (const [name, relation] of relations) {
		if (relation.to !== op.collection || relation.onDelete !== 'restrict') continue
		const children = await store.queryCollection(relation.from, {
			where: { [relation.field]: op.recordId },
			limit: 1,
		})
		if (children.length === 0) continue
		const after = maxTimestamp([stampTimestamp(deleted.d), stampTimestamp(deleted.u)])
		if (!after) continue
		specs.push({
			parent: deleted.d.o,
			rule: `relation:${name}:restrict-revive`,
			collection: op.collection,
			recordId: op.recordId,
			type: 'update',
			data: {},
			previousData: null,
			after,
		})
	}
	return specs
}

/**
 * Re-check the cross-record rules touched by a committed operation and apply the
 * corrections they need (see the module comment for the contract). Returns the
 * corrections this call stored (a correction another detector already stored is a
 * duplicate and is not returned).
 *
 * @param store - The server store (the operation is already committed)
 * @param op - The committed operation
 * @param nextSequence - Allocates the server node's next sequence number
 */
export async function enforceCrossRecordRules(
	store: ServerStore,
	op: Operation,
	nextSequence: ServerSequenceAllocator,
): Promise<Operation[]> {
	const schema = store.getSchema()
	const definition = schema?.collections[op.collection]
	if (!schema || !definition) return []
	const involved =
		definition.constraints.some((c) => c.type === 'unique' || c.type === 'capacity') ||
		Object.values(schema.relations ?? {}).some(
			(relation) => relation.from === op.collection || relation.to === op.collection,
		)
	if (!involved) return []
	const specs = [
		...(await uniqueAndCapacityCorrections(store, schema, op)),
		...(await referentialCorrections(store, schema, op)),
	]
	const applied: Operation[] = []
	const seen = new Set<string>()
	for (const spec of specs) {
		const correction = await buildCorrection(store, spec, op.schemaVersion, nextSequence)
		if (seen.has(correction.id)) continue
		seen.add(correction.id)
		if ((await store.applyRemoteOperation(correction)) === 'applied') applied.push(correction)
	}
	return applied
}
