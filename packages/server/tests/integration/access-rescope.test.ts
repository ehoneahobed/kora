/**
 * The download stream follows membership changes (beta.15 access step 5): a grant or
 * revoke reaches a connected client as a re-scope unit (scope entries, retractions)
 * at the change's delivery sequence, without a reconnect; history before joining is
 * never sent; a reconnect resumes from the client's watermark with the difference.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { anyone, defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { scopeViewKey } from '@korajs/sync/internal'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { batch, createHarness, makeOp, tick } from '../repro/rt-fixture'
import { items } from './access-review/shared'

function makeSchema(commentsReadRole: 'view' | 'edit' | 'none') {
	return defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ['view', 'edit', 'manage'],
			groups: { documents: { owner: 'ownerId', role: 'manage' } },
		},
		collections: {
			members: {
				fields: { userId: t.string(), group: t.string(), role: t.string() },
				access: { read: memberOfKey('group', 'manage') },
			},
			documents: {
				fields: { title: t.string(), ownerId: t.string().stamp('userId') },
				access: {
					read: member('id'),
					create: owner('ownerId'),
					update: member('id', 'edit'),
					delete: member('id', 'manage'),
				},
			},
			drafts: {
				fields: { documentId: t.string(), body: t.string() },
				access: {
					read: member('documentId', 'edit', { group: 'documents' }),
					create: member('documentId', 'edit', { group: 'documents' }),
					// Broader than read: an accepted write does not mean the writer may read.
					update: anyone({ writes: true }),
				},
			},
			comments: {
				fields: {
					documentId: t.string(),
					body: t.string(),
					authorId: commentsReadRole === 'none' ? t.string() : t.string().stamp('userId'),
				},
				// 'none': the deploy drops the collection's rules (readable by everyone).
				...(commentsReadRole === 'none'
					? {}
					: {
							access: {
								read: member('documentId', commentsReadRole, { group: 'documents' }),
								create: member('documentId', 'view', { group: 'documents' }),
							},
						}),
			},
		},
	})
}

const schema = makeSchema('view')

const auth = new TokenAuthProvider({
	validate: async (token) => (['ann', 'bob'].includes(token) ? { userId: token } : null),
})

const FRESH = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

interface Delivered {
	key: string
	nodeId: string
}

function delivered(messages: SyncMessage[]): Delivered[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch'
			? (m.operations as Array<{ collection: string; recordId: string; nodeId: string }>).map(
					(op) => ({ key: `${op.collection}/${op.recordId}`, nodeId: op.nodeId }),
				)
			: [],
	)
}

/** Records the client removes (narrowings judged on what it holds, and retractions). */
function retracted(messages: SyncMessage[], before: SyncMessage[] = []): string[] {
	return items(messages, before)
		.filter((item) => item.kind === 'retract')
		.map((item) => item.key)
}

/** The read rules' key the client keeps (the last batch that carried one). */
function rulesKeyOf(messages: SyncMessage[]): string | undefined {
	let key: string | undefined
	for (const m of messages) {
		const value = (m as { accessRulesKey?: string }).accessRulesKey
		if (m.type === 'operation-batch' && value) key = value
	}
	return key
}

/** Highest delivery sequence the client was sent (its watermark if it applies all). */
function watermarkOf(messages: SyncMessage[]): number {
	let max = 0
	for (const m of messages) {
		const value = (m as { maxDeliverySequence?: number }).maxDeliverySequence
		if (m.type === 'operation-batch' && typeof value === 'number') max = Math.max(max, value)
	}
	return max
}

async function setup() {
	const harness = await createHarness(schema, auth, { experimentalAccessRules: true })
	const ann = await harness.login('ann', 'ann-node', FRESH)
	const create = makeOp('ann-node', 1, {
		collection: 'documents',
		recordId: 'd1',
		data: { title: 'v1', ownerId: 'ann' },
	})
	const comment = makeOp('ann-node', 2, {
		collection: 'comments',
		recordId: 'c1',
		data: { documentId: 'd1', body: 'first', authorId: 'ann' },
	})
	const edit = makeOp('ann-node', 3, {
		type: 'update',
		collection: 'documents',
		recordId: 'd1',
		data: { title: 'v2' },
	})
	ann.send(batch([create, comment, edit]))
	await tick(150)
	return { harness, ann, create, edit }
}

describe('re-scoping on membership changes', () => {
	test('a grant reaches a connected client at once, as current state, never earlier history', async () => {
		const { harness, create, edit } = await setup()
		const bob = await harness.login('bob', 'bob-node', FRESH)
		expect(delivered(bob.messages).map((d) => d.key)).not.toContain('documents/d1')

		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await vi.waitFor(
			() => expect(delivered(bob.messages).map((d) => d.key)).toContain('documents/d1'),
			{ timeout: 3000 },
		)
		const got = delivered(bob.messages)
		// The document and its comment arrive as scope entries (current values)...
		expect(got).toContainEqual({ key: 'documents/d1', nodeId: 'kora:scope-entry' })
		expect(got).toContainEqual({ key: 'comments/c1', nodeId: 'kora:scope-entry' })
		// ...and none of the history written before bob joined.
		const ids = bob.messages.flatMap((m) =>
			m.type === 'operation-batch' ? (m.operations as Array<{ id: string }>).map((o) => o.id) : [],
		)
		expect(ids).not.toContain(create.id)
		expect(ids).not.toContain(edit.id)
	})

	test('a revoke retracts the group from a connected client, and later edits are not sent', async () => {
		const { harness, ann } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		expect(delivered(bob.messages).map((d) => d.key)).toContain('documents/d1')

		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		await vi.waitFor(
			() =>
				expect(retracted(bob.messages)).toEqual(
					expect.arrayContaining(['documents/d1', 'comments/c1']),
				),
			{ timeout: 3000 },
		)
		const before = bob.messages.length
		const later = makeOp('ann-node', 4, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'secret' },
		})
		ann.send(batch([later]))
		await tick(300)
		const ids = bob.messages
			.slice(before)
			.flatMap((m) =>
				m.type === 'operation-batch'
					? (m.operations as Array<{ id: string }>).map((o) => o.id)
					: [],
			)
		expect(ids).not.toContain(later.id)
	})

	test('a fresh device of a late joiner gets entries, not the history before joining', async () => {
		const { harness, create, edit } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const device = await harness.login('bob', 'bob-node-2', FRESH)
		await tick(200)
		const got = delivered(device.messages)
		expect(got).toContainEqual({ key: 'documents/d1', nodeId: 'kora:scope-entry' })
		const ids = device.messages.flatMap((m) =>
			m.type === 'operation-batch' ? (m.operations as Array<{ id: string }>).map((o) => o.id) : [],
		)
		expect(ids).not.toContain(create.id)
		expect(ids).not.toContain(edit.id)
	})

	test('a reconnect after a revoke keeps the watermark and narrows the client', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const first = await harness.login('bob', 'bob-node', FRESH)
		await tick(150)
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as
			| { acceptedDownlinkScopes?: Record<string, Record<string, unknown>> }
			| undefined
		const watermark = watermarkOf(first.messages)
		expect(watermark).toBeGreaterThan(0)
		await first.client.disconnect()

		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: watermark,
			acceptedScopeKey: scopeViewKey(accepted?.acceptedDownlinkScopes),
			acceptedScopeWatermark: watermark,
		} as Partial<SyncMessage>)
		await tick(150)
		const batches = second.messages.filter((m) => m.type === 'operation-batch') as Array<{
			baseDeliverySequence?: number
		}>
		// Resumed, not restarted from 0.
		expect(batches[0]?.baseDeliverySequence).toBe(watermark)
		expect(retracted(second.messages, first.messages)).toEqual(
			expect.arrayContaining(['documents/d1', 'comments/c1']),
		)
		expect(delivered(second.messages).map((d) => d.key)).not.toContain('documents/d1')
	})

	test('entries follow the client query view', async () => {
		const { harness, ann } = await setup()
		ann.send(
			batch([
				makeOp('ann-node', 4, {
					collection: 'comments',
					recordId: 'c2',
					data: { documentId: 'd1', body: 'other', authorId: 'ann' },
				}),
			]),
		)
		await tick(150)
		const bob = await harness.login('bob', 'bob-node', {
			...FRESH,
			syncQueries: [{ collection: 'comments', where: { body: 'first' } }],
		} as Partial<SyncMessage>)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await vi.waitFor(
			() => expect(delivered(bob.messages).map((d) => d.key)).toContain('comments/c1'),
			{ timeout: 3000 },
		)
		const keys = delivered(bob.messages).map((d) => d.key)
		expect(keys).toContain('documents/d1')
		expect(keys).not.toContain('comments/c2')
	})

	test('a read-rule deploy narrows a reconnecting client and re-sends what it may read', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const first = await harness.login('bob', 'bob-node', FRESH)
		await tick(150)
		expect(delivered(first.messages).map((d) => d.key)).toContain('comments/c1')
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		const watermark = watermarkOf(first.messages)
		await first.client.disconnect()

		// Comments now need edit to read; nothing about memberships changed.
		const tightened = makeSchema('edit')
		await harness.store.setSchema(tightened, { accessRulesEnforced: true })

		expect(rulesKeyOf(first.messages)).toBeTruthy()
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: watermark,
			acceptedScopeKey: scopeViewKey(accepted.acceptedDownlinkScopes),
			acceptedScopeWatermark: watermark,
			accessRulesKey: rulesKeyOf(first.messages),
		} as Partial<SyncMessage>)
		await tick(150)
		expect(rulesKeyOf(second.messages)).not.toBe(rulesKeyOf(first.messages))
		expect(retracted(second.messages, first.messages)).toContain('comments/c1')
		// What it may still read is re-sent (the client cannot tell what survived).
		expect(delivered(second.messages).map((d) => d.key)).toContain('documents/d1')

		// A later reconnect after that is quiet again.
		const acceptedAgain = second.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		const third = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: watermarkOf(second.messages),
			acceptedScopeKey: scopeViewKey(acceptedAgain.acceptedDownlinkScopes),
			acceptedScopeWatermark: watermarkOf(second.messages),
			accessRulesKey: rulesKeyOf(second.messages),
		} as Partial<SyncMessage>)
		await tick(150)
		const batches = third.messages.filter((m) => m.type === 'operation-batch') as Array<{
			baseDeliverySequence?: number
		}>
		expect(batches[0]?.baseDeliverySequence).toBe(watermarkOf(second.messages))
		expect(
			third.messages.some(
				(m) => m.type === 'operation-batch' && (m as { accessNarrowing?: unknown }).accessNarrowing,
			),
		).toBe(false)
	})

	test('a deploy that drops a collection rules sends what the client was denied', async () => {
		const { harness, ann } = await setup()
		// A comment on a document bob is not a member of.
		ann.send(
			batch([
				makeOp('ann-node', 4, {
					collection: 'documents',
					recordId: 'd2',
					data: { title: 'other', ownerId: 'ann' },
				}),
				makeOp('ann-node', 5, {
					collection: 'comments',
					recordId: 'c2',
					data: { documentId: 'd2', body: 'elsewhere', authorId: 'ann' },
				}),
			]),
		)
		await tick(150)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const first = await harness.login('bob', 'bob-node', FRESH)
		await tick(150)
		expect(delivered(first.messages).map((d) => d.key)).not.toContain('comments/c2')
		const accepted = first.messages.find((m) => m.type === 'handshake-response') as {
			acceptedDownlinkScopes?: Record<string, Record<string, unknown>>
		}
		const watermark = watermarkOf(first.messages)
		await first.client.disconnect()

		await harness.store.setSchema(makeSchema('none'), { accessRulesEnforced: true })
		const second = await harness.login('bob', 'bob-node', {
			supportsScopeDisjunction: true,
			lastDeliverySequence: watermark,
			acceptedScopeKey: scopeViewKey(accepted.acceptedDownlinkScopes),
			acceptedScopeWatermark: watermark,
			accessRulesKey: rulesKeyOf(first.messages),
		} as Partial<SyncMessage>)
		await tick(150)
		expect(delivered(second.messages).map((d) => d.key)).toEqual(
			expect.arrayContaining(['comments/c1', 'comments/c2']),
		)
		expect(retracted(second.messages, first.messages)).not.toContain('comments/c1')
	})

	test('an accepted write to a record the writer may not read retracts it from the writer', async () => {
		const { harness, ann } = await setup()
		ann.send(
			batch([
				makeOp('ann-node', 4, {
					collection: 'drafts',
					recordId: 's1',
					data: { documentId: 'd1', body: 'secret' },
				}),
			]),
		)
		await tick(150)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(150)
		expect(delivered(bob.messages).map((d) => d.key)).not.toContain('drafts/s1')

		bob.send(
			batch([
				makeOp('bob-node', 1, {
					type: 'update',
					collection: 'drafts',
					recordId: 's1',
					data: { body: 'blind edit' },
				}),
			]),
		)
		await vi.waitFor(() => expect(retracted(bob.messages)).toContain('drafts/s1'), {
			timeout: 3000,
		})
		expect(bob.messages.some((m) => m.type === 'operation-rejected')).toBe(false)
	})

	test('a record the writer created itself is not retracted', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', FRESH)
		await tick(150)
		bob.send(
			batch([
				makeOp('bob-node', 1, {
					collection: 'comments',
					recordId: 'c9',
					data: { documentId: 'd1', body: 'mine', authorId: 'bob' },
				}),
			]),
		)
		await tick(300)
		expect(retracted(bob.messages)).not.toContain('comments/c9')
	})

	test('the accepted scope the client sees does not change with memberships', async () => {
		const { harness } = await setup()
		const before = await harness.login('bob', 'bob-node', FRESH)
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const after = await harness.login('bob', 'bob-node-2', FRESH)
		const scopeOf = (messages: SyncMessage[]) =>
			(
				messages.find((m) => m.type === 'handshake-response') as {
					acceptedDownlinkScopes?: unknown
				}
			).acceptedDownlinkScopes
		expect(scopeOf(after.messages)).toEqual(scopeOf(before.messages))
	})
})
