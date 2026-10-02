/**
 * RT-13 repro (red team round 2, 2026-10-01): cross-tenant dangling child.
 *
 * Uplink authorization judges only the written record, never the record a foreign
 * key points at. Bob can insert a child whose `projectId` names Alice's project (or
 * move his child under it with an update), and with `onDelete: 'restrict'` Alice can
 * then never delete her own project: she gets RESTRICTED forever. The same holds for
 * scoped HTTP routes (`request.kora.apply`).
 *
 * Asserts the CORRECT behaviour (fails before the fix): a referenced parent must exist
 * and be inside the writer's downlink scope, else SCOPE_VIOLATION.
 */
import { defineSchema, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { type Harness, batch, createHarness, makeOp, tick } from './rt-fixture'

const schema = defineSchema({
	version: 1,
	collections: {
		projects: { fields: { name: t.string(), userId: t.string() } },
		comments: {
			fields: { body: t.string(), userId: t.string(), projectId: t.string().optional() },
		},
	},
	relations: {
		commentProject: {
			from: 'comments',
			to: 'projects',
			type: 'many-to-one',
			field: 'projectId',
			onDelete: 'restrict',
		},
	},
})

function tenant(user: string) {
	return { userId: user, scopes: { projects: { userId: user }, comments: { userId: user } } }
}

const auth = new TokenAuthProvider({
	validate: async (token) =>
		token.startsWith('alice') ? tenant('alice') : token.startsWith('bob') ? tenant('bob') : null,
})

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

async function aliceProject(harness: Harness) {
	const alice = await harness.login('alice-token', 'alice-node')
	const project = makeOp('alice-node', 1, {
		collection: 'projects',
		recordId: 'alice-project',
		data: { name: 'secret', userId: 'alice' },
	})
	alice.send(batch([project]))
	await tick()
	return { alice, project }
}

describe('RT-13: foreign-key targets are not authorized at uplink', () => {
	test("an insert referencing another tenant's parent is refused", async () => {
		const harness = await createHarness(schema, auth)
		const { alice, project } = await aliceProject(harness)
		const bob = await harness.login('bob-token', 'bob-node')
		const child = makeOp('bob-node', 1, {
			collection: 'comments',
			recordId: 'bob-comment',
			data: { body: 'squat', userId: 'bob', projectId: 'alice-project' },
		})
		bob.send(batch([child]))
		await tick()
		expect(rejectionFor(bob.messages, child.id)).toBe('SCOPE_VIOLATION')
		expect(await harness.store.findRecord('comments', 'bob-comment')).toBeNull()

		// Alice can still delete her own project.
		const del = makeOp('alice-node', 2, {
			type: 'delete',
			collection: 'projects',
			recordId: 'alice-project',
			data: null,
			causalDeps: [project.id],
		})
		alice.send(batch([del]))
		await tick()
		expect(rejectionFor(alice.messages, del.id)).toBeNull()
		expect(await harness.store.findRecord('projects', 'alice-project')).toBeNull()
	})

	test("an update moving a child under another tenant's parent is refused", async () => {
		const harness = await createHarness(schema, auth)
		await aliceProject(harness)
		const bob = await harness.login('bob-token', 'bob-node')
		const own = makeOp('bob-node', 1, {
			collection: 'projects',
			recordId: 'bob-project',
			data: { name: 'mine', userId: 'bob' },
		})
		const child = makeOp('bob-node', 2, {
			collection: 'comments',
			recordId: 'bob-comment',
			data: { body: 'ok', userId: 'bob', projectId: 'bob-project' },
		})
		const move = makeOp('bob-node', 3, {
			type: 'update',
			collection: 'comments',
			recordId: 'bob-comment',
			data: { projectId: 'alice-project' },
			previousData: { projectId: 'bob-project' },
		})
		bob.send(batch([own, child, move]))
		await tick()
		expect(rejectionFor(bob.messages, own.id)).toBeNull()
		expect(rejectionFor(bob.messages, child.id)).toBeNull()
		expect(rejectionFor(bob.messages, move.id)).toBe('SCOPE_VIOLATION')
		expect((await harness.store.findRecord('comments', 'bob-comment'))?.projectId).toBe(
			'bob-project',
		)
	})

	test('a reference to a parent that does not exist is refused', async () => {
		const harness = await createHarness(schema, auth)
		const bob = await harness.login('bob-token', 'bob-node')
		const child = makeOp('bob-node', 1, {
			collection: 'comments',
			recordId: 'bob-comment',
			data: { body: 'x', userId: 'bob', projectId: 'no-such-project' },
		})
		bob.send(batch([child]))
		await tick()
		expect(rejectionFor(bob.messages, child.id)).toBe('SCOPE_VIOLATION')
	})

	test("a scoped route cannot reference another tenant's parent", async () => {
		const harness = await createHarness(schema, auth)
		await aliceProject(harness)
		const kora = harness.server.getKoraContext()
		const result = await kora.apply(
			{
				collection: 'comments',
				type: 'insert',
				recordId: 'route-comment',
				data: { body: 'via route', userId: 'bob', projectId: 'alice-project' },
			},
			{ scope: tenant('bob').scopes },
		)
		expect(result.ok).toBe(false)
		expect(result.ok ? null : result.code).toBe('SCOPE_VIOLATION')
	})
})
