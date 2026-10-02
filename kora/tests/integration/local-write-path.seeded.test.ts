import { defineSchema, op, t } from '@korajs/core'
import { describe, expect, test } from 'vitest'
import { createApp } from '../../src/create-app'
import type { KoraApp } from '../../src/types'

/**
 * W6 gate on the public app path (ApplyPipeline as the local mutation handler):
 * seeded random interleavings of app.transaction, single-record writes, cascading
 * deletes and concurrent atomic increments. Every own-node sequence number must
 * be unique and contiguous, the persisted counter must equal the highest, and
 * every operation must be uploadable.
 */
const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string() } },
		todos: {
			fields: { title: t.string(), projectId: t.string().optional(), n: t.number().default(0) },
		},
	},
	relations: {
		todoProject: {
			from: 'todos',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'cascade',
		},
	},
})

/** Deterministic PRNG (mulberry32) so every failure reproduces from its seed. */
function prng(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let r = Math.imul(a ^ (a >>> 15), 1 | a)
		r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
		return ((r ^ (r >>> 14)) >>> 0) / 4294967296
	}
}

interface Collections {
	projects: {
		insert(d: Record<string, unknown>): Promise<{ id: string }>
		delete(id: string): Promise<void>
	}
	todos: {
		insert(d: Record<string, unknown>): Promise<{ id: string }>
		update(id: string, d: Record<string, unknown>): Promise<unknown>
		findById(id: string): Promise<{ n: number } | null>
	}
}

async function runSeed(seed: number): Promise<void> {
	const random = prng(seed)
	const pick = (list: string[]): string =>
		list.length === 0 ? 'missing' : (list[Math.floor(random() * list.length)] as string)
	const app: KoraApp = createApp({ schema, store: { adapter: 'better-sqlite3', name: ':memory:' } })
	await app.ready
	const db = app as unknown as Collections
	const projects: string[] = []
	const todos: string[] = []
	const increments = new Map<string, number>()
	const bump = (id: string, by: number): void => {
		increments.set(id, (increments.get(id) ?? 0) + by)
	}

	try {
		for (let wave = 0; wave < 6; wave++) {
			const size = 1 + Math.floor(random() * 5)
			const tasks: Array<Promise<unknown>> = []
			for (let i = 0; i < size; i++) {
				const choice = Math.floor(random() * 6)
				if (choice === 0) {
					tasks.push(db.projects.insert({ name: 'p' }).then((p) => projects.push(p.id)))
				} else if (choice === 1) {
					const projectId = pick(projects)
					tasks.push(db.todos.insert({ title: 't', projectId }).then((x) => todos.push(x.id)))
				} else if (choice === 2) {
					tasks.push(db.projects.delete(pick(projects)))
				} else if (choice === 3) {
					const id = pick(todos)
					tasks.push(db.todos.update(id, { n: op.increment(1) }).then(() => bump(id, 1)))
				} else if (choice === 4) {
					const id = pick(todos)
					tasks.push(
						app
							.transaction(async (tx) => {
								await tx.todos?.update(id, { n: op.increment(2) })
							})
							.then(() => bump(id, 2)),
					)
				} else {
					const victim = pick(projects)
					let created = ''
					tasks.push(
						app
							.transaction(async (tx) => {
								const p = await tx.projects?.insert({ name: 'tx' })
								created = p?.id ?? ''
								await tx.todos?.insert({ title: 'tx', projectId: created })
								if (victim !== 'missing') await tx.projects?.delete(victim)
							})
							.then(() => projects.push(created)),
					)
				}
			}
			await Promise.allSettled(tasks)
		}

		const store = app.getStore()
		const nodeId = store.getNodeId()
		const own = (await store.getAllOperations()).filter((o) => o.nodeId === nodeId)
		const seqs = own.map((o) => o.sequenceNumber).sort((a, b) => a - b)
		const max = seqs.length > 0 ? (seqs[seqs.length - 1] as number) : 0
		expect(seqs, `seed ${seed}`).toEqual(Array.from({ length: max }, (_, i) => i + 1))
		const adapter = (
			store as unknown as {
				adapter: { query<T>(sql: string, params?: unknown[]): Promise<T[]> }
			}
		).adapter
		const rows = await adapter.query<{ sequence_number: number }>(
			'SELECT sequence_number FROM _kora_version_vector WHERE node_id = ?',
			[nodeId],
		)
		expect(rows[0]?.sequence_number ?? 0, `seed ${seed}`).toBe(max)
		const unsynced = await store.getUnsyncedOperations(new Map())
		expect(unsynced.length, `seed ${seed}`).toBe(own.length)
		for (const [id, total] of increments) {
			const todo = await db.todos.findById(id)
			if (todo) expect(todo.n, `seed ${seed}`).toBe(total)
		}
	} finally {
		await app.close()
	}
}

describe('W6 local write path on the app path', () => {
	test('seeded interleavings keep sequences unique, contiguous and uploadable', async () => {
		for (let seed = 1; seed <= 25; seed++) {
			await runSeed(seed)
		}
	}, 120_000)
})
