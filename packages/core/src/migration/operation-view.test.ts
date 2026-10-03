import { describe, expect, test } from 'vitest'
import { HybridLogicalClock } from '../clock/hlc'
import { foldRecord, materialize } from '../fold/fold'
import { foldPlanFingerprint, foldPlanFingerprints } from '../fold/plan'
import { canonicalizeProvenLegacyClear } from '../operations/canonical-body'
import { computeOperationId } from '../operations/content-hash'
import { createOperation, verifyOperationId } from '../operations/operation'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { Operation } from '../types'
import type { OperationTransform } from './operation-transform'
import {
	OperationTransformError,
	operationSchemaView,
	operationTransformsFingerprint,
} from './operation-view'

const schemaV2 = defineSchema({
	version: 2,
	collections: {
		notes: { fields: { title: t.string(), score: t.number().optional() } },
	},
})

// v1 called `title` `name`; v2 computes `score` on the server, so v1 writes to it are dropped.
const transforms: OperationTransform[] = [
	{
		fromVersion: 1,
		toVersion: 2,
		transform: (op) => {
			const rename = (record: Record<string, unknown> | null) => {
				if (record === null) return null
				const { name, score: _dropped, ...rest } = record
				return name === undefined ? rest : { ...rest, title: name }
			}
			return { ...op, schemaVersion: 2, data: rename(op.data) }
		},
	},
]

async function write(
	nodeId: string,
	seq: number,
	fields: Pick<Operation, 'type' | 'data' | 'previousData' | 'schemaVersion'>,
	wallTime: number,
): Promise<Operation> {
	const clock = new HybridLogicalClock(nodeId, { now: () => wallTime })
	return createOperation(
		{
			nodeId,
			collection: 'notes',
			recordId: 'n1',
			sequenceNumber: seq,
			causalDeps: [],
			...fields,
		},
		clock,
	)
}

describe('operationSchemaView (transforms at fold time, RT-84)', () => {
	test('returns the operation itself at the target version, without transforms, or sealed', async () => {
		const op = await write(
			'a',
			1,
			{ type: 'insert', data: { name: 'x' }, previousData: null, schemaVersion: 1 },
			1000,
		)
		expect(operationSchemaView(op, 1, transforms)).toBe(op)
		expect(operationSchemaView(op, 2, [])).toBe(op)
		expect(operationSchemaView(op, 2, undefined)).toBe(op)
		const sealed = { ...op, encrypted: {} as NonNullable<Operation['encrypted']> }
		expect(operationSchemaView(sealed, 2, transforms)).toBe(sealed)
	})

	test('the view is transformed; the operation is never mutated', async () => {
		const op = await write(
			'a',
			1,
			{ type: 'insert', data: { name: 'x', score: 3 }, previousData: null, schemaVersion: 1 },
			1000,
		)
		const before = JSON.stringify(op)
		const view = operationSchemaView(op, 2, transforms)
		expect(view).toMatchObject({ id: op.id, schemaVersion: 2, data: { title: 'x' } })
		expect(JSON.stringify(op)).toBe(before)
		expect(await verifyOperationId(op)).toBe(true)
	})

	test('null when a transform drops the operation or no path exists', async () => {
		const op = await write(
			'a',
			1,
			{ type: 'insert', data: { name: 'x' }, previousData: null, schemaVersion: 3 },
			1000,
		)
		expect(operationSchemaView(op, 2, transforms)).toBeNull()
		const dropping: OperationTransform[] = [{ fromVersion: 3, toVersion: 2, transform: () => null }]
		expect(operationSchemaView(op, 2, dropping)).toBeNull()
	})

	test('a transform that changes identity, throws or returns no JSON value is refused', async () => {
		const op = await write(
			'a',
			1,
			{ type: 'insert', data: { name: 'x' }, previousData: null, schemaVersion: 1 },
			1000,
		)
		const bad = (patch: (o: Operation) => Operation): OperationTransform[] => [
			{ fromVersion: 1, toVersion: 2, transform: (o) => ({ ...patch(o), schemaVersion: 2 }) },
		]
		for (const transform of [
			bad((o) => ({ ...o, recordId: 'other' })),
			bad((o) => ({ ...o, collection: 'other' })),
			bad((o) => ({ ...o, type: 'update' })),
			bad((o) => ({ ...o, timestamp: { ...o.timestamp, logical: 9 } })),
			bad((o) => ({ ...o, data: { when: Number.NaN } })),
			bad(() => {
				throw new Error('boom')
			}),
		]) {
			expect(() => operationSchemaView(op, 2, transform)).toThrow(OperationTransformError)
		}
	})

	test('the fold merges the view: a renamed field lands, a dropped field keeps its value (RT-85)', async () => {
		const insert = await write(
			'v2',
			1,
			{ type: 'insert', data: { title: 'a', score: 5 }, previousData: null, schemaVersion: 2 },
			1000,
		)
		// A v1 client renames and writes score; the transform drops score from data but
		// leaves it in previousData: it must NOT read as a clear (no legacy rule at fold).
		const update = await write(
			'v1',
			1,
			{
				type: 'update',
				data: { name: 'b', score: 9 },
				previousData: { name: 'a', score: 5 },
				schemaVersion: 1,
			},
			2000,
		)
		const state = foldRecord([insert, update], schemaV2, { transforms }).state
		expect(state && materialize(state)).toEqual({ title: 'b', score: 5 })
		// Order and duplicates do not matter.
		const again = foldRecord([update, insert, update], schemaV2, { transforms }).state
		expect(again).toEqual(state)
	})

	test('the fold applies no legacy clear rule: an undeclared body folds as written', async () => {
		const insert = await write(
			'v2',
			1,
			{ type: 'insert', data: { title: 'a', score: 5 }, previousData: null, schemaVersion: 2 },
			1000,
		)
		const { hashVersion: _v, ...rewritten } = await write(
			'old',
			1,
			{
				type: 'update',
				data: { title: 'b' },
				previousData: { title: 'a', score: 5 },
				schemaVersion: 2,
			},
			2000,
		)
		const state = foldRecord([insert, rewritten as Operation], schemaV2).state
		expect(state && materialize(state)).toEqual({ title: 'b', score: 5 })
	})

	test('fold plan fingerprints include the transforms (and only when there are some)', () => {
		const plain = foldPlanFingerprint(schemaV2)
		expect(foldPlanFingerprint(schemaV2, [])).toBe(plain)
		const withTransforms = foldPlanFingerprint(schemaV2, transforms)
		expect(withTransforms).not.toBe(plain)
		const edited: OperationTransform[] = [
			{ fromVersion: 1, toVersion: 2, transform: (op) => ({ ...op, schemaVersion: 2 }) },
		]
		expect(foldPlanFingerprint(schemaV2, edited)).not.toBe(withTransforms)
		expect(foldPlanFingerprints(schemaV2, transforms).notes).toContain(
			operationTransformsFingerprint(2, transforms),
		)
		expect(operationTransformsFingerprint(2, [])).toBe('')
	})
})

describe('canonicalizeProvenLegacyClear (RT-85)', () => {
	async function legacyUpdate(): Promise<Operation> {
		// beta.13: update(id, { assignee: undefined, title: 'y' }) hashed assignee as null.
		const timestamp = { wallTime: 1000, logical: 0, nodeId: 'b13' }
		const base = {
			nodeId: 'b13',
			type: 'update' as const,
			collection: 'notes',
			recordId: 'n1',
			previousData: { title: 'x', assignee: 'bob' },
			timestamp,
			sequenceNumber: 2,
			causalDeps: [],
			schemaVersion: 1,
		}
		const id = await computeOperationId({ ...base, data: { title: 'y', assignee: null } }, 1)
		// Logged and uploaded as JSON: the member is gone.
		return { ...base, id, data: { title: 'y' } }
	}

	test('a body whose id proves the clear gets it back, as null', async () => {
		const op = await legacyUpdate()
		const canonical = await canonicalizeProvenLegacyClear(op)
		expect(canonical.data).toEqual({ title: 'y', assignee: null })
		expect(await verifyOperationId(canonical)).toBe(true)
	})

	test('a rewritten body (a transformed copy) proves nothing and is left as is', async () => {
		const op = await legacyUpdate()
		const rewritten = { ...op, data: { title: 'transformed' } }
		expect(await canonicalizeProvenLegacyClear(rewritten)).toBe(rewritten)
		const v2 = await write(
			'n',
			1,
			{
				type: 'update',
				data: { title: 'b' },
				previousData: { title: 'a', score: 1 },
				schemaVersion: 2,
			},
			1000,
		)
		expect(await canonicalizeProvenLegacyClear(v2)).toBe(v2)
	})
})
