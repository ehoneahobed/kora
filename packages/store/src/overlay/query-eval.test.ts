import { fc } from '@fast-check/vitest'
import { generateSQL } from '@korajs/core'
import type { CollectionDefinition, FieldDescriptor, SchemaDefinition } from '@korajs/core'
import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'
import { SqliteWasmAdapter } from '../adapters/sqlite-wasm-adapter'
import { MockWorkerBridge } from '../adapters/sqlite-wasm-mock-bridge'
import { buildInsertQuery, buildSelectQuery } from '../query/sql-builder'
import { deserializeRecord, serializeRecord } from '../serialization/serializer'
import type { OrderByDirection, QueryDescriptor, RawCollectionRow } from '../types'
import {
	MAX_PATCHABLE_IN_LIST,
	type PatchRefusalReason,
	checkPatchable,
	compare,
	isPatchable,
	matches,
} from './query-eval'

/**
 * Differential tests of the overlay query evaluator against SQLite (design 12.1).
 *
 * fast-check generates a collection (field kinds from the allowlist, plus kinds that must
 * be refused), rows full of the values where SQL and JavaScript differ (NULL, empty and
 * non-BMP strings, lone surrogates, NUL, U+FFFF, -0, huge and tiny doubles, ties), and
 * query descriptors (every operator, 0 to 3 sort keys, limit). Each case runs the real
 * `buildSelectQuery` against SQLite and the evaluator against the same rows, and asserts
 * equal membership, equal order (ties compared as sets) and a correct `limit` page. The
 * same seed drives two engines: `better-sqlite3` directly, and `SqliteWasmAdapter` over
 * the mock worker bridge (the adapter's real schema DDL and bind path).
 *
 * Environment:
 * - KORA_QUERY_EVAL_CASES: comparisons per engine (default 10000; nightly sets more)
 * - KORA_QUERY_EVAL_SEED: fast-check seed (default: random, printed on failure)
 */

const CASES = positiveInt(process.env.KORA_QUERY_EVAL_CASES, 10_000)
const SEED = positiveInt(process.env.KORA_QUERY_EVAL_SEED, Math.floor(Math.random() * 2 ** 31))
/** Descriptors compared per generated collection and dataset. */
const QUERIES_PER_DATASET = 5
const COLLECTION = 'items'

function positiveInt(raw: string | undefined, fallback: number): number {
	const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10)
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

// --- Schema and data generation ---

type ScalarKind = 'string' | 'number' | 'boolean' | 'enum' | 'timestamp'
type RefusedKind = 'array' | 'object' | 'json' | 'richtext' | 'blob' | 'secret'

interface FieldSpec {
	name: string
	kind: ScalarKind | RefusedKind
	enumValues: string[]
}

function descriptorFor(spec: FieldSpec): FieldDescriptor {
	return {
		kind: spec.kind,
		required: false,
		defaultValue: undefined,
		auto: false,
		enumValues: spec.kind === 'enum' ? spec.enumValues : null,
		itemKind: spec.kind === 'array' ? 'string' : null,
		mergeStrategy: null,
		transitions: null,
	}
}

function definitionFor(specs: readonly FieldSpec[]): CollectionDefinition {
	const fields: Record<string, FieldDescriptor> = {}
	for (const spec of specs) fields[spec.name] = descriptorFor(spec)
	return { fields, indexes: [], constraints: [], resolvers: {}, scope: [] }
}

function schemaFor(definition: CollectionDefinition): SchemaDefinition {
	return { version: 1, collections: { [COLLECTION]: definition }, relations: {}, migrations: {} }
}

const STRING_POOL = [
	'',
	'a',
	'A',
	'b',
	'B',
	'ab',
	'abc',
	'a b',
	' ',
	'5',
	'10',
	'9',
	'1e3',
	'é',
	'é',
	'z',
	'\u007f',
	'\u0080',
	'߿',
	'ࠀ',
	'퟿',
	'',
	'～',
	'�',
	'￾',
	'￿',
	'￿0',
	'￿F',
	'\u{10000}',
	'\u{1f600}',
	'\u{10ffff}',
	'a\u0000',
	'a\u0000b',
	'\u0000',
	'\ud800',
	'\udc00',
	'\ud800a',
	'a\udc00',
	'x\u{1f600}y',
]

/** Enum values SQL stores verbatim: well-formed text only (`t.enum` refuses the rest). */
const ENUM_POOL = ['low', 'medium', 'high', 'Low', 'a', 'é', '～', '\u{1f600}', '', 'zz']

const NUMBER_POOL = [
	0,
	-0,
	1,
	-1,
	2,
	10,
	9,
	0.5,
	-0.5,
	0.1,
	0.2,
	0.1 + 0.2,
	1e-7,
	5e-324,
	-5e-324,
	1e21,
	-1e21,
	Number.MAX_VALUE,
	-Number.MAX_VALUE,
	2 ** 31,
	-(2 ** 31),
	2 ** 32,
	2 ** 53,
	-(2 ** 53),
	2 ** 53 + 2,
	2 ** 62,
	2 ** 63,
	1e15 + 0.5,
]

const TIMESTAMP_POOL = [
	0,
	1,
	-1,
	1000,
	1_700_000_000_000,
	8.64e15,
	-8.64e15,
	Number.MAX_SAFE_INTEGER,
	Number.MIN_SAFE_INTEGER,
	2 ** 31,
	1.5,
]

const FIELD_NAMES = ['title', 'count', 'done', 'kind', 'at', 'order', 'createdAt', 'note', 'tags']

const stringArb: fc.Arbitrary<string> = fc.oneof(
	{ weight: 6, arbitrary: fc.constantFrom(...STRING_POOL) },
	{ weight: 2, arbitrary: fc.string({ unit: 'binary', maxLength: 4 }) },
	{ weight: 2, arbitrary: fc.string({ unit: 'grapheme-ascii', maxLength: 3 }) },
)
const numberArb: fc.Arbitrary<number> = fc.oneof(
	{ weight: 6, arbitrary: fc.constantFrom(...NUMBER_POOL) },
	{ weight: 2, arbitrary: fc.integer({ min: -5, max: 5 }) },
	{ weight: 2, arbitrary: fc.double({ noNaN: true, noDefaultInfinity: true }) },
)
const timestampArb: fc.Arbitrary<number> = fc.oneof(
	{ weight: 5, arbitrary: fc.constantFrom(...TIMESTAMP_POOL) },
	{ weight: 5, arbitrary: fc.integer({ min: -4, max: 4 }) },
	{ weight: 2, arbitrary: fc.integer({ min: -8.64e15, max: 8.64e15 }) },
)

const specsArb: fc.Arbitrary<FieldSpec[]> = fc
	.uniqueArray(fc.constantFrom(...FIELD_NAMES), { minLength: 1, maxLength: 5 })
	.chain((names) =>
		fc.tuple(
			...names.map((name) =>
				fc
					.constantFrom<ScalarKind | RefusedKind>(
						'string',
						'string',
						'number',
						'number',
						'boolean',
						'enum',
						'enum',
						'timestamp',
						'timestamp',
						'array',
						'json',
						'richtext',
					)
					.map((kind): FieldSpec => ({ name, kind, enumValues: ENUM_POOL })),
			),
		),
	)

function nullable<T>(arbitrary: fc.Arbitrary<T>): fc.Arbitrary<T | null> {
	return fc.oneof({ weight: 1, arbitrary: fc.constant(null) }, { weight: 4, arbitrary })
}

function valueArb(spec: FieldSpec): fc.Arbitrary<unknown> {
	switch (spec.kind) {
		case 'string':
			return nullable(stringArb)
		case 'number':
			return nullable(numberArb)
		case 'timestamp':
			return nullable(timestampArb)
		case 'boolean':
			return nullable(fc.boolean())
		case 'enum':
			return nullable(fc.constantFrom(...spec.enumValues))
		default:
			// Refused kinds are never compared; their column stays NULL.
			return fc.constant(null)
	}
}

interface RowData {
	id: string
	values: Record<string, unknown>
	createdAt: number
	updatedAt: number
	deleted: boolean
}

interface Dataset {
	specs: FieldSpec[]
	rows: RowData[]
}

const idArb: fc.Arbitrary<string> = fc.string({
	unit: fc.constantFrom('a', 'b', 'c', '0', '1', 'é', '\u{1f600}', '～', '-'),
	minLength: 1,
	maxLength: 3,
})
const metaTimeArb: fc.Arbitrary<number> = fc.oneof(
	{ weight: 6, arbitrary: fc.integer({ min: -3, max: 3 }) },
	{ weight: 2, arbitrary: fc.constantFrom(...TIMESTAMP_POOL) },
)

const datasetArb: fc.Arbitrary<Dataset> = specsArb.chain((specs) => {
	const rowArb = fc.record({
		values: fc.record(Object.fromEntries(specs.map((spec) => [spec.name, valueArb(spec)]))),
		createdAt: metaTimeArb,
		updatedAt: metaTimeArb,
		deleted: fc.oneof(
			{ weight: 8, arbitrary: fc.constant(false) },
			{ weight: 1, arbitrary: fc.constant(true) },
		),
	})
	return fc
		.uniqueArray(fc.tuple(idArb, rowArb), {
			minLength: 0,
			maxLength: 22,
			selector: ([id]) => id,
		})
		.map((rows) => ({
			specs,
			rows: rows.map(([id, row]) => ({ id, ...row })),
		}))
})

// --- Query generation ---

type Operator = '$eq' | '$ne' | '$gt' | '$gte' | '$lt' | '$lte' | '$in'
const OPERATOR_LIST: readonly Operator[] = ['$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in']
const RANGE_OPERATORS: readonly Operator[] = ['$gt', '$gte', '$lt', '$lte']

type OperandKind = 'string' | 'number' | 'boolean' | 'enum' | 'id'

/** The kind a query field compares as, honoring a schema field that shadows `createdAt`. */
function queryFieldKind(
	specs: readonly FieldSpec[],
	name: string,
): ScalarKind | RefusedKind | 'id' {
	const spec = specs.find((candidate) => candidate.name === name)
	if (spec !== undefined) return spec.kind
	if (name === 'id') return 'id'
	return 'timestamp'
}

function patchableFieldNames(dataset: Dataset): string[] {
	const names = dataset.specs
		.filter((spec) => ['string', 'number', 'boolean', 'enum', 'timestamp'].includes(spec.kind))
		.map((spec) => spec.name)
	names.push('id')
	for (const virtual of ['createdAt', 'updatedAt']) {
		if (!names.includes(virtual) && !dataset.specs.some((spec) => spec.name === virtual)) {
			names.push(virtual)
		}
	}
	return names
}

/** A value to compare with: usually one a row holds (so it can match), else a pool member. */
function operandArb(dataset: Dataset, name: string): fc.Arbitrary<unknown> {
	const kind = queryFieldKind(dataset.specs, name)
	const present: unknown[] = dataset.rows
		.map((row) => {
			if (name === 'id') return row.id
			if (name === 'createdAt' && !dataset.specs.some((s) => s.name === name)) return row.createdAt
			if (name === 'updatedAt' && !dataset.specs.some((s) => s.name === name)) return row.updatedAt
			return row.values[name]
		})
		.filter((value) => value !== null && value !== undefined)
	const fromRows: fc.Arbitrary<unknown>[] = present.length > 0 ? [fc.constantFrom(...present)] : []
	let fresh: fc.Arbitrary<unknown>
	switch (kind) {
		case 'string':
			fresh = stringArb
			break
		case 'enum':
			fresh = fc.constantFrom(...ENUM_POOL, 'not-a-member')
			break
		case 'id':
			fresh = idArb
			break
		case 'boolean':
			fresh = fc.boolean()
			break
		case 'number':
			fresh = numberArb
			break
		default:
			fresh = timestampArb
	}
	return fc.oneof(
		{ weight: fromRows.length > 0 ? 5 : 0, arbitrary: fromRows[0] ?? fc.constant(null) },
		{ weight: 4, arbitrary: fresh },
	)
}

function conditionArb(dataset: Dataset, name: string): fc.Arbitrary<unknown> {
	const operand = operandArb(dataset, name)
	const operatorEntry: fc.Arbitrary<[Operator, unknown]> = fc.oneof(
		fc.tuple(
			fc.constantFrom<Operator>('$eq', '$ne'),
			fc.oneof({ weight: 6, arbitrary: operand }, { weight: 1, arbitrary: fc.constant(null) }),
		),
		fc.tuple(fc.constantFrom(...RANGE_OPERATORS), operand),
		fc.tuple(
			fc.constant<Operator>('$in'),
			fc.array(
				fc.oneof({ weight: 8, arbitrary: operand }, { weight: 1, arbitrary: fc.constant(null) }),
				{
					maxLength: 5,
				},
			),
		),
	)
	return fc.oneof(
		// Shorthand: `{ field: value }` means `$eq`.
		{ weight: 3, arbitrary: operand },
		{
			weight: 5,
			arbitrary: fc
				.array(operatorEntry, { minLength: 0, maxLength: 3 })
				.map((entries) => Object.fromEntries(entries)),
		},
	)
}

const directionArb: fc.Arbitrary<OrderByDirection> = fc.constantFrom('asc', 'desc')

/** A query inside the allowlist, built to be patchable by construction. */
function patchableDescriptorArb(dataset: Dataset): fc.Arbitrary<QueryDescriptor> {
	const names = patchableFieldNames(dataset)
	const nameArb = fc.constantFrom(...names)
	return fc
		.record({
			where: fc
				.uniqueArray(nameArb, { maxLength: 3 })
				.chain((fieldNames) =>
					fc
						.tuple(...fieldNames.map((name) => conditionArb(dataset, name)))
						.map((conditions) =>
							Object.fromEntries(fieldNames.map((name, index) => [name, conditions[index]])),
						),
				),
			orderBy: fc.array(fc.record({ field: nameArb, direction: directionArb }), { maxLength: 3 }),
			limit: fc.oneof(
				{ weight: 3, arbitrary: fc.constant(undefined) },
				{ weight: 2, arbitrary: fc.integer({ min: 0, max: 14 }) },
			),
			offset: fc.constantFrom(undefined, 0),
		})
		.map(({ where, orderBy, limit, offset }) => {
			const descriptor: QueryDescriptor = { collection: COLLECTION, where, orderBy }
			if (limit !== undefined) descriptor.limit = limit
			if (offset !== undefined) descriptor.offset = offset
			return descriptor
		})
}

// --- Engines ---

interface Engine {
	insert(sql: string, params: unknown[]): Promise<void>
	query(sql: string, params: unknown[]): Promise<RawCollectionRow[]>
	close(): Promise<void>
}

async function openBetterSqlite3(schema: SchemaDefinition): Promise<Engine> {
	const db = new Database(':memory:')
	const definition = schema.collections[COLLECTION]
	if (definition === undefined) throw new Error('test schema has no collection')
	for (const statement of generateSQL(COLLECTION, definition)) {
		if (!statement.startsWith('--kora:')) db.exec(statement)
	}
	return {
		insert: async (sql, params) => {
			db.prepare(sql).run(...params)
		},
		query: async (sql, params) => db.prepare(sql).all(...params) as RawCollectionRow[],
		close: async () => {
			db.close()
		},
	}
}

async function openWasmMock(schema: SchemaDefinition): Promise<Engine> {
	const adapter = new SqliteWasmAdapter({ bridge: new MockWorkerBridge() })
	await adapter.open(schema)
	return {
		insert: (sql, params) => adapter.execute(sql, params),
		query: (sql, params) => adapter.query<RawCollectionRow>(sql, params),
		close: () => adapter.close(),
	}
}

async function loadDataset(engine: Engine, definition: CollectionDefinition, dataset: Dataset) {
	for (const row of dataset.rows) {
		const record: Record<string, unknown> = {
			id: row.id,
			...serializeRecord(row.values, definition.fields),
			_created_at: row.createdAt,
			_updated_at: row.updatedAt,
			_deleted: row.deleted ? 1 : 0,
		}
		const { sql, params } = buildInsertQuery(COLLECTION, record)
		await engine.insert(sql, params)
	}
}

// --- The differential check ---

type Rec = Record<string, unknown>

function canonicalKeyValue(value: unknown): string {
	if (value === null || value === undefined) return 'N'
	if (typeof value === 'number') return `n${Object.is(value, -0) ? 0 : value}`
	return `${typeof value}:${String(value)}`
}

function sortKey(descriptor: QueryDescriptor, record: Rec): string {
	return JSON.stringify(descriptor.orderBy.map((clause) => canonicalKeyValue(record[clause.field])))
}

interface Group {
	key: string
	ids: string[]
}

function groupByKey(descriptor: QueryDescriptor, records: readonly Rec[]): Group[] {
	const groups: Group[] = []
	for (const record of records) {
		const key = sortKey(descriptor, record)
		const last = groups[groups.length - 1]
		if (last !== undefined && last.key === key) last.ids.push(String(record.id))
		else groups.push({ key, ids: [String(record.id)] })
	}
	return groups
}

function describeCase(
	descriptor: QueryDescriptor,
	sql: string,
	params: unknown[],
	extra: string,
): string {
	return `${extra}\nSQL: ${sql}\nparams: ${JSON.stringify(params)}\ndescriptor: ${JSON.stringify(descriptor)}`
}

/** Throws a descriptive error on the first disagreement between SQLite and the evaluator. */
async function checkAgainstSql(
	engine: Engine,
	definition: CollectionDefinition,
	live: readonly Rec[],
	descriptor: QueryDescriptor,
): Promise<void> {
	const verdict = checkPatchable(descriptor, definition)
	if (!verdict.patchable) {
		throw new Error(
			`generator built a patchable query that was refused (${verdict.reason}: ${verdict.detail})\n${JSON.stringify(descriptor)}`,
		)
	}
	const { sql, params } = buildSelectQuery(descriptor, definition.fields)
	const raw = await engine.query(sql, params)
	const fromSql: Rec[] = raw.map((row) => deserializeRecord(row, definition.fields))

	const matched = live.filter((record) => matches(descriptor, record))
	const ordered = [...matched].sort((a, b) => compare(descriptor, a, b))
	const limit = descriptor.limit

	const expectedCount = limit === undefined ? matched.length : Math.min(limit, matched.length)
	if (fromSql.length !== expectedCount) {
		throw new Error(
			describeCase(
				descriptor,
				sql,
				params,
				`membership: SQLite returned ${fromSql.length} rows, evaluator expects ${expectedCount}\nsql ids: ${JSON.stringify(fromSql.map((r) => r.id))}\neval ids: ${JSON.stringify(matched.map((r) => r.id))}`,
			),
		)
	}

	// SQLite's own order must satisfy `compare` pairwise, including under a limit.
	for (let i = 1; i < fromSql.length; i++) {
		const previous = fromSql[i - 1]
		const next = fromSql[i]
		if (previous !== undefined && next !== undefined && compare(descriptor, previous, next) > 0) {
			throw new Error(
				describeCase(
					descriptor,
					sql,
					params,
					`order: compare(${String(previous.id)}, ${String(next.id)}) > 0 but SQLite returned them in that order`,
				),
			)
		}
	}

	const sqlGroups = groupByKey(descriptor, fromSql)
	const fullGroups = groupByKey(descriptor, ordered)
	for (let g = 0; g < sqlGroups.length; g++) {
		const sqlGroup = sqlGroups[g]
		const fullGroup = fullGroups[g]
		if (sqlGroup === undefined || fullGroup === undefined || sqlGroup.key !== fullGroup.key) {
			throw new Error(
				describeCase(
					descriptor,
					sql,
					params,
					`order: sort key sequence differs at group ${g}\nSQLite: ${JSON.stringify(sqlGroups)}\neval: ${JSON.stringify(fullGroups)}`,
				),
			)
		}
		const isLastPartialGroup = limit !== undefined && g === sqlGroups.length - 1
		const sqlIds = [...sqlGroup.ids].sort()
		const fullIds = [...fullGroup.ids].sort()
		const same =
			sqlIds.length === fullIds.length && sqlIds.every((id, index) => id === fullIds[index])
		// The group a `limit` cuts through may hold any subset of its tied rows.
		const ok = same || (isLastPartialGroup && sqlIds.every((id) => fullIds.includes(id)))
		if (!ok) {
			throw new Error(
				describeCase(
					descriptor,
					sql,
					params,
					`membership or tie group differs at group ${g}\nSQLite: ${JSON.stringify(sqlGroups)}\neval: ${JSON.stringify(fullGroups)}`,
				),
			)
		}
	}
}

async function runDifferential(
	open: (schema: SchemaDefinition) => Promise<Engine>,
): Promise<number> {
	let compared = 0
	const runs = Math.ceil(CASES / QUERIES_PER_DATASET)
	await fc.assert(
		fc.asyncProperty(
			datasetArb.chain((dataset) =>
				fc.tuple(
					fc.constant(dataset),
					fc.array(patchableDescriptorArb(dataset), {
						minLength: QUERIES_PER_DATASET,
						maxLength: QUERIES_PER_DATASET,
					}),
				),
			),
			async ([dataset, descriptors]) => {
				const definition = definitionFor(dataset.specs)
				const engine = await open(schemaFor(definition))
				try {
					await loadDataset(engine, definition, dataset)
					const liveRaw = await engine.query(`SELECT * FROM "${COLLECTION}" WHERE _deleted = 0`, [])
					const live: Rec[] = liveRaw.map((row) => deserializeRecord(row, definition.fields))
					for (const descriptor of descriptors) {
						await checkAgainstSql(engine, definition, live, descriptor)
						compared++
					}
				} finally {
					await engine.close()
				}
			},
		),
		{ numRuns: runs, seed: SEED, endOnFailure: false },
	)
	return compared
}

describe(`overlay query evaluator vs SQLite (seed ${SEED}, ${CASES} cases per engine)`, () => {
	test('better-sqlite3: membership, order and limit pages agree', async () => {
		const compared = await runDifferential(openBetterSqlite3)
		expect(compared).toBeGreaterThanOrEqual(CASES)
	}, 600_000)

	test('SQLite WASM mock bridge (adapter DDL and bind path): same cases agree', async () => {
		const compared = await runDifferential(openWasmMock)
		expect(compared).toBeGreaterThanOrEqual(CASES)
	}, 600_000)
})

// --- Refusals: every rule fires for the right reason ---

interface Refusal {
	descriptor: QueryDescriptor
	reason: PatchRefusalReason
	/** True when the real SQL builder also rejects it (or SQLite fails), so refusal is not hiding a working query. */
	builderThrows: boolean
}

const REFUSAL_DEFINITION = definitionFor([
	{ name: 'title', kind: 'string', enumValues: [] },
	{ name: 'count', kind: 'number', enumValues: [] },
	{ name: 'done', kind: 'boolean', enumValues: [] },
	{ name: 'kind', kind: 'enum', enumValues: ENUM_POOL },
	{ name: 'at', kind: 'timestamp', enumValues: [] },
	{ name: 'tags', kind: 'array', enumValues: [] },
	{ name: 'meta', kind: 'json', enumValues: [] },
	{ name: 'body', kind: 'richtext', enumValues: [] },
	{ name: 'file', kind: 'blob', enumValues: [] },
	{ name: 'pin', kind: 'secret', enumValues: [] },
	{ name: 'cfg', kind: 'object', enumValues: [] },
])

function base(overrides: Partial<QueryDescriptor> = {}): QueryDescriptor {
	return { collection: COLLECTION, where: {}, orderBy: [], ...overrides }
}

/** Each faulty query has exactly one fault, so the expected reason is unambiguous. */
const REFUSALS: Array<[string, Refusal]> = [
	[
		'include',
		{ descriptor: base({ include: ['project'] }), reason: 'include', builderThrows: false },
	],
	[
		'offset 5',
		{ descriptor: base({ offset: 5, limit: 3 }), reason: 'offset', builderThrows: false },
	],
	[
		'negative limit',
		{ descriptor: base({ limit: -1 }), reason: 'invalid-limit', builderThrows: true },
	],
	[
		'fractional limit',
		{ descriptor: base({ limit: 1.5 }), reason: 'invalid-limit', builderThrows: true },
	],
	[
		'NaN limit',
		{ descriptor: base({ limit: Number.NaN }), reason: 'invalid-limit', builderThrows: true },
	],
	[
		'where on a Date',
		{
			descriptor: base({ where: { at: new Date(0) } }),
			reason: 'invalid-where',
			builderThrows: false,
		},
	],
	[
		'unknown field in where',
		{ descriptor: base({ where: { nope: 1 } }), reason: 'unknown-field', builderThrows: true },
	],
	[
		'unknown field in orderBy',
		{
			descriptor: base({ orderBy: [{ field: 'nope', direction: 'asc' }] }),
			reason: 'unknown-field',
			builderThrows: true,
		},
	],
	[
		'raw system column in where',
		{
			descriptor: base({ where: { _created_at: { $gt: 1 } } }),
			reason: 'unknown-field',
			builderThrows: false,
		},
	],
	[
		'array field in where',
		{
			descriptor: base({ where: { tags: 'x' } }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'json field in orderBy',
		{
			descriptor: base({ orderBy: [{ field: 'meta', direction: 'asc' }] }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'richtext field in where',
		{
			descriptor: base({ where: { body: null } }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'blob field in where',
		{
			descriptor: base({ where: { file: { $ne: null } } }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'secret field in where',
		{
			descriptor: base({ where: { pin: 'x' } }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'object field in where',
		{
			descriptor: base({ where: { cfg: null } }),
			reason: 'unsupported-field-kind',
			builderThrows: false,
		},
	],
	[
		'$like',
		{
			descriptor: base({ where: { title: { $like: 'a%' } } }),
			reason: 'unknown-operator',
			builderThrows: true,
		},
	],
	[
		'$nin',
		{
			descriptor: base({ where: { count: { $nin: [1] } } }),
			reason: 'unknown-operator',
			builderThrows: true,
		},
	],
	[
		'string operand on a number',
		{
			descriptor: base({ where: { count: '5' } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'number operand on a string',
		{
			descriptor: base({ where: { title: 5 } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'number operand on a boolean',
		{
			descriptor: base({ where: { done: 1 } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'boolean operand on a number',
		{
			descriptor: base({ where: { count: { $gt: true } } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'string operand on a timestamp',
		{
			descriptor: base({ where: { at: { $lt: '9' } } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'null with a range operator',
		{
			descriptor: base({ where: { count: { $gt: null } } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'undefined operand',
		{
			descriptor: base({ where: { title: undefined } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'array shorthand',
		{
			descriptor: base({ where: { title: ['a'] } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'object operand',
		{
			descriptor: base({ where: { title: { $eq: { a: 1 } } } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'$in without an array',
		{
			descriptor: base({ where: { count: { $in: 5 } } }),
			reason: 'operand-type-mismatch',
			builderThrows: true,
		},
	],
	[
		'$in with a wrong member',
		{
			descriptor: base({ where: { count: { $in: [1, 'x'] } } }),
			reason: 'operand-type-mismatch',
			builderThrows: false,
		},
	],
	[
		'NaN operand',
		{
			descriptor: base({ where: { count: Number.NaN } }),
			reason: 'non-finite-operand',
			builderThrows: false,
		},
	],
	[
		'Infinity operand',
		{
			descriptor: base({ where: { at: { $lt: Number.POSITIVE_INFINITY } } }),
			reason: 'non-finite-operand',
			builderThrows: false,
		},
	],
	[
		'lone surrogate enum operand',
		{
			descriptor: base({ where: { kind: '\ud800' } }),
			reason: 'unsafe-text-operand',
			builderThrows: false,
		},
	],
	[
		'NUL in an id operand',
		{
			descriptor: base({ where: { id: 'a\u0000b' } }),
			reason: 'unsafe-text-operand',
			builderThrows: false,
		},
	],
	[
		'lone surrogate in an enum $in',
		{
			descriptor: base({ where: { kind: { $in: ['low', 'x\udc00'] } } }),
			reason: 'unsafe-text-operand',
			builderThrows: false,
		},
	],
	[
		'$in list over the cap',
		{
			descriptor: base({
				where: { count: { $in: Array.from({ length: MAX_PATCHABLE_IN_LIST + 1 }, (_, i) => i) } },
			}),
			reason: 'in-list-too-long',
			builderThrows: false,
		},
	],
	[
		'invalid direction',
		{
			descriptor: base({
				orderBy: [{ field: 'count', direction: 'sideways' as unknown as OrderByDirection }],
			}),
			reason: 'invalid-direction',
			builderThrows: true,
		},
	],
]

describe('checkPatchable refusals', () => {
	test.each(REFUSALS)('refuses %s for the right reason', (_name, refusal) => {
		const verdict = checkPatchable(refusal.descriptor, REFUSAL_DEFINITION)
		expect(verdict.patchable).toBe(false)
		if (!verdict.patchable) expect(verdict.reason).toBe(refusal.reason)
		expect(isPatchable(refusal.descriptor, REFUSAL_DEFINITION)).toBe(false)
		if (refusal.builderThrows) {
			expect(() => buildSelectQuery(refusal.descriptor, REFUSAL_DEFINITION.fields)).toThrow()
		}
	})

	test('every refusal reason is exercised by at least one case', () => {
		const exercised = new Set(REFUSALS.map(([, refusal]) => refusal.reason))
		for (const reason of [
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
		] as const) {
			expect(exercised.has(reason)).toBe(true)
		}
	})

	test('accepts the supported shapes', () => {
		const accepted: QueryDescriptor[] = [
			base(),
			base({
				where: { title: 'a', count: { $gte: 1, $lt: 5 }, done: false, kind: { $in: ['low'] } },
			}),
			base({ where: { title: null, count: { $ne: null }, id: 'x', at: { $gt: 0 } } }),
			base({ where: { createdAt: { $gt: 1 }, updatedAt: { $lte: 9 } } }),
			base({
				orderBy: [
					{ field: 'count', direction: 'desc' },
					{ field: 'id', direction: 'asc' },
				],
				limit: 0,
			}),
			base({ offset: 0, include: [] }),
			// The SQL builder lower-cases the direction.
			base({ orderBy: [{ field: 'count', direction: 'DESC' as unknown as OrderByDirection }] }),
		]
		for (const descriptor of accepted) {
			expect(checkPatchable(descriptor, REFUSAL_DEFINITION)).toEqual({ patchable: true })
		}
	})

	test('a schema field named createdAt shadows the virtual column', () => {
		const shadowed = definitionFor([{ name: 'createdAt', kind: 'string', enumValues: [] }])
		expect(isPatchable(base({ where: { createdAt: 'x' } }), shadowed)).toBe(true)
		expect(isPatchable(base({ where: { createdAt: 5 } }), shadowed)).toBe(false)
		expect(isPatchable(base({ where: { createdAt: 5 } }), REFUSAL_DEFINITION)).toBe(true)
	})
})

describe('documented SQL/JS differences (design 5.4)', () => {
	const todo = (fields: Rec): Rec => ({ id: 'x', createdAt: 1, updatedAt: 1, ...fields })

	test('$ne on NULL excludes the row; $ne: null and $eq: null use IS NOT NULL / IS NULL', () => {
		expect(matches(base({ where: { title: { $ne: 'a' } } }), todo({ title: null }))).toBe(false)
		expect(matches(base({ where: { title: { $ne: null } } }), todo({ title: null }))).toBe(false)
		expect(matches(base({ where: { title: { $ne: null } } }), todo({ title: 'a' }))).toBe(true)
		expect(matches(base({ where: { title: null } }), todo({ title: null }))).toBe(true)
		expect(matches(base({ where: { title: { $eq: null } } }), todo({ title: 'a' }))).toBe(false)
	})

	test('range comparisons and $in on NULL exclude the row', () => {
		for (const op of ['$gt', '$gte', '$lt', '$lte'] as const) {
			expect(matches(base({ where: { count: { [op]: 1 } } }), todo({ count: null }))).toBe(false)
		}
		expect(matches(base({ where: { count: { $in: [1, null] } } }), todo({ count: null }))).toBe(
			false,
		)
	})

	test('text sorts by code point, not by UTF-16 code unit', () => {
		const d = base({ orderBy: [{ field: 'title', direction: 'asc' }] })
		// U+10000 is the surrogate pair D800 DC00: after U+FF5E in UTF-8, before it in UTF-16.
		expect(compare(d, todo({ title: '～' }), todo({ title: '\u{10000}' }))).toBeLessThan(0)
		expect('～' > '\u{10000}').toBe(true)
	})

	test('escaped strings sort by the stored form (NUL, U+FFFF, lone surrogate)', () => {
		const d = base({ orderBy: [{ field: 'title', direction: 'asc' }] })
		// Stored "a" + U+FFFF + "0" sorts after "ab", while JavaScript puts "a\0" before it.
		expect(compare(d, todo({ title: 'ab' }), todo({ title: 'a\u0000' }))).toBeLessThan(0)
		expect(matches(base({ where: { title: 'a\u0000' } }), todo({ title: 'a\u0000' }))).toBe(true)
		expect(matches(base({ where: { title: '\ud800' } }), todo({ title: '\ud800' }))).toBe(true)
		expect(matches(base({ where: { title: '\ud800' } }), todo({ title: '�' }))).toBe(false)
	})

	test('NULL sorts first ascending and last descending', () => {
		const asc = base({ orderBy: [{ field: 'count', direction: 'asc' }] })
		const desc = base({ orderBy: [{ field: 'count', direction: 'desc' }] })
		expect(compare(asc, todo({ count: null }), todo({ count: -1e308 }))).toBeLessThan(0)
		expect(compare(desc, todo({ count: null }), todo({ count: -1e308 }))).toBeGreaterThan(0)
	})

	test('booleans compare as 0/1', () => {
		const d = base({ orderBy: [{ field: 'done', direction: 'asc' }] })
		expect(compare(d, todo({ done: false }), todo({ done: true }))).toBeLessThan(0)
		expect(matches(base({ where: { done: { $gt: false } } }), todo({ done: true }))).toBe(true)
	})

	test('ties report zero, and with no orderBy every pair ties', () => {
		const d = base({ orderBy: [{ field: 'count', direction: 'asc' }] })
		expect(compare(d, todo({ count: 1, title: 'a' }), todo({ count: 1, title: 'b' }))).toBe(0)
		expect(compare(base(), todo({ count: 1 }), todo({ count: 2 }))).toBe(0)
		expect(compare(d, todo({ count: -0 }), todo({ count: 0 }))).toBe(0)
	})

	test('later sort keys break earlier ties; each key has its own direction', () => {
		const d = base({
			orderBy: [
				{ field: 'count', direction: 'asc' },
				{ field: 'title', direction: 'desc' },
			],
		})
		expect(
			compare(d, todo({ count: 1, title: 'a' }), todo({ count: 1, title: 'b' })),
		).toBeGreaterThan(0)
		expect(compare(d, todo({ count: 0, title: 'a' }), todo({ count: 1, title: 'b' }))).toBeLessThan(
			0,
		)
	})

	test('a plan is rebuilt when the descriptor parts it came from change', () => {
		const d: QueryDescriptor = base({ where: { count: 1 } })
		expect(matches(d, todo({ count: 1 }))).toBe(true)
		d.where = { count: 2 }
		expect(matches(d, todo({ count: 1 }))).toBe(false)
	})
})
