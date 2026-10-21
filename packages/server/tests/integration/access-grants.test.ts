/**
 * Capability grants (`AuthContext.accessGrants`): a credential such as a share link holds
 * a role in a group without a membership row. Under access rules it acts as a membership
 * of the session's principal, for anonymous sessions too, and nothing else.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { scopeViewKey } from '@korajs/sync/internal'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import { MemoryServerStore } from '../../src/store/memory-server-store'
import type { AccessGrant, AuthContext } from '../../src/types'
import { batch, createHarness, makeOp } from '../repro/rt-fixture'
import { items } from './access-review/shared'

const schema = defineSchema({
	version: 1,
	access: {
		memberships: 'members',
		roles: ['view', 'comment', 'edit', 'manage'],
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
		comments: {
			fields: { documentId: t.string(), body: t.string() },
			access: {
				read: member('documentId', 'view', { group: 'documents' }),
				create: member('documentId', 'comment', { group: 'documents' }),
			},
		},
	},
})

/** Share-link tokens (`link:<document>:<role>`) give anonymous sessions a grant. */
let grantsFor: Record<string, AccessGrant[]> = {}
const auth = new TokenAuthProvider({
	validate: async (token): Promise<AuthContext | null> => {
		if (token.startsWith('link:')) {
			const [, documentId, role] = token.split(':')
			return {
				userId: `anon-${token}`,
				anonymous: true,
				accessGrants: [{ group: ['documents', documentId ?? ''], role: role ?? 'view' }],
			}
		}
		if (['ann', 'bob'].includes(token)) {
			return { userId: token, accessGrants: grantsFor[token] ?? [] }
		}
		return null
	},
})

const CAPABLE = { supportsScopeDisjunction: true, lastDeliverySequence: 0 } as Partial<SyncMessage>

function delivered(messages: SyncMessage[]): string[] {
	return messages.flatMap((m) =>
		m.type === 'operation-batch'
			? (m.operations as Array<{ collection: string; recordId: string }>).map(
					(op) => `${op.collection}/${op.recordId}`,
				)
			: [],
	)
}

function rejectionFor(messages: SyncMessage[], operationId: string): string | null {
	for (const m of messages) {
		if (m.type === 'operation-rejected' && m.operationId === operationId) return m.code
	}
	return null
}

function acknowledged(messages: SyncMessage[]): boolean {
	return messages.some((m) => m.type === 'acknowledgment')
}

function errorCode(messages: SyncMessage[]): string | null {
	const error = messages.find((m) => m.type === 'error') as { code?: string } | undefined
	return error?.code ?? null
}

function acknowledgedCount(messages: SyncMessage[]): number {
	return messages.filter((m) => m.type === 'acknowledgment').length
}

/** Records the client removes, judged on what it held from `before` (an earlier connection). */
function retracted(messages: SyncMessage[], before: SyncMessage[] = []): string[] {
	return items(messages, before)
		.filter((item) => item.kind === 'retract')
		.map((item) => item.key)
}

/**
 * What a device that applied everything it was sent hands the server when it
 * reconnects: its watermark, its accepted scope and the rules key it was scoped under.
 */
function resumeFrom(client: {
	messages: SyncMessage[]
	send: (m: SyncMessage) => void
}): Partial<SyncMessage> {
	let seq = 0
	let key: string | undefined
	for (const m of client.messages) {
		if (m.type !== 'operation-batch') continue
		const b = m as unknown as {
			messageId: string
			maxDeliverySequence?: number
			accessRulesKey?: string
		}
		if (typeof b.maxDeliverySequence === 'number') seq = Math.max(seq, b.maxDeliverySequence)
		if (b.accessRulesKey) key = b.accessRulesKey
	}
	const response = [...client.messages].reverse().find((m) => m.type === 'handshake-response') as
		| { acceptedDownlinkScopes?: Record<string, Record<string, unknown>> }
		| undefined
	return {
		...CAPABLE,
		lastDeliverySequence: seq,
		acceptedScopeWatermark: seq,
		acceptedScopeKey: scopeViewKey(response?.acceptedDownlinkScopes ?? {}),
		...(key ? { accessRulesKey: key } : {}),
	} as Partial<SyncMessage>
}

async function setup() {
	grantsFor = {}
	const harness = await createHarness(schema, auth)
	const ann = await harness.login('ann', 'ann-node', CAPABLE)
	const ops = [
		makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Shared', ownerId: 'ann' },
		}),
		makeOp('ann-node', 2, {
			collection: 'documents',
			recordId: 'd2',
			data: { title: 'Private', ownerId: 'ann' },
		}),
		makeOp('ann-node', 3, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'on the shared one' },
		}),
		makeOp('ann-node', 4, {
			collection: 'comments',
			recordId: 'c2',
			data: { documentId: 'd2', body: 'on the private one' },
		}),
	]
	ann.send(batch(ops))
	await harness.settle()
	expect(acknowledged(ann.messages)).toBe(true)
	for (const op of ops) expect(rejectionFor(ann.messages, op.id)).toBeNull()
	return { harness, ann }
}

describe('capability grants', () => {
	test('an anonymous link visitor syncs the granted document and its comments, nothing else', async () => {
		const { harness } = await setup()
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		const got = delivered(visitor.messages)
		expect(got).toContain('documents/d1')
		expect(got).toContain('comments/c1')
		expect(got).not.toContain('documents/d2')
		expect(got).not.toContain('comments/c2')
	})

	test('the role of the grant decides writes, as for a member', async () => {
		const { harness } = await setup()
		const viewer = await harness.login('link:d1:view', 'viewer-node', CAPABLE)
		const fromViewer = makeOp('viewer-node', 1, {
			collection: 'comments',
			recordId: 'c3',
			data: { documentId: 'd1', body: 'viewers cannot comment' },
		})
		viewer.send(batch([fromViewer]))
		await harness.settle()
		expect(rejectionFor(viewer.messages, fromViewer.id)).toBe('ACCESS_DENIED')

		const commenter = await harness.login('link:d1:comment', 'commenter-node', CAPABLE)
		const comment = makeOp('commenter-node', 1, {
			collection: 'comments',
			recordId: 'c4',
			data: { documentId: 'd1', body: 'from the link' },
		})
		const elsewhere = makeOp('commenter-node', 2, {
			collection: 'comments',
			recordId: 'c5',
			data: { documentId: 'd2', body: 'not my document' },
		})
		const edit = makeOp('commenter-node', 3, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Renamed' },
			previousData: { title: 'Shared' },
		})
		commenter.send(batch([comment, elsewhere, edit]))
		await harness.settle()
		expect(rejectionFor(commenter.messages, edit.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(commenter.messages, comment.id)).toBeNull()
		expect(rejectionFor(commenter.messages, elsewhere.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('comments', 'c4')).not.toBeNull()
		expect(await harness.store.findRecord('comments', 'c5')).toBeNull()
	})

	test('a grant adds to a signed-in user’s memberships, and roleOf never sees it', async () => {
		const { harness } = await setup()
		grantsFor = { bob: [{ group: 'documents:d2', role: 'view' }] }
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const got = delivered(bob.messages)
		expect(got).toContain('documents/d2')
		expect(got).not.toContain('documents/d1')
		expect(await harness.server.access.roleOf('bob', ['documents', 'd2'])).toBeNull()
	})

	test('grants the schema cannot honor give nothing', async () => {
		const { harness } = await setup()
		grantsFor = {
			bob: [
				{ group: 'comments:c1', role: 'manage' },
				{ group: 'documents:d1', role: 'owner' },
				{ group: 'documents:missing', role: 'manage' },
				{ group: 'documents:d2', role: 'view', expiresAt: Date.now() - 1 },
			],
		}
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		expect(delivered(bob.messages).filter((key) => !key.startsWith('members/'))).toEqual([])
	})

	test('deleting the granted document ends the session; reconnecting retracts its comments', async () => {
		const { harness, ann } = await setup()
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		expect(delivered(visitor.messages)).toContain('comments/c1')
		const held = resumeFrom(visitor)
		const remove = makeOp('ann-node', 5, {
			type: 'delete',
			collection: 'documents',
			recordId: 'd1',
			data: null,
		})
		ann.send(batch([remove]))
		await harness.settle()
		expect(errorCode(visitor.messages)).toBe('SCOPE_CHANGED')
		const again = await harness.login('link:d1:view', 'visitor-node', held)
		await harness.settle()
		expect(retracted(again.messages, visitor.messages)).toContain('comments/c1')
	})

	test('a granted document deleted and restored before the session looks still ends it', async () => {
		const { harness, ann } = await setup()
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		ann.send(
			batch([
				makeOp('ann-node', 5, {
					type: 'delete',
					collection: 'documents',
					recordId: 'd1',
					data: null,
				}),
				makeOp('ann-node', 6, {
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'back' },
					previousData: { title: 'Shared' },
				}),
			]),
		)
		await harness.settle()
		expect(errorCode(visitor.messages)).toBe('SCOPE_CHANGED')
	})

	test('a group deleted while the device was away is retracted when it reconnects', async () => {
		const { harness, ann } = await setup()
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		const held = resumeFrom(visitor)
		visitor.client.disconnect()
		const remove = makeOp('ann-node', 5, {
			type: 'delete',
			collection: 'documents',
			recordId: 'd1',
			data: null,
		})
		ann.send(batch([remove]))
		await harness.settle()
		expect(acknowledgedCount(ann.messages)).toBeGreaterThan(1)
		const again = await harness.login('link:d1:view', 'visitor-node', held)
		await harness.settle()
		expect(retracted(again.messages, visitor.messages)).toContain('comments/c1')
	})

	test('a group restored while the device was away is sent again in full', async () => {
		const { harness, ann } = await setup()
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		ann.send(
			batch([
				makeOp('ann-node', 5, {
					type: 'delete',
					collection: 'documents',
					recordId: 'd1',
					data: null,
				}),
			]),
		)
		await harness.settle()
		expect(errorCode(visitor.messages)).toBe('SCOPE_CHANGED')
		// Reconnects while the document is deleted: re-scoped without it.
		const between = await harness.login('link:d1:view', 'visitor-node', resumeFrom(visitor))
		await harness.settle()
		expect(retracted(between.messages, visitor.messages)).toContain('comments/c1')
		const held = resumeFrom(between)
		between.client.disconnect()
		ann.send(
			batch([
				makeOp('ann-node', 6, {
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'back' },
					previousData: { title: 'Shared' },
				}),
			]),
		)
		await harness.settle()
		expect(acknowledgedCount(ann.messages)).toBeGreaterThan(2)
		const again = await harness.login('link:d1:view', 'visitor-node', held)
		await harness.settle()
		expect(delivered(again.messages)).toContain('comments/c1')
	})

	test('a write after the granted group was deleted is refused, on any instance', async () => {
		const { harness, ann } = await setup()
		// Another server instance on the same store, whose poll has not run.
		const other = await createHarness(
			schema,
			auth,
			{ deliveryPollIntervalMs: 60_000 },
			harness.store,
		)
		const manager = await other.login('link:d1:manage', 'manager-node', CAPABLE)
		ann.send(
			batch([
				makeOp('ann-node', 5, {
					type: 'delete',
					collection: 'documents',
					recordId: 'd1',
					data: null,
				}),
			]),
		)
		await harness.settle()
		expect(acknowledgedCount(ann.messages)).toBeGreaterThan(1)
		const revive = makeOp('manager-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'revived' },
			previousData: { title: 'Shared' },
		})
		const comment = makeOp('manager-node', 2, {
			collection: 'comments',
			recordId: 'c9',
			data: { documentId: 'd1', body: 'after the delete' },
		})
		manager.send(batch([comment, revive]))
		await other.settle()
		expect(rejectionFor(manager.messages, revive.id)).toBe('ACCESS_DENIED')
		expect(rejectionFor(manager.messages, comment.id)).toBe('ACCESS_DENIED')
		expect(await harness.store.findRecord('comments', 'c9')).toBeNull()
	})

	test('a manager link can delete the granted document itself', async () => {
		const { harness } = await setup()
		const manager = await harness.login('link:d1:manage', 'manager-node', CAPABLE)
		const remove = makeOp('manager-node', 1, {
			type: 'delete',
			collection: 'documents',
			recordId: 'd1',
			data: null,
		})
		manager.send(batch([remove]))
		await harness.settle()
		expect(acknowledged(manager.messages)).toBe(true)
		expect(rejectionFor(manager.messages, remove.id)).toBeNull()
		expect(await harness.store.findRecord('documents', 'd1')).toBeNull()
	})

	test('a write after the granted group was deleted and restored elsewhere is refused', async () => {
		const { harness, ann } = await setup()
		const other = await createHarness(
			schema,
			auth,
			{ deliveryPollIntervalMs: 60_000 },
			harness.store,
		)
		const manager = await other.login('link:d1:manage', 'manager-node', CAPABLE)
		ann.send(
			batch([
				makeOp('ann-node', 5, {
					type: 'delete',
					collection: 'documents',
					recordId: 'd1',
					data: null,
				}),
				makeOp('ann-node', 6, {
					type: 'update',
					collection: 'documents',
					recordId: 'd1',
					data: { title: 'back' },
					previousData: { title: 'Shared' },
				}),
			]),
		)
		await harness.settle()
		expect(acknowledgedCount(ann.messages)).toBeGreaterThan(1)
		const rename = makeOp('manager-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'stale session' },
			previousData: { title: 'back' },
		})
		manager.send(batch([rename]))
		await other.settle()
		expect(rejectionFor(manager.messages, rename.id)).toBe('ACCESS_DENIED')
		expect((await harness.store.findRecord('documents', 'd1'))?.title).toBe('back')
	})

	test('a granted group lost while a write is judged ends the session; the write is not refused', async () => {
		const { harness, ann } = await setup()
		grantsFor = { bob: [{ group: 'documents:d2', role: 'view' }] }
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
		// The grant reaches ann's stream before the second instance starts: it shares this
		// store object, and setting its schema marks the membership index not ready for
		// the moment it takes, so a push to ann racing it would end her session
		// (ACCESS_RULES_CHANGED) and her delete below would never be judged.
		await harness.settle()
		// Bob on another instance, whose poll has not run.
		const other = await createHarness(
			schema,
			auth,
			{ deliveryPollIntervalMs: 60_000 },
			harness.store,
		)
		const bob = await other.login('bob', 'bob-node', CAPABLE)
		ann.send(
			batch([
				makeOp('ann-node', 5, {
					type: 'delete',
					collection: 'documents',
					recordId: 'd2',
					data: null,
				}),
			]),
		)
		await harness.settle()
		expect(acknowledgedCount(ann.messages)).toBeGreaterThan(1)
		// The pre-check still saw d2 live (the delete landed between it and the commit).
		const store = harness.store as unknown as {
			getLiveGroups: (groups: readonly string[], since?: number) => Promise<ReadonlySet<string>>
		}
		store.getLiveGroups = async (groups) => new Set(groups)
		const rename = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Bob edits his own group' },
			previousData: { title: 'Shared' },
		})
		expect(errorCode(bob.messages)).toBeNull()
		bob.send(batch([rename]))
		await other.settle()
		expect(errorCode(bob.messages)).toBe('SCOPE_CHANGED')
		expect(rejectionFor(bob.messages, rename.id)).toBeNull()
		expect(
			(await harness.store.findOperationResolutions?.('bob-node', [rename.id]))?.get(rename.id),
		).toBeUndefined()
	})

	test('a grant that expires while a write is judged ends the session; the write is not refused', async () => {
		const { harness } = await setup()
		grantsFor = { bob: [{ group: 'documents:d2', role: 'view', expiresAt: Date.now() + 60_000 }] }
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'edit' })
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		// The grant expires between the checks and the commit.
		const store = harness.store as unknown as {
			applyRemoteOperation: (...args: unknown[]) => Promise<unknown>
		}
		const apply = store.applyRemoteOperation.bind(harness.store)
		store.applyRemoteOperation = async (...args: unknown[]) => {
			const realNow = Date.now
			Date.now = () => realNow() + 120_000
			try {
				return await apply(...args)
			} finally {
				Date.now = realNow
			}
		}
		const rename = makeOp('bob-node', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'late' },
			previousData: { title: 'Shared' },
		})
		bob.send(batch([rename]))
		await harness.settle()
		expect(errorCode(bob.messages)).toBe('SCOPE_CHANGED')
		expect(rejectionFor(bob.messages, rename.id)).toBeNull()
		expect((await harness.store.findRecord('documents', 'd1'))?.title).toBe('Shared')
	})

	test('with a store that cannot check grants at commit, grants authorize no write; memberships do', async () => {
		const store = new MemoryServerStore('server-1')
		Object.defineProperty(store, 'reportsLiveGroups', { value: false })
		grantsFor = {}
		const harness = await createHarness(schema, auth, {}, store)
		const ann = await harness.login('ann', 'ann-node', CAPABLE)
		const create = makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Shared', ownerId: 'ann' },
		})
		ann.send(batch([create]))
		await harness.settle()
		expect(acknowledged(ann.messages)).toBe(true)
		// Ann also holds a grant: her own (owner) writes are still decided by her membership.
		grantsFor = { ann: [{ group: 'documents:d1', role: 'view' }] }
		const again = await harness.login('ann', 'ann-node-2', CAPABLE)
		const rename = makeOp('ann-node-2', 1, {
			type: 'update',
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Renamed' },
			previousData: { title: 'Shared' },
		})
		again.send(batch([rename]))
		await harness.settle()
		expect(acknowledged(again.messages)).toBe(true)
		expect(rejectionFor(again.messages, rename.id)).toBeNull()
		// A link visitor can read, but its grant writes nothing.
		const commenter = await harness.login('link:d1:comment', 'commenter-node', CAPABLE)
		expect(delivered(commenter.messages)).toContain('documents/d1')
		const comment = makeOp('commenter-node', 1, {
			collection: 'comments',
			recordId: 'c4',
			data: { documentId: 'd1', body: 'from the link' },
		})
		commenter.send(batch([comment]))
		await harness.settle()
		expect(rejectionFor(commenter.messages, comment.id)).toBe('ACCESS_DENIED')
	})

	test('a grant that expires ends the session, without a delivery poll', async () => {
		const { harness } = await setup()
		// The grant's own timer ends the session. A controlled clock drives it: on the wall
		// clock a slow login could outlast a short grant and see it already expired.
		vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
		try {
			const expiresIn = 60_000
			grantsFor = {
				bob: [{ group: 'documents:d1', role: 'view', expiresAt: Date.now() + expiresIn }],
			}
			const bob = await harness.login('bob', 'bob-node', CAPABLE)
			expect(delivered(bob.messages)).toContain('documents/d1')
			expect(errorCode(bob.messages)).toBeNull()
			// No delivery poll runs here (the harness polls by hand).
			await vi.advanceTimersByTimeAsync(expiresIn)
			await harness.settle()
			expect(errorCode(bob.messages)).toBe('SCOPE_CHANGED')
		} finally {
			vi.useRealTimers()
		}
	})

	test('a session whose grants changed is ended when its credential is checked again', async () => {
		const { harness } = await setup()
		grantsFor = { bob: [{ group: 'documents:d1', role: 'view' }] }
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		expect(delivered(bob.messages)).toContain('documents/d1')
		grantsFor = { bob: [] }
		await harness.server.refreshScopes('bob')
		await harness.settle()
		expect(
			bob.messages.some(
				(m) => m.type === 'error' && (m as { code?: string }).code === 'SCOPE_CHANGED',
			),
		).toBe(true)
	})
})
