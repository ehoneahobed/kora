import { createHash } from 'node:crypto'
import { fc, test } from '@fast-check/vitest'
import { describe, expect } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { Operation } from '../types'
import { sha256HexSync } from './blind'
import { redactFoldState } from './entry-state'
import { createFoldState, joinStates, materialize, mergeOp } from './fold'
import { deserializeFoldState, serializeFoldState } from './serialize'
import type { FoldState } from './types'

const schema = defineSchema({
	version: 1,
	collections: {
		notes: {
			fields: {
				tags: t.array(t.string()).default([]),
				meta: t.json().optional(),
				peak: t.number().merge('max').optional(),
			},
		},
	},
})

const TAGS = ['a', 'b', 'c', 'd']
const KEYS = ['x', 'y', 'z', '__proto__']

interface Write {
	wall: number
	node: string
	tags?: { before: string[]; after: string[] }
	meta?: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }
}

const subset = (items: readonly string[]) => fc.subarray([...items])
const objectValue = fc.option(
	fc.tuple(subset(KEYS), fc.nat(9)).map(([keys, n]) => {
		const out: Record<string, number> = {}
		for (const key of keys) {
			Object.defineProperty(out, key, {
				value: n,
				enumerable: true,
				writable: true,
				configurable: true,
			})
		}
		return out
	}),
	{ freq: 8 },
)

const writeArb: fc.Arbitrary<Write> = fc.record(
	{
		wall: fc.integer({ min: 2, max: 400 }),
		node: fc.constantFrom('n1', 'n2', 'n3'),
		tags: fc.record({ before: subset(TAGS), after: subset(TAGS) }),
		meta: fc.record({ before: objectValue, after: objectValue }),
	},
	{ requiredKeys: ['wall', 'node'] },
)
const writes = fc.array(writeArb, { maxLength: 12 })

let counter = 0
function operation(write: Write): Operation {
	counter += 1
	const data: Record<string, unknown> = {}
	const previousData: Record<string, unknown> = {}
	if (write.tags) {
		data.tags = write.tags.after
		previousData.tags = write.tags.before
	}
	if (write.meta) {
		data.meta = write.meta.after
		previousData.meta = write.meta.before
	}
	return {
		id: `op-${counter}`,
		nodeId: write.node,
		type: 'update',
		collection: 'notes',
		recordId: 'r',
		data,
		previousData,
		timestamp: { wallTime: write.wall, logical: 0, nodeId: write.node },
		sequenceNumber: counter,
		causalDeps: [],
		schemaVersion: 1,
	}
}

const insert: Operation = {
	id: 'insert',
	nodeId: 'n0',
	type: 'insert',
	collection: 'notes',
	recordId: 'r',
	data: { tags: ['a', 'b'], meta: { x: 1 } },
	previousData: null,
	timestamp: { wallTime: 1, logical: 0, nodeId: 'n0' },
	sequenceNumber: 0,
	causalDeps: [],
	schemaVersion: 1,
}

const fold = (state: FoldState, op: Operation): FoldState =>
	mergeOp(state, op, schema, { traces: 'none' }).state
const start = (): FoldState => fold(createFoldState('notes', 'r'), insert)
const wire = (state: FoldState): FoldState =>
	deserializeFoldState(serializeFoldState(redactFoldState(state)))

describe('a redacted fold state merges like the full one', () => {
	test.prop([writes, writes])('later writes fold to the server’s record', (before, after) => {
		let server = before.map(operation).reduce(fold, start())
		let replica = wire(server)
		expect(materialize(replica)).toEqual(materialize(server))
		for (const op of after.map(operation)) {
			server = fold(server, op)
			replica = fold(replica, op)
			expect(materialize(replica)).toEqual(materialize(server))
		}
	})

	test.prop([writes, writes, writes])(
		'joined with a replica holding part of the history, in either order, it gives the fold of the union',
		(common, mine, theirs) => {
			const base = common.map(operation).reduce(fold, start())
			const own = mine.map(operation)
			const server = theirs.map(operation).reduce(fold, base)
			const device = own.reduce(fold, base)
			const union = own.reduce(fold, server)
			const expected = materialize(union)
			expect(materialize(joinStates(device, wire(server), schema))).toEqual(expected)
			expect(materialize(joinStates(wire(server), device, schema))).toEqual(expected)
			// Own writes re-folded on top of the entry, as a device does from its log.
			expect(materialize(own.reduce(fold, joinStates(base, wire(server), schema)))).toEqual(
				expected,
			)
		},
	)

	test.prop([writes])('joining the same redacted state again changes nothing', (history) => {
		const server = history.map(operation).reduce(fold, start())
		const once = joinStates(start(), wire(server), schema)
		expect(serializeFoldState(joinStates(once, wire(server), schema))).toBe(
			serializeFoldState(once),
		)
	})
})

interface Fields {
	tags?: string[]
	meta?: Record<string, unknown> | null
}

describe('what a redacted state does not show', () => {
	const update = (wall: number, data: Fields, previousData: Fields): Operation =>
		operation({ wall, node: 'n1', ...fieldsOf(data, previousData) })
	const fieldsOf = (
		data: Partial<Pick<Fields, 'tags' | 'meta'>>,
		previousData: Partial<Pick<Fields, 'tags' | 'meta'>>,
	): Partial<Write> => ({
		...(data.tags ? { tags: { after: data.tags, before: previousData.tags ?? [] } } : {}),
		...('meta' in data
			? { meta: { after: data.meta ?? null, before: previousData.meta ?? null } }
			: {}),
	})
	const seeded = (data: Record<string, unknown>): FoldState =>
		fold(createFoldState('notes', 'r'), { ...insert, data })

	test.each([
		[
			'a removed array element',
			{ tags: ['SECRET', 'k'] },
			{ tags: ['k'] },
			{ tags: ['SECRET', 'k'] },
		],
		[
			'a deleted object key',
			{ meta: { SECRET: 1, k: 2 } },
			{ meta: { k: 2 } },
			{ meta: { SECRET: 1, k: 2 } },
		],
		[
			'an object cleared by null',
			{ meta: { k: 'SECRET' } },
			{ meta: null },
			{ meta: { k: 'SECRET' } },
		],
	])('%s', (_name, initial, after, before) => {
		const state = fold(seeded(initial), update(5, after, before))
		expect(serializeFoldState(state)).toContain('SECRET')
		expect(serializeFoldState(redactFoldState(state))).not.toContain('SECRET')
		expect(materialize(redactFoldState(state))).toEqual(materialize(state))
	})

	test('a max field’s shadowed non-numeric value', () => {
		const state = fold(seeded({ peak: 'SECRET' }), {
			...insert,
			id: 'peak',
			type: 'update',
			data: { peak: 5 },
			previousData: {},
			timestamp: { wallTime: 5, logical: 0, nodeId: 'n1' },
		})
		expect(serializeFoldState(state)).toContain('SECRET')
		expect(serializeFoldState(redactFoldState(state))).not.toContain('SECRET')
	})

	test('a value the replica meets in a write comes back as itself', () => {
		let server = seeded({ tags: ['SECRET'] })
		server = fold(server, update(9, { tags: [] }, { tags: ['SECRET'] }))
		const replica = fold(wire(server), update(12, { tags: ['SECRET'] }, { tags: [] }))
		expect(materialize(replica)).toMatchObject({ tags: ['SECRET'] })
		expect(serializeFoldState(replica)).not.toContain('\\u0000h:')
	})

	test('digests differ per record, so one table does not serve them all', () => {
		const state = fold(seeded({ tags: ['SECRET'] }), update(9, { tags: [] }, { tags: ['SECRET'] }))
		const other = joinStates(createFoldState('notes', 'r2'), { ...state, r: 'r2' }, schema)
		expect(Object.keys(redactFoldState(state).f.tags as object)).toBeDefined()
		const keys = (s: FoldState) => JSON.stringify(Object.keys((s.f.tags as { el: object }).el))
		expect(keys(redactFoldState(state))).not.toBe(keys(redactFoldState(other)))
	})
})

describe('sha256HexSync', () => {
	test.prop([fc.string({ unit: 'binary', maxLength: 300 })])('equals SHA-256', (text) => {
		expect(sha256HexSync(text)).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
	})
})
