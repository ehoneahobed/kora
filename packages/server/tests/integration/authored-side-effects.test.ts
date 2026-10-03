/**
 * RT-69 server half: the server does not store a second copy of a cascade or set-null
 * the deleting device authored itself in the same upload. It still derives every
 * effect the author did not cover: a legacy client that authors no cascades, a child
 * the author did not know about, and an authored copy the server refused.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		tasks: { fields: { title: t.string(), projectId: t.string().optional() } },
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		taskProject: {
			from: 'tasks',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
		noteProject: {
			from: 'notes',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'set-null',
		},
	},
})

const AUTHOR = 'author-node'
const OTHER = 'other-node'

interface Seeded {
	store: MemoryServerStore
	send: (ops: Operation[]) => Promise<void>
	project: Operation
	tasks: Operation[]
	notes: Operation[]
	nextSeq: () => number
}

async function seed(childrenFromOther = 0): Promise<Seeded> {
	const store = new MemoryServerStore('server-1')
	const { login } = await createHarness(schema, null, {}, store)
	const author = await login('t', AUTHOR)
	let seq = 0
	const nextSeq = (): number => {
		seq += 1
		return seq
	}
	const project = makeOp(AUTHOR, nextSeq(), {
		collection: 'projects',
		recordId: 'p1',
		data: { name: 'p' },
	})
	const tasks = [1, 2, 3].map((i) =>
		makeOp(AUTHOR, nextSeq(), {
			collection: 'tasks',
			recordId: `t${i}`,
			data: { title: `t${i}`, projectId: 'p1' },
			causalDeps: [project.id],
		}),
	)
	const notes = [1, 2].map((i) =>
		makeOp(AUTHOR, nextSeq(), {
			collection: 'notes',
			recordId: `n${i}`,
			data: { body: `n${i}`, projectId: 'p1' },
			causalDeps: [project.id],
		}),
	)
	author.send(batch([project, ...tasks, ...notes]))
	await tick()
	if (childrenFromOther > 0) {
		// Children the author never saw (another device, not yet synced to the author).
		const other = await login('t', OTHER)
		const extra = Array.from({ length: childrenFromOther }, (_, i) =>
			makeOp(OTHER, i + 1, {
				collection: 'tasks',
				recordId: `x${i + 1}`,
				data: { title: 'x', projectId: 'p1' },
			}),
		)
		other.send(batch(extra))
		await tick()
	}
	return {
		store,
		send: async (ops) => {
			author.send(batch(ops))
			await tick()
		},
		project,
		tasks,
		notes,
		nextSeq,
	}
}

function deleteOf(s: Seeded): Operation {
	return makeOp(AUTHOR, s.nextSeq(), {
		type: 'delete',
		collection: 'projects',
		recordId: 'p1',
		data: null,
		causalDeps: [s.project.id],
	})
}

function cascadeCopy(s: Seeded, parent: Operation, recordId: string): Operation {
	return makeOp(AUTHOR, s.nextSeq(), {
		type: 'delete',
		collection: 'tasks',
		recordId,
		data: null,
		causalDeps: [parent.id],
	})
}

function setNullCopy(s: Seeded, parent: Operation, recordId: string): Operation {
	return makeOp(AUTHOR, s.nextSeq(), {
		type: 'update',
		collection: 'notes',
		recordId,
		data: { projectId: null },
		previousData: { projectId: 'p1' },
		causalDeps: [parent.id],
	})
}

/** Child effects stored per record: node ids of the deletes / set-nulls. */
function effectsByChild(store: MemoryServerStore): Map<string, string[]> {
	const out = new Map<string, string[]>()
	for (const op of store.getAllOperations()) {
		const isCascade = op.collection === 'tasks' && op.type === 'delete'
		const isSetNull =
			op.collection === 'notes' && op.type === 'update' && op.data?.projectId === null
		if (!isCascade && !isSetNull) continue
		out.set(op.recordId, [...(out.get(op.recordId) ?? []), op.nodeId])
	}
	return out
}

async function liveChildren(store: MemoryServerStore): Promise<unknown[]> {
	return [
		...(await store.queryCollection('tasks', { where: { projectId: 'p1' } })),
		...(await store.queryCollection('notes', { where: { projectId: 'p1' } })),
	]
}

describe('RT-69: the server stores one copy of an authored cascade', () => {
	test("an author's own cascades and set-nulls in the upload are not derived again", async () => {
		const s = await seed()
		const del = deleteOf(s)
		await s.send([
			del,
			...s.tasks.map((task) => cascadeCopy(s, del, task.recordId)),
			...s.notes.map((note) => setNullCopy(s, del, note.recordId)),
		])
		const byChild = effectsByChild(s.store)
		expect([...byChild.keys()].sort()).toEqual(['n1', 'n2', 't1', 't2', 't3'])
		for (const nodes of byChild.values()) expect(nodes).toEqual([AUTHOR])
		expect(await liveChildren(s.store)).toEqual([])
	})

	test('a legacy client that authors no cascades: the server derives every effect', async () => {
		const s = await seed()
		await s.send([deleteOf(s)])
		const byChild = effectsByChild(s.store)
		expect(byChild.size).toBe(5)
		for (const nodes of byChild.values()) {
			expect(nodes).toHaveLength(1)
			expect(nodes[0]?.startsWith('kora:server:')).toBe(true)
		}
		expect(await liveChildren(s.store)).toEqual([])
	})

	test('children the author did not know are derived by the server (constraint authority)', async () => {
		const s = await seed(2)
		const del = deleteOf(s)
		await s.send([
			del,
			...s.tasks.map((task) => cascadeCopy(s, del, task.recordId)),
			...s.notes.map((note) => setNullCopy(s, del, note.recordId)),
		])
		const byChild = effectsByChild(s.store)
		for (const id of ['t1', 't2', 't3', 'n1', 'n2']) expect(byChild.get(id)).toEqual([AUTHOR])
		for (const id of ['x1', 'x2']) {
			expect(byChild.get(id)).toHaveLength(1)
			expect(byChild.get(id)?.[0]?.startsWith('kora:server:')).toBe(true)
		}
		expect(await liveChildren(s.store)).toEqual([])
	})

	test('an authored copy the server refuses is replaced by the server copy', async () => {
		const s = await seed()
		const del = deleteOf(s)
		const copies = s.tasks.map((task) => cascadeCopy(s, del, task.recordId))
		// The copy of t2 does not carry its content hash: refused with INVALID_OPERATION_ID.
		const forged = { ...(copies[1] as Operation), id: 'not-a-content-id' }
		await s.send([del, copies[0] as Operation, forged, copies[2] as Operation])
		const byChild = effectsByChild(s.store)
		expect(byChild.get('t1')).toEqual([AUTHOR])
		expect(byChild.get('t3')).toEqual([AUTHOR])
		expect(byChild.get('t2')).toHaveLength(1)
		expect(byChild.get('t2')?.[0]?.startsWith('kora:server:')).toBe(true)
		// The notes had no authored copies: derived.
		for (const id of ['n1', 'n2'])
			expect(byChild.get(id)?.[0]?.startsWith('kora:server:')).toBe(true)
		expect(await liveChildren(s.store)).toEqual([])
	})

	test('an update that does not null the foreign key is not a set-null copy', async () => {
		const s = await seed()
		const del = deleteOf(s)
		const notACopy = makeOp(AUTHOR, s.nextSeq(), {
			type: 'update',
			collection: 'notes',
			recordId: 'n1',
			data: { body: 'edited' },
			previousData: { body: 'n1' },
			causalDeps: [del.id],
		})
		await s.send([del, notACopy])
		const byChild = effectsByChild(s.store)
		expect(byChild.get('n1')?.[0]?.startsWith('kora:server:')).toBe(true)
		expect(await liveChildren(s.store)).toEqual([])
	})
})
