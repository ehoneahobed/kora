/**
 * RT-73: the referential effects of a committed delete survive a batch that fails
 * after the delete committed. A delete sent again is a stored duplicate; its effects
 * still undone are derived (or deferred to the author's copies in that batch) then, on
 * every store. Derived ids are deterministic, so repeats store nothing twice.
 */
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import { PostgresServerStore } from '../../src/store/postgres-server-store'
import type { ServerStore } from '../../src/store/server-store'
import { createSqliteServerStore } from '../../src/store/sqlite-server-store'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		posts: { fields: { title: t.string() } },
		comments: { fields: { text: t.string(), postId: t.string().optional() } },
		likes: { fields: { postId: t.string().optional() } },
		notes: { fields: { title: t.string() } },
	},
	relations: {
		commentPost: {
			from: 'comments',
			to: 'posts',
			type: 'many-to-one',
			field: 'postId',
			onDelete: 'cascade',
		},
		likePost: {
			from: 'likes',
			to: 'posts',
			type: 'many-to-one',
			field: 'postId',
			onDelete: 'set-null',
		},
	},
})

const kinds = [
	'memory',
	'sqlite',
	...(process.env.KORA_PG_TEST_URL ? (['postgres'] as const) : []),
] as const

let cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const fn of cleanups.reverse()) await fn()
	cleanups = []
})

let pgSchemas = 0
async function openStore(kind: (typeof kinds)[number]): Promise<ServerStore> {
	if (kind === 'memory') return new MemoryServerStore('server-1')
	if (kind === 'sqlite')
		return createSqliteServerStore({ filename: ':memory:', nodeId: 'server-1' })
	const url = process.env.KORA_PG_TEST_URL as string
	pgSchemas += 1
	const name = `kora_rt73_${process.pid}_${pgSchemas}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
	await admin.unsafe(`CREATE SCHEMA ${name}`)
	const client = postgres(url, {
		max: 4,
		idle_timeout: 1,
		onnotice: () => {},
		connection: { search_path: name },
	})
	cleanups.push(async () => {
		await client.end()
		await admin.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`)
		await admin.end()
	})
	return new PostgresServerStore(drizzle(client), 'server-1')
}

/** Make the store's apply of the first matching operation throw once (a transient failure). */
function failOnce(store: ServerStore, match: string | ((op: Operation) => boolean)): void {
	const original = store.applyRemoteOperation.bind(store)
	const matches = typeof match === 'string' ? (op: Operation) => op.id === match : match
	let armed = true
	store.applyRemoteOperation = async (op, options) => {
		if (armed && matches(op)) {
			armed = false
			throw new Error('connection terminated unexpectedly')
		}
		return original(op, options)
	}
}

async function setup(kind: (typeof kinds)[number]) {
	const store = await openStore(kind)
	const { server, login } = await createHarness(
		schema,
		null,
		{},
		store as unknown as MemoryServerStore,
	)
	cleanups.push(() => server.stop())
	const owner = await login('t', 'owner-node', { protocolVersion: 2 })
	const post = makeOp('owner-node', 1, {
		collection: 'posts',
		recordId: 'post-1',
		data: { title: 'p' },
	})
	const comment = makeOp('owner-node', 2, {
		collection: 'comments',
		recordId: 'c-1',
		data: { text: 'c', postId: 'post-1' },
		causalDeps: [post.id],
	})
	const like = makeOp('owner-node', 3, {
		collection: 'likes',
		recordId: 'l-1',
		data: { postId: 'post-1' },
		causalDeps: [post.id],
	})
	owner.send(batch([post, comment, like]))
	await tick(150)
	const del = makeOp('owner-node', 4, {
		type: 'delete',
		collection: 'posts',
		recordId: 'post-1',
		data: null,
		causalDeps: [comment.id, like.id],
	})
	const unrelated = makeOp('owner-node', 5, {
		collection: 'notes',
		recordId: 'n-1',
		data: { title: 'n' },
		causalDeps: [del.id],
	})
	const login2 = () => login('t', 'owner-node', { protocolVersion: 2 })
	return { store, owner, del, unrelated, login: login2 }
}

describe.each(kinds)('stored delete effects (RT-73, %s store)', (kind) => {
	test('a batch failing after the delete: the retry derives the cascade and set-null the author did not cover', async () => {
		const { store, owner, del, unrelated, login } = await setup(kind)
		// An author that uploads no copies; the first upload fails right after the delete
		// committed, on the server's own cascade. The retry (a stored duplicate delete)
		// derives what is still undone.
		failOnce(store, (op) => op.collection === 'comments' && op.type === 'delete')
		owner.send(batch([del, unrelated]))
		await tick(150)
		expect(await store.findRecord('posts', 'post-1')).toBeNull()
		const again = await login()
		again.send(batch([del, unrelated]))
		await tick(200)
		expect(await store.findRecord('comments', 'c-1')).toBeNull()
		expect((await store.findRecord('likes', 'l-1'))?.postId ?? null).toBeNull()
		// A third send stores nothing new (the effects are done).
		const before = await store.getOperationCount()
		const third = await login()
		third.send(batch([del, unrelated]))
		await tick(150)
		const after = await store.getOperationCount()
		expect(after).toBe(before)
	})

	test("the author's copy refused on the retry: the server derives the cascade", async () => {
		const { store, owner, del, unrelated, login } = await setup(kind)
		const copy: Operation = {
			...makeOp('owner-node', 6, {
				type: 'delete',
				collection: 'comments',
				recordId: 'c-1',
				data: null,
				causalDeps: [del.id],
			}),
			id: 'f'.repeat(64),
		}
		failOnce(store, unrelated.id)
		owner.send(batch([del, unrelated, copy]))
		await tick(150)
		const again = await login()
		again.send(batch([del, unrelated, copy]))
		await tick(200)
		expect(await store.findRecord('posts', 'post-1')).toBeNull()
		expect(await store.findRecord('comments', 'c-1')).toBeNull()
	})

	test("the author's honest copy on the retry: one cascade (the author's), none derived", async () => {
		const { store, owner, del, unrelated, login } = await setup(kind)
		const copy = makeOp('owner-node', 6, {
			type: 'delete',
			collection: 'comments',
			recordId: 'c-1',
			data: null,
			causalDeps: [del.id],
		})
		failOnce(store, unrelated.id)
		owner.send(batch([del, unrelated, copy]))
		await tick(150)
		const again = await login()
		again.send(batch([del, unrelated, copy]))
		await tick(200)
		expect(await store.findRecord('comments', 'c-1')).toBeNull()
		const stored = await store.findStoredOperations?.([copy.id])
		expect(stored?.has(copy.id)).toBe(true)
	})
})
