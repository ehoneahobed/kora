import { describe, expect, test } from 'vitest'
import { defineSchema } from '../schema/define'
import { t } from '../schema/types'
import type { HLCTimestamp, Operation, SchemaDefinition } from '../types'
import {
	SERVER_NODE_ID_PREFIX,
	isAuthoritativeNodeId,
	isReservedNodeId,
	isServerNodeId,
} from './authority'
import { createFoldState, foldRecord, getFoldFieldVersions, materialize, mergeOp } from './fold'
import { foldPlanFingerprint, foldPlanFingerprints, mismatchedFoldFields } from './plan'
import { serializeFoldState } from './serialize'
import { adaptFoldState, createSnapshotState } from './snapshot'

const ts = (wallTime: number, nodeId: string): HLCTimestamp => ({ wallTime, logical: 0, nodeId })

function op(p: Partial<Operation> & Pick<Operation, 'id' | 'nodeId' | 'timestamp'>): Operation {
	return {
		type: 'update',
		collection: 'items',
		recordId: 'r1',
		data: null,
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
		...p,
	}
}

const v1 = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				owner: t.string().merge('server-authoritative'),
				score: t.number().default(0),
				stock: t.number().default(0).merge('counter'),
				tags: t.array(t.string()).default([]),
			},
		},
	},
}) as unknown as SchemaDefinition

const v2 = defineSchema({
	version: 2,
	collections: {
		items: {
			fields: {
				title: t.string(),
				owner: t.string().merge('server-authoritative'),
				score: t.number().default(0).merge('counter'),
				stock: t.number().default(0).merge('counter'),
				tags: t.array(t.string()).default([]).merge('append-only'),
			},
		},
	},
}) as unknown as SchemaDefinition

describe('server node ids', () => {
	test('the kora:server: namespace is authoritative without a list', () => {
		expect(isServerNodeId(`${SERVER_NODE_ID_PREFIX}abc`)).toBe(true)
		expect(isServerNodeId(SERVER_NODE_ID_PREFIX)).toBe(false)
		expect(isServerNodeId('kora:scope-entry')).toBe(false)
		expect(isReservedNodeId('kora:scope-entry')).toBe(true)
		expect(isAuthoritativeNodeId('kora:server:x')).toBe(true)
		expect(isAuthoritativeNodeId('legacy', new Set(['legacy']))).toBe(true)
		expect(isAuthoritativeNodeId('device')).toBe(false)
	})

	test('a kora:server: write beats a later device write of a server-authoritative field', () => {
		const insert = op({
			id: 'i',
			nodeId: 'device',
			type: 'insert',
			timestamp: ts(100, 'device'),
			data: { title: 't', owner: 'client' },
		})
		const server = op({
			id: 's',
			nodeId: 'kora:server:main',
			timestamp: ts(200, 'kora:server:main'),
			data: { owner: 'approved' },
			previousData: { owner: 'client' },
		})
		const later = op({
			id: 'l',
			nodeId: 'device',
			timestamp: ts(300, 'device'),
			data: { owner: 'mine', title: 'u' },
			previousData: { owner: 'approved', title: 't' },
		})
		for (const order of [
			[insert, server, later],
			[later, insert, server],
			[server, later, insert],
		]) {
			const state = foldRecord(order, v1).state
			expect(materialize(state ?? createFoldState('items', 'r1'))).toEqual({
				owner: 'approved',
				title: 'u',
			})
		}
	})
})

describe('scope entry without fold state (RT-67)', () => {
	test('a field without a version is stamped at the oldest version the entry knows', () => {
		const insert = op({
			id: 'ins',
			nodeId: 'a',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { title: 'old', score: 1 },
		})
		const deviceEdit = op({
			id: 'edit',
			nodeId: 'device',
			timestamp: ts(300, 'device'),
			data: { score: 7 },
			previousData: { score: 1 },
		})
		// `score` has no version in the entry (a later schema default, say): it must not
		// be stamped at the newest version the entry carries (500), but at its oldest
		// (the entry's own timestamp, the record's creation).
		const entry = op({
			id: 'scope-entry-1',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { title: 'new', score: 1 },
			fieldVersions: { title: ts(500, 'b') },
		})
		const state = foldRecord([insert, deviceEdit, entry], v1).state
		expect(materialize(state ?? createFoldState('items', 'r1'))).toEqual({
			title: 'new',
			score: 7,
		})
	})

	test("a restated server-authoritative value keeps its writer's authority class", () => {
		const insert = op({
			id: 'ins',
			nodeId: 'device',
			type: 'insert',
			timestamp: ts(100, 'device'),
			data: { title: 't', owner: 'client' },
		})
		const deviceEdit = op({
			id: 'edit',
			nodeId: 'device',
			timestamp: ts(400, 'device'),
			data: { owner: 'mine' },
			previousData: { owner: 'client' },
		})
		const entry = op({
			id: 'scope-entry-2',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			timestamp: ts(100, 'device'),
			data: { title: 't', owner: 'approved' },
			fieldVersions: { title: ts(100, 'device'), owner: ts(200, 'kora:server:main') },
		})
		const state = foldRecord([insert, deviceEdit, entry], v1).state
		expect(materialize(state ?? createFoldState('items', 'r1'))?.owner).toBe('approved')
	})
})

describe('fold plan fingerprint (RT-63)', () => {
	test('changes exactly for the collections whose fold plan changed', () => {
		expect(foldPlanFingerprint(v1)).not.toBe(foldPlanFingerprint(v2))
		const a = foldPlanFingerprints(v1)
		const b = foldPlanFingerprints(v2)
		expect(a.items).not.toBe(b.items)
		expect(foldPlanFingerprint(v1)).toBe(foldPlanFingerprint(v1))
	})

	test('a carried fold state of another plan falls back to the entry data', () => {
		const insert = op({
			id: 'ins',
			nodeId: 'a',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { title: 'x', score: 1 },
		})
		// The server folded `score` as a plain number (v1); this replica runs v2 (counter).
		const serverState = foldRecord([insert], v1).state ?? createFoldState('items', 'r1')
		const entry = op({
			id: 'scope-entry-3',
			nodeId: 'kora:scope-entry',
			type: 'insert',
			timestamp: ts(100, 'a'),
			data: { title: 'x', score: 1 },
			fieldVersions: { title: ts(100, 'a'), score: ts(100, 'a') },
			foldState: serializeFoldState(serverState),
		})
		const result = mergeOp(createFoldState('items', 'r1'), entry, v2)
		expect(materialize(result.state)).toEqual({ title: 'x', score: 1 })
		expect(mismatchedFoldFields(result.state, v2)).toEqual([])
	})

	test('adaptFoldState rebuilds only the re-planned fields, at their versions', () => {
		const ops = [
			op({
				id: 'i',
				nodeId: 'a',
				type: 'insert',
				timestamp: ts(100, 'a'),
				data: { title: 'x', score: 1, stock: 5, tags: ['p'] },
			}),
			op({
				id: 'u',
				nodeId: 'a',
				timestamp: ts(200, 'a'),
				data: { score: 4, stock: 6 },
				previousData: { score: 1, stock: 5 },
			}),
		]
		const old = foldRecord(ops, v1).state ?? createFoldState('items', 'r1')
		expect(mismatchedFoldFields(old, v2)).toEqual(['score', 'tags'])
		const { state, adapted } = adaptFoldState(old, v2)
		expect(adapted).toEqual(['score', 'tags'])
		expect(mismatchedFoldFields(state, v2)).toEqual([])
		expect(state.f.stock).toBe(old.f.stock)
		expect(materialize(state)).toEqual(materialize(old))
		// The re-planned counter now takes increments.
		const inc = op({
			id: 'inc',
			nodeId: 'b',
			timestamp: ts(300, 'b'),
			data: { score: 6 },
			previousData: { score: 4 },
		})
		expect(materialize(mergeOp(state, inc, v2).state)?.score).toBe(6)
	})
})

describe('snapshot exactness (RT-68)', () => {
	const insert = op({
		id: 'i',
		nodeId: 'a',
		type: 'insert',
		timestamp: ts(100, 'a'),
		data: { title: 'x', stock: 10, tags: ['x'] },
	})
	const restock = op({
		id: 'u',
		nodeId: 'a',
		timestamp: ts(300, 'a'),
		data: { stock: 15, tags: ['x', 'y'] },
		previousData: { stock: 10, tags: ['x'] },
	})
	const late = op({
		id: 'late',
		nodeId: 'b',
		timestamp: ts(200, 'b'),
		data: { stock: 9, tags: ['x', 'z'] },
		previousData: { stock: 10, tags: ['x'] },
	})

	test('a snapshot seeded from a stored fold state folds a late older write exactly', () => {
		const known = foldRecord([insert, restock], v1).state ?? createFoldState('items', 'r1')
		const versions = getFoldFieldVersions(known)
		const snapshot = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values: materialize(known) ?? {},
				fieldVersions: versions?.fields ?? {},
				created: versions?.created ?? ts(0, ''),
				latest: versions?.latest ?? ts(0, ''),
				deleted: false,
			},
			v1,
			{ seed: known },
		)
		const full = foldRecord([insert, restock, late], v1).state ?? createFoldState('items', 'r1')
		expect(materialize(mergeOp(snapshot, late, v1).state)).toEqual(materialize(full))
		expect(materialize(full)).toEqual({ title: 'x', stock: 14, tags: ['x', 'z', 'y'] })
	})

	test('a row snapshot keeps the authority class of a server-written version', () => {
		const snapshot = createSnapshotState(
			{
				collection: 'items',
				recordId: 'r1',
				values: { title: 't', owner: 'approved' },
				fieldVersions: { title: ts(100, 'device'), owner: ts(200, 'kora:server:main') },
				created: ts(100, 'device'),
				latest: ts(200, 'kora:server:main'),
				deleted: false,
			},
			v1,
		)
		// The device write the server's decision beat, merged again (it is in the log).
		const lost = op({
			id: 'lost',
			nodeId: 'device',
			timestamp: ts(250, 'device'),
			data: { owner: 'client' },
			previousData: { owner: 'x' },
		})
		expect(materialize(mergeOp(snapshot, lost, v1).state)?.owner).toBe('approved')
	})
})
