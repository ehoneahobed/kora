/**
 * Rules that need a real membership (`member(..., { grants: false })`,
 * `memberOfKey(..., { grants: false })`): a capability grant (a share link) satisfies
 * every other membership rule, never these. Who has access to a document is
 * collaborator information, not document content.
 *
 * Runs on the memory store, or on Postgres with KORA_REPRO_STORE=postgres.
 */
import { defineSchema, member, memberOfKey, owner, t } from '@korajs/core'
import type { SyncMessage } from '@korajs/sync'
import { scopeViewKey } from '@korajs/sync/internal'
import { describe, expect, test, vi } from 'vitest'
import { TokenAuthProvider } from '../../src/auth/token-auth'
import type { AccessGrant, AuthContext } from '../../src/types'
import { batch, createHarness, makeOp } from '../repro/rt-fixture'
import { items } from './access-review/shared'

function makeSchema(membersOnly: boolean) {
	const grants = membersOnly ? { grants: false } : {}
	return defineSchema({
		version: 1,
		access: {
			memberships: 'members',
			roles: ['view', 'comment', 'edit', 'manage'],
			groups: { documents: { owner: 'ownerId', role: 'manage' } },
		},
		collections: {
			members: {
				fields: { userId: t.string(), group: t.string(), role: t.string() },
				access: { read: memberOfKey('group', undefined, grants) },
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
			// Collaborator notes: for people on the document, not for link holders.
			notes: {
				fields: { documentId: t.string(), body: t.string() },
				access: {
					read: member('documentId', 'view', { group: 'documents', ...grants }),
					create: member('documentId', 'comment', { group: 'documents', ...grants }),
				},
			},
		},
	})
}

const schema = makeSchema(true)

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

function rulesKeyOf(messages: SyncMessage[]): string | undefined {
	let key: string | undefined
	for (const m of messages) {
		const value = (m as { accessRulesKey?: string }).accessRulesKey
		if (m.type === 'operation-batch' && value) key = value
	}
	return key
}

function retracted(messages: SyncMessage[], before: SyncMessage[] = []): string[] {
	return items(messages, before)
		.filter((item) => item.kind === 'retract')
		.map((item) => item.key)
}

/** Wait until the session's initial sync completed (its final batch arrived). */
async function caughtUp(client: { messages: SyncMessage[] }): Promise<void> {
	await vi.waitFor(
		() =>
			expect(
				client.messages.some(
					(m) => m.type === 'operation-batch' && (m as { isFinal?: boolean }).isFinal === true,
				),
			).toBe(true),
		{ timeout: 5000 },
	)
}

/** The records a device that applied every batch holds afterwards. */
function heldAfter(messages: SyncMessage[]): string[] {
	const held = new Set<string>()
	for (const item of items(messages)) {
		// A delete operation carries no data.
		if (item.kind === 'retract' || item.data === null) held.delete(item.key)
		else held.add(item.key)
	}
	return [...held].sort()
}

/** What a device that applied everything it was sent hands the server when it reconnects. */
function resumeFrom(client: { messages: SyncMessage[] }): Partial<SyncMessage> {
	let seq = 0
	for (const m of client.messages) {
		const b = m as { type: string; maxDeliverySequence?: number }
		if (b.type === 'operation-batch' && typeof b.maxDeliverySequence === 'number') {
			seq = Math.max(seq, b.maxDeliverySequence)
		}
	}
	const response = [...client.messages].reverse().find((m) => m.type === 'handshake-response') as
		| { acceptedDownlinkScopes?: Record<string, Record<string, unknown>> }
		| undefined
	const key = rulesKeyOf(client.messages)
	return {
		...CAPABLE,
		lastDeliverySequence: seq,
		acceptedScopeWatermark: seq,
		acceptedScopeKey: scopeViewKey(response?.acceptedDownlinkScopes ?? {}),
		...(key ? { accessRulesKey: key } : {}),
	} as Partial<SyncMessage>
}

async function setup(rules = schema) {
	grantsFor = {}
	const harness = await createHarness(rules, auth)
	const ann = await harness.login('ann', 'ann-node', CAPABLE)
	const ops = [
		makeOp('ann-node', 1, {
			collection: 'documents',
			recordId: 'd1',
			data: { title: 'Shared', ownerId: 'ann' },
		}),
		makeOp('ann-node', 2, {
			collection: 'comments',
			recordId: 'c1',
			data: { documentId: 'd1', body: 'public comment' },
		}),
		makeOp('ann-node', 3, {
			collection: 'notes',
			recordId: 'n1',
			data: { documentId: 'd1', body: 'for collaborators' },
		}),
	]
	ann.send(batch(ops))
	await vi.waitFor(() => expect(acknowledged(ann.messages)).toBe(true))
	for (const op of ops) expect(rejectionFor(ann.messages, op.id)).toBeNull()
	// A collaborator, so the document has a member list beyond its owner.
	await harness.server.access.grant({ userId: 'carol', group: ['documents', 'd1'], role: 'edit' })
	return { harness, ann }
}

function memberRows(keys: string[]): string[] {
	return keys.filter((key) => key.startsWith('members/'))
}

describe('rules that need a real membership ({ grants: false })', () => {
	test('an anonymous link holder gets the document, never its member list or collaborator notes', async () => {
		const { harness } = await setup()
		const visitor = await harness.login('link:d1:manage', 'visitor-node', CAPABLE)
		await caughtUp(visitor)
		const got = delivered(visitor.messages)
		expect(got).toContain('documents/d1')
		expect(got).toContain('comments/c1')
		expect(memberRows(got)).toEqual([])
		expect(got).not.toContain('notes/n1')
	})

	test('under the default rule the same link holder does receive the member list', async () => {
		const { harness } = await setup(makeSchema(false))
		const visitor = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		await caughtUp(visitor)
		const got = delivered(visitor.messages)
		expect(memberRows(got).length).toBeGreaterThan(0)
		expect(got).toContain('notes/n1')
	})

	test('a real member and the owner receive the member list and notes', async () => {
		const { harness } = await setup()
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		await caughtUp(bob)
		expect(memberRows(delivered(bob.messages)).length).toBeGreaterThan(0)
		expect(delivered(bob.messages)).toContain('notes/n1')
		const owner = await harness.login('ann', 'ann-node-2', CAPABLE)
		await caughtUp(owner)
		expect(memberRows(delivered(owner.messages)).length).toBeGreaterThan(0)
		expect(delivered(owner.messages)).toContain('notes/n1')
	})

	test('a signed-in user holding only a grant is treated as a link holder', async () => {
		const { harness } = await setup()
		grantsFor = { bob: [{ group: 'documents:d1', role: 'manage' }] }
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		await caughtUp(bob)
		const got = delivered(bob.messages)
		expect(got).toContain('documents/d1')
		expect(memberRows(got)).toEqual([])
		expect(got).not.toContain('notes/n1')
	})

	test('writes under a grants: false rule need the membership role, not the grant role', async () => {
		const { harness } = await setup()
		// A manage grant and a view membership: the note needs comment from a membership.
		grantsFor = { bob: [{ group: 'documents:d1', role: 'manage' }] }
		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		const note = makeOp('bob-node', 1, {
			collection: 'notes',
			recordId: 'n2',
			data: { documentId: 'd1', body: 'not with a view membership' },
		})
		const comment = makeOp('bob-node', 2, {
			collection: 'comments',
			recordId: 'c2',
			data: { documentId: 'd1', body: 'the grant allows this' },
		})
		bob.send(batch([note, comment]))
		await vi.waitFor(() => expect(rejectionFor(bob.messages, note.id)).toBe('ACCESS_DENIED'))
		await vi.waitFor(() => expect(acknowledged(bob.messages)).toBe(true))
		expect(rejectionFor(bob.messages, comment.id)).toBeNull()
		// The membership role (view) still reads the notes.
		await vi.waitFor(() => expect(delivered(bob.messages)).toContain('notes/n1'))

		const visitor = await harness.login('link:d1:manage', 'visitor-node', CAPABLE)
		const fromLink = makeOp('visitor-node', 1, {
			collection: 'notes',
			recordId: 'n3',
			data: { documentId: 'd1', body: 'a link cannot write notes' },
		})
		visitor.send(batch([fromLink]))
		await vi.waitFor(() =>
			expect(rejectionFor(visitor.messages, fromLink.id)).toBe('ACCESS_DENIED'),
		)
		expect(await harness.store.findRecord('notes', 'n2')).toBeNull()
		expect(await harness.store.findRecord('notes', 'n3')).toBeNull()
		expect(await harness.store.findRecord('comments', 'c2')).not.toBeNull()
	})

	test('a membership granted and revoked during a grant holder session re-scopes the members-only collections', async () => {
		const { harness } = await setup()
		grantsFor = { bob: [{ group: 'documents:d1', role: 'view' }] }
		const bob = await harness.login('bob', 'bob-node', CAPABLE)
		await caughtUp(bob)
		expect(memberRows(delivered(bob.messages))).toEqual([])

		await harness.server.access.grant({ userId: 'bob', group: ['documents', 'd1'], role: 'view' })
		await vi.waitFor(() => expect(delivered(bob.messages)).toContain('notes/n1'), {
			timeout: 3000,
		})
		expect(memberRows(delivered(bob.messages)).length).toBeGreaterThan(0)

		await harness.server.access.revoke({ userId: 'bob', group: ['documents', 'd1'] })
		await vi.waitFor(() => expect(retracted(bob.messages)).toContain('notes/n1'), {
			timeout: 3000,
		})
		// The grant still holds the document and its comments (the re-scope may drop and
		// re-send them); the member list and the notes are gone.
		await vi.waitFor(() => expect(heldAfter(bob.messages)).toContain('documents/d1'), {
			timeout: 3000,
		})
		const held = heldAfter(bob.messages)
		expect(held).toContain('comments/c1')
		expect(held).not.toContain('notes/n1')
		expect(memberRows(held)).toEqual([])
	})

	test('turning grants off is a read-rule change: a link holder reconnecting is re-scoped in full', async () => {
		const { harness } = await setup(makeSchema(false))
		const first = await harness.login('link:d1:view', 'visitor-node', CAPABLE)
		await caughtUp(first)
		expect(memberRows(delivered(first.messages)).length).toBeGreaterThan(0)
		const held = resumeFrom(first)
		await first.client.disconnect()

		await harness.store.setSchema(makeSchema(true))
		const second = await harness.login('link:d1:view', 'visitor-node', held)
		await caughtUp(second)
		await vi.waitFor(
			() => expect(retracted(second.messages, first.messages)).toContain('notes/n1'),
			{ timeout: 5000 },
		)
		expect(rulesKeyOf(second.messages)).not.toBe(rulesKeyOf(first.messages))
		const gone = retracted(second.messages, first.messages)
		expect(gone).toContain('notes/n1')
		expect(memberRows(gone).length).toBeGreaterThan(0)
		expect(gone).not.toContain('documents/d1')
	})
})
