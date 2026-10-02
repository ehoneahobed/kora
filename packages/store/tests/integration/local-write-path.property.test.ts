import { fc } from '@fast-check/vitest'
import { defineSchema, op, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

/**
 * W6 property gate: random interleavings of transactions, single-record writes,
 * cascading deletes and concurrent atomic increments must leave the local log
 * with
 *
 * - every own-node sequence number unique and contiguous (1..max, no gaps, even
 *   when some writes fail and roll back);
 * - the persisted (and in-memory) version vector equal to the highest sequence;
 * - every operation uploadable: getUnsyncedOperations covers every operation the
 *   server has not acknowledged;
 * - every successful increment reflected in the counter (no lost update);
 * - no live child referencing a deleted parent (cascades complete).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: {
				title: t.string(),
				projectId: t.string().optional(),
				n: t.number().default(0),
			},
		},
		notes: { fields: { body: t.string(), projectId: t.string().optional() } },
	},
	relations: {
		todoProject: {
			from: 'todos',
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

type Command =
	| { kind: 'insertProject' }
	| { kind: 'insertTodo'; project: number }
	| { kind: 'insertNote'; project: number }
	| { kind: 'deleteProject'; project: number }
	| { kind: 'increment'; todo: number; by: number }
	| { kind: 'txIncrement'; todo: number; by: number }
	| { kind: 'txMixed'; project: number; todo: number; deleteProject: boolean }

const commandArb: fc.Arbitrary<Command> = fc.oneof(
	fc.constant<Command>({ kind: 'insertProject' }),
	fc.record({ kind: fc.constant('insertTodo' as const), project: fc.nat(20) }),
	fc.record({ kind: fc.constant('insertNote' as const), project: fc.nat(20) }),
	fc.record({ kind: fc.constant('deleteProject' as const), project: fc.nat(20) }),
	fc.record({
		kind: fc.constant('increment' as const),
		todo: fc.nat(20),
		by: fc.integer({ min: 1, max: 3 }),
	}),
	fc.record({
		kind: fc.constant('txIncrement' as const),
		todo: fc.nat(20),
		by: fc.integer({ min: 1, max: 3 }),
	}),
	fc.record({
		kind: fc.constant('txMixed' as const),
		project: fc.nat(20),
		todo: fc.nat(20),
		deleteProject: fc.boolean(),
	}),
)

/** Commands grouped into waves; the commands of one wave run concurrently. */
const wavesArb = fc.array(fc.array(commandArb, { minLength: 1, maxLength: 6 }), {
	minLength: 1,
	maxLength: 8,
})

interface World {
	store: Store
	projects: string[]
	todos: string[]
	/** Successful increments per todo id. */
	increments: Map<string, number>
}

function pick(list: string[], index: number): string {
	return list.length === 0 ? 'missing-record' : (list[index % list.length] as string)
}

async function run(world: World, command: Command): Promise<void> {
	const { store } = world
	switch (command.kind) {
		case 'insertProject': {
			const p = await store.collection('projects').insert({ name: 'p' })
			world.projects.push(p.id)
			return
		}
		case 'insertTodo': {
			const todo = await store
				.collection('todos')
				.insert({ title: 't', projectId: pick(world.projects, command.project) })
			world.todos.push(todo.id)
			return
		}
		case 'insertNote': {
			await store
				.collection('notes')
				.insert({ body: 'b', projectId: pick(world.projects, command.project) })
			return
		}
		case 'deleteProject':
			await store.collection('projects').delete(pick(world.projects, command.project))
			return
		case 'increment': {
			const id = pick(world.todos, command.todo)
			await store.collection('todos').update(id, { n: op.increment(command.by) })
			world.increments.set(id, (world.increments.get(id) ?? 0) + command.by)
			return
		}
		case 'txIncrement': {
			const id = pick(world.todos, command.todo)
			await store.transaction(async (tx) => {
				await tx.collection('todos').update(id, { n: op.increment(command.by) })
			})
			world.increments.set(id, (world.increments.get(id) ?? 0) + command.by)
			return
		}
		case 'txMixed': {
			let newProject = ''
			let newTodo = ''
			const incrementId = pick(world.todos, command.todo)
			let incremented = false
			await store.transaction(async (tx) => {
				newProject = (await tx.collection('projects').insert({ name: 'tx' })).id
				newTodo = (await tx.collection('todos').insert({ title: 'tx', projectId: newProject })).id
				if (world.todos.length > 0) {
					await tx.collection('todos').update(incrementId, { n: op.increment(1) })
					incremented = true
				}
				if (command.deleteProject && world.projects.length > 0) {
					await tx.collection('projects').delete(pick(world.projects, command.project))
				}
			})
			world.projects.push(newProject)
			world.todos.push(newTodo)
			if (incremented) {
				world.increments.set(incrementId, (world.increments.get(incrementId) ?? 0) + 1)
			}
			return
		}
	}
}

describe('W6 local write path properties', () => {
	test('sequence numbers stay unique and contiguous under random interleavings', async () => {
		await fc.assert(
			fc.asyncProperty(wavesArb, async (waves) => {
				const adapter = new BetterSqlite3Adapter(':memory:')
				const store = new Store({ schema, adapter, nodeId: 'prop-node' })
				await store.open()
				const world: World = { store, projects: [], todos: [], increments: new Map() }
				try {
					for (const wave of waves) {
						// Failures (missing or already-deleted records) are part of the
						// property: a failed write must not burn a sequence number.
						await Promise.allSettled(wave.map((command) => run(world, command)))
					}

					const ops = await store.getAllOperations()
					const own = ops.filter((o) => o.nodeId === 'prop-node')
					const seqs = own.map((o) => o.sequenceNumber).sort((a, b) => a - b)
					const max = seqs.length > 0 ? (seqs[seqs.length - 1] as number) : 0
					expect(seqs).toEqual(Array.from({ length: max }, (_, i) => i + 1))

					const vv = await adapter.query<{ sequence_number: number }>(
						'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
						['prop-node'],
					)
					expect(vv[0]?.sequence_number ?? 0).toBe(max)
					expect(store.getVersionVector().get('prop-node') ?? 0).toBe(max)

					const unsynced = await store.getUnsyncedOperations(new Map())
					expect(unsynced.map((o) => o.id).sort()).toEqual(own.map((o) => o.id).sort())
					if (max > 1) {
						const acked = Math.floor(max / 2)
						const rest = await store.getUnsyncedOperations(new Map([['prop-node', acked]]))
						expect(rest.map((o) => o.sequenceNumber)).toEqual(seqs.filter((seq) => seq > acked))
					}

					for (const [id, total] of world.increments) {
						const todo = await store.collection('todos').findById(id)
						if (todo) expect(todo.n).toBe(total)
					}

					// Cascades complete: no child that existed when its project was deleted
					// is still live (todos) or still pointing at it (notes). A child
					// inserted after the delete may reference it: inserts do not check
					// references, as on any offline replica.
					const deletedAt = new Map<string, number>()
					const insertedAt = new Map<string, number>()
					for (const o of own) {
						if (o.collection === 'projects' && o.type === 'delete') {
							deletedAt.set(o.recordId, o.sequenceNumber)
						}
						if (o.type === 'insert') insertedAt.set(o.recordId, o.sequenceNumber)
					}
					for (const collection of ['todos', 'notes']) {
						const live = await adapter.query<{ id: string; projectId: string | null }>(
							`SELECT id, projectId FROM ${collection} WHERE _deleted = 0 AND projectId IS NOT NULL`,
						)
						for (const row of live) {
							const deleted = deletedAt.get(row.projectId ?? '')
							if (deleted === undefined) continue
							expect(insertedAt.get(row.id) ?? 0).toBeGreaterThan(deleted)
						}
					}
				} finally {
					await store.close()
				}
			}),
			{ numRuns: Number(process.env.KORA_PROPERTY_RUNS ?? 60) },
		)
	}, 120_000)
})
