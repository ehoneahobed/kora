import { encodeStoredText } from '../text/stored-text'
import type { CollectionDefinition } from '../types'

/** The order direction of one `orderBy` key. */
export type QueryEvalDirection = 'asc' | 'desc'

/** One `orderBy` key of a {@link QueryEvalDescriptor}. */
export interface QueryEvalOrderBy {
	field: string
	direction: QueryEvalDirection
}

/**
 * The parts of a query descriptor the evaluator reads. The store's `QueryDescriptor` and the
 * read-through request of the sync server both satisfy it structurally, so the client (the
 * instant-updates overlay) and the server (read-through, first-visit parity S2) judge a query
 * with the same code. The relation and collection bookkeeping a descriptor may carry is not
 * part of the evaluation.
 */
export interface QueryEvalDescriptor {
	where: Record<string, unknown>
	orderBy: readonly QueryEvalOrderBy[]
	limit?: number
	offset?: number
	include?: readonly string[]
}

type QueryDescriptor = QueryEvalDescriptor
type OrderByClause = QueryEvalOrderBy

/**
 * A JavaScript evaluator for the allowlisted subset of queries the instant-UI overlay may
 * patch (docs/design/instant-ui-updates.md, sections 5.4 and 12.1). It decides, in
 * memory, what SQLite would decide for `buildSelectQuery(descriptor)`: which records
 * belong to the result (`matches`) and how two of them sort (`compare`).
 *
 * It is a prediction aid, never a source of truth. The database re-runs the real SQL after
 * every commit and its result replaces anything this module produced. The module is
 * therefore built as an allowlist: `checkPatchable` names the exact query shapes the
 * evaluator is proven equal to SQLite on (by the differential suite in
 * `query-eval.test.ts`, run against `better-sqlite3` and the SQLite WASM mock bridge), and
 * refuses everything else. Where SQLite and JavaScript disagree on an exotic input the
 * answer here is to refuse, not to emulate. The table of differences is in section 5.4 of
 * the design document.
 *
 * Records are in the read shape (`deserializeRecord`): booleans are `true`/`false`, an
 * absent value is `null`, `createdAt`/`updatedAt` are the `_created_at`/`_updated_at`
 * columns. Soft-deleted rows are not records; the caller never passes one.
 */

/** Why a query was refused. Each value names one rule of the allowlist (design 5.4). */
export const PATCH_REFUSAL_REASONS = [
	'include',
	'offset',
	'invalid-limit',
	'invalid-where',
	'unknown-field',
	'unsupported-field-kind',
	'unknown-operator',
	'operand-type-mismatch',
	'non-finite-operand',
	'unsafe-text-operand',
	'in-list-too-long',
	'invalid-direction',
] as const

/** Why a query cannot be patched. */
export type PatchRefusalReason = (typeof PATCH_REFUSAL_REASONS)[number]

/** The outcome of {@link checkPatchable}. */
export type PatchVerdict =
	| { readonly patchable: true }
	| { readonly patchable: false; readonly reason: PatchRefusalReason; readonly detail: string }

/**
 * Longest `$in` list a patchable query may carry. Evaluation cost is linear in the list
 * per record, and the overlay runs on the main thread; a longer list keeps the commit path.
 */
export const MAX_PATCHABLE_IN_LIST = 256

/** The operators the SQL builder accepts and the evaluator mirrors. */
const OPERATORS = new Set(['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in'])

/** Field kinds the evaluator compares: one SQL column holding a scalar. */
const SCALAR_KINDS: ReadonlySet<string> = new Set([
	'string',
	'number',
	'boolean',
	'enum',
	'timestamp',
])

/** Operand type each comparable kind accepts. `id` is TEXT. */
type OperandType = 'string' | 'number' | 'boolean'

/** The name a query field has when it is a virtual record-metadata column. */
const VIRTUAL_TIMESTAMP_FIELDS: ReadonlySet<string> = new Set(['createdAt', 'updatedAt'])

interface FieldInfo {
	readonly operandType: OperandType
	/** True when the column holds the stored-text codec's form (`string`), false for `enum` and `id`. */
	readonly encoded: boolean
}

/**
 * Decide whether a query may be patched in memory, and if not, why.
 *
 * A query is patchable when it has no `include`, a zero or absent `offset`, a valid
 * `limit`, every `where` and `orderBy` field is a scalar schema field (`string`,
 * `number`, `boolean`, `enum`, `timestamp`), `id`, `createdAt` or `updatedAt`, every
 * operator is one of `$eq $ne $gt $gte $lt $lte $in`, and every operand has the type of
 * its field (`null` only for `$eq`/`$ne`). The check is structural and does not look at
 * data, so it can run once when a subscription is created.
 *
 * @param descriptor - The query descriptor, as the SQL builder receives it
 * @param definition - The collection definition the query reads
 * @returns `{ patchable: true }`, or the first rule the query breaks
 */
export function checkPatchable(
	descriptor: QueryDescriptor,
	definition: CollectionDefinition,
): PatchVerdict {
	if (descriptor.include !== undefined && descriptor.include.length > 0) {
		return refuse('include', 'relations resolve through further SQL')
	}
	if (descriptor.offset !== undefined && descriptor.offset !== 0) {
		return refuse('offset', 'rows before the offset are not in memory')
	}
	if (descriptor.limit !== undefined && !isQueryCount(descriptor.limit)) {
		return refuse('invalid-limit', 'limit must be a non-negative safe integer')
	}

	const where: unknown = descriptor.where
	if (!isPlainObject(where)) {
		return refuse('invalid-where', 'where must be a plain object')
	}
	for (const [name, condition] of Object.entries(where)) {
		const info = fieldInfo(name, definition)
		if (info.refusal !== null) return info.refusal
		const verdict = checkCondition(name, condition, info.info)
		if (verdict !== null) return verdict
	}

	for (const clause of descriptor.orderBy) {
		const info = fieldInfo(clause.field, definition)
		if (info.refusal !== null) return info.refusal
		if (orderDirection(clause.direction) === null) {
			return refuse('invalid-direction', `direction for "${clause.field}" is not asc or desc`)
		}
	}

	return { patchable: true }
}

/**
 * Whether a query may be patched in memory. See {@link checkPatchable} for the reason.
 *
 * @param descriptor - The query descriptor
 * @param definition - The collection definition the query reads
 * @returns True when the evaluator is proven equal to SQLite for this query shape
 */
export function isPatchable(
	descriptor: QueryDescriptor,
	definition: CollectionDefinition,
): boolean {
	return checkPatchable(descriptor, definition).patchable
}

/**
 * Whether a live record belongs to the result of a patchable query's `WHERE` clause.
 * Mirrors SQLite: a comparison against NULL is false (except `$eq: null` and
 * `$ne: null`), so a NULL value is excluded by `$ne`, `$gt`, `$gte`, `$lt`, `$lte` and
 * `$in`. Only call it for a descriptor `isPatchable` accepted.
 *
 * @param descriptor - A patchable query descriptor
 * @param record - A live record in the read shape
 * @returns True when SQLite would return the record
 */
export function matches(
	descriptor: QueryDescriptor,
	record: Readonly<Record<string, unknown>>,
): boolean {
	const plan = planFor(descriptor)
	for (const condition of plan.conditions) {
		if (!conditionHolds(condition, normalize(record[condition.field]))) return false
	}
	return true
}

/**
 * Sort order of two records under a patchable query's `ORDER BY`: negative when `a`
 * sorts first, positive when `b` does, zero when every key ties. NULL sorts first in
 * ascending order and last in descending order, text sorts by code point (equal to
 * SQLite's UTF-8 byte order), and booleans sort as 0/1.
 *
 * A zero result means SQLite's order of the two rows is unspecified (in practice rowid
 * order, which this module does not know); the patcher must treat a tie as "not
 * patchable" (design 5.4, ties). With no `orderBy` every pair ties.
 *
 * @param descriptor - A patchable query descriptor
 * @param a - A live record in the read shape
 * @param b - A live record in the read shape
 * @returns A negative number, zero, or a positive number
 */
export function compare(
	descriptor: QueryDescriptor,
	a: Readonly<Record<string, unknown>>,
	b: Readonly<Record<string, unknown>>,
): number {
	const plan = planFor(descriptor)
	for (const key of plan.order) {
		const result = compareValues(normalize(a[key.field]), normalize(b[key.field]))
		if (result !== 0) return key.descending ? -result : result
	}
	return 0
}

// --- Internals ---

/** A value as SQLite holds it for comparison: NULL, a number, or encoded text. */
type Norm = null | number | string

interface Condition {
	readonly field: string
	readonly op: '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in'
	/** The operand (`$in`: ignored). `null` means SQL NULL. */
	readonly operand: Norm
	/** `$in` members, NULL members removed (`x IN (NULL)` is never true). */
	readonly members: ReadonlySet<Norm> | null
}

interface OrderKey {
	readonly field: string
	readonly descending: boolean
}

interface Plan {
	readonly where: unknown
	readonly orderBy: readonly OrderByClause[]
	readonly conditions: readonly Condition[]
	readonly order: readonly OrderKey[]
}

/**
 * Compiled plans, so the per-record calls do no descriptor walking. A descriptor is
 * treated as immutable (the query builder returns a new one per step); a plan is rebuilt
 * if the `where` or `orderBy` object it was built from is no longer the descriptor's.
 */
const PLANS = new WeakMap<QueryDescriptor, Plan>()

function planFor(descriptor: QueryDescriptor): Plan {
	const cached = PLANS.get(descriptor)
	if (
		cached !== undefined &&
		cached.where === descriptor.where &&
		cached.orderBy === descriptor.orderBy
	) {
		return cached
	}
	const conditions: Condition[] = []
	for (const [field, value] of Object.entries(descriptor.where)) {
		if (isPlainObject(value)) {
			for (const [op, operand] of Object.entries(value)) {
				conditions.push(buildCondition(field, op, operand))
			}
		} else {
			conditions.push(buildCondition(field, '$eq', value))
		}
	}
	const order = descriptor.orderBy.map((clause) => ({
		field: clause.field,
		descending: orderDirection(clause.direction) === 'desc',
	}))
	const plan: Plan = { where: descriptor.where, orderBy: descriptor.orderBy, conditions, order }
	PLANS.set(descriptor, plan)
	return plan
}

function buildCondition(field: string, op: string, operand: unknown): Condition {
	if (op === '$in') {
		const members = new Set<Norm>()
		if (Array.isArray(operand)) {
			for (const item of operand) {
				const value = normalize(item)
				if (value !== null) members.add(value)
			}
		}
		return { field, op: '$in', operand: null, members }
	}
	return { field, op: op as Condition['op'], operand: normalize(operand), members: null }
}

function conditionHolds(condition: Condition, value: Norm): boolean {
	const { op, operand } = condition
	if (op === '$eq') return operand === null ? value === null : value !== null && value === operand
	if (op === '$ne') return operand === null ? value !== null : value !== null && value !== operand
	// Every other operator is NULL when either side is NULL.
	if (value === null) return false
	if (op === '$in') return condition.members?.has(value) ?? false
	if (operand === null) return false
	const order = compareValues(value, operand)
	switch (op) {
		case '$gt':
			return order > 0
		case '$gte':
			return order >= 0
		case '$lt':
			return order < 0
		default:
			return order <= 0
	}
}

/**
 * The value SQLite compares. Booleans are stored 0/1; a raw-string column holds the
 * stored-text codec's form, which is injective and keeps lone surrogates, U+0000 and
 * U+FFFF exact, so comparing encoded forms is what the SQL does (design 5.4). `enum` and
 * `id` columns hold the text verbatim; for well-formed text the codec is the identity,
 * and `checkPatchable` refuses an operand for which it is not. A NaN is stored as NULL.
 */
function normalize(value: unknown): Norm {
	if (value === null || value === undefined) return null
	if (typeof value === 'boolean') return value ? 1 : 0
	if (typeof value === 'number') return Number.isNaN(value) ? null : value
	if (typeof value === 'string') return encodeStoredText(value)
	return null
}

/** SQLite's ordering across storage classes: NULL, then numbers, then text. */
function compareValues(a: Norm, b: Norm): number {
	if (a === b) return 0
	if (a === null) return -1
	if (b === null) return 1
	if (typeof a === 'number') {
		if (typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
		return -1
	}
	if (typeof b === 'number') return 1
	return compareText(a, b)
}

/**
 * Compare text by code point, which is SQLite's BINARY collation (memcmp of the UTF-8
 * bytes, then length). JavaScript's `<` compares UTF-16 code units, which orders a
 * supplementary character (a surrogate pair, 0xD800 to 0xDFFF) before U+E000 to U+FFFF,
 * the opposite of UTF-8. The input is encoded text, so surrogates are always paired.
 */
function compareText(a: string, b: string): number {
	const length = Math.min(a.length, b.length)
	for (let i = 0; i < length; i++) {
		let x = a.charCodeAt(i)
		let y = b.charCodeAt(i)
		if (x === y) continue
		if (x >= 0xd800 && y >= 0xd800) {
			// Move the surrogate range above U+E000..U+FFFF so unit order equals code point order.
			x = x >= 0xe000 ? x - 0x800 : x + 0x2000
			y = y >= 0xe000 ? y - 0x800 : y + 0x2000
		}
		return x < y ? -1 : 1
	}
	return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

function refuse(reason: PatchRefusalReason, detail: string): PatchVerdict {
	return { patchable: false, reason, detail }
}

type FieldLookup =
	| { readonly refusal: null; readonly info: FieldInfo }
	| { readonly refusal: PatchVerdict; readonly info: null }

function fieldInfo(name: string, definition: CollectionDefinition): FieldLookup {
	// A schema field wins over a virtual column of the same name (STORE-11).
	if (Object.hasOwn(definition.fields, name)) {
		const kind = definition.fields[name]?.kind
		if (kind === undefined || !SCALAR_KINDS.has(kind)) {
			return {
				refusal: refuse('unsupported-field-kind', `"${name}" is a ${String(kind)} field`),
				info: null,
			}
		}
		return { refusal: null, info: operandInfo(kind) }
	}
	if (name === 'id') return { refusal: null, info: { operandType: 'string', encoded: false } }
	if (VIRTUAL_TIMESTAMP_FIELDS.has(name)) {
		return { refusal: null, info: { operandType: 'number', encoded: false } }
	}
	return { refusal: refuse('unknown-field', `"${name}" is not a patchable field`), info: null }
}

function operandInfo(kind: string): FieldInfo {
	switch (kind) {
		case 'number':
		case 'timestamp':
			return { operandType: 'number', encoded: false }
		case 'boolean':
			return { operandType: 'boolean', encoded: false }
		case 'string':
			return { operandType: 'string', encoded: true }
		default:
			// enum
			return { operandType: 'string', encoded: false }
	}
}

function checkCondition(name: string, condition: unknown, info: FieldInfo): PatchVerdict | null {
	// Mirrors the builder: a non-null, non-array object is an operator object.
	if (condition !== null && typeof condition === 'object' && !Array.isArray(condition)) {
		if (!isPlainObject(condition)) {
			return refuse('invalid-where', `the condition on "${name}" is not a plain object`)
		}
		for (const [op, operand] of Object.entries(condition)) {
			if (!OPERATORS.has(op)) {
				return refuse('unknown-operator', `"${op}" on "${name}" is not a supported operator`)
			}
			const verdict = checkOperand(name, op, operand, info)
			if (verdict !== null) return verdict
		}
		return null
	}
	return checkOperand(name, '$eq', condition, info)
}

function checkOperand(
	name: string,
	op: string,
	operand: unknown,
	info: FieldInfo,
): PatchVerdict | null {
	if (op === '$in') {
		if (!Array.isArray(operand)) {
			return refuse('operand-type-mismatch', `$in on "${name}" needs an array`)
		}
		if (operand.length > MAX_PATCHABLE_IN_LIST) {
			return refuse('in-list-too-long', `$in on "${name}" has ${operand.length} members`)
		}
		for (const item of operand) {
			// NULL is allowed as a member and never matches (`x IN (NULL)` is NULL).
			const verdict = checkScalar(name, item, info, true)
			if (verdict !== null) return verdict
		}
		return null
	}
	return checkScalar(name, operand, info, op === '$eq' || op === '$ne')
}

function checkScalar(
	name: string,
	operand: unknown,
	info: FieldInfo,
	nullAllowed: boolean,
): PatchVerdict | null {
	if (operand === null) {
		return nullAllowed
			? null
			: refuse('operand-type-mismatch', `a range comparison on "${name}" with null is never true`)
	}
	const actual: string = typeof operand
	if (actual !== info.operandType) {
		return refuse(
			'operand-type-mismatch',
			`"${name}" compares as ${info.operandType}, got ${operand === undefined ? 'undefined' : typeof operand}`,
		)
	}
	if (typeof operand === 'number' && !Number.isFinite(operand)) {
		return refuse('non-finite-operand', `"${name}" operand ${String(operand)} has no stored form`)
	}
	if (typeof operand === 'string' && !info.encoded && !isSafeVerbatimText(operand)) {
		return refuse(
			'unsafe-text-operand',
			`"${name}" is stored verbatim and the operand holds a lone surrogate or U+0000`,
		)
	}
	return null
}

/**
 * Text a verbatim column (`enum`, `id`) can hold and bind exactly: no U+0000 (SQLite WASM
 * reads TEXT up to a NUL) and no lone surrogate (UTF-8 binding replaces it with U+FFFD).
 */
function isSafeVerbatimText(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i)
		if (code === 0) return false
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1)
			if (!(next >= 0xdc00 && next <= 0xdfff)) return false
			i++
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			return false
		}
	}
	return true
}

function orderDirection(direction: unknown): 'asc' | 'desc' | null {
	// The SQL builder lower-cases the direction before matching it.
	const key = typeof direction === 'string' ? direction.toLowerCase() : ''
	return key === 'asc' || key === 'desc' ? key : null
}

function isQueryCount(value: unknown): boolean {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype: unknown = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}
