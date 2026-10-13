/**
 * The trust boundary: escalation, stale authority, enumeration and abuse. Each test is a
 * way a member, a former member or a stranger could try to gain or keep access.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { SPACE_INVITATIONS, spacesCollections } from '../../src/index'
import { type Harness, STORE_KINDS, type StoreKind, codeOf, createHarness } from './fixture'

const open: Harness[] = []
async function harness(
	kind: StoreKind,
	overrides?: Parameters<typeof createHarness>[1],
): Promise<Harness> {
	const h = await createHarness(kind, overrides)
	open.push(h)
	return h
}
afterEach(async () => {
	for (const h of open.splice(0)) await h.close()
})

const F1 = ['forms', 'f1'] as const

describe.each(STORE_KINDS)('the spaces trust boundary on the %s store', (kind) => {
	test('below the manager role nobody invites, changes roles or removes', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'editor')
		await h.join('ann', 'cat', 'f1', 'viewer')
		expect(
			codeOf(
				await h.call('bob', '/invitations/create', {
					space: F1,
					email: 'dan@example.com',
					role: 'viewer',
				}),
			),
		).toBe('FORBIDDEN')
		expect(
			codeOf(await h.call('bob', '/members/role', { space: F1, userId: 'cat', role: 'editor' })),
		).toBe('FORBIDDEN')
		expect(codeOf(await h.call('bob', '/members/remove', { space: F1, userId: 'cat' }))).toBe(
			'FORBIDDEN',
		)
		expect(
			codeOf(
				await h.call('dan', '/invitations/create', {
					space: F1,
					email: 'x@example.com',
					role: 'viewer',
				}),
			),
		).toBe('FORBIDDEN')
		expect(
			codeOf(
				await h.call(null, '/invitations/create', {
					space: F1,
					email: 'x@example.com',
					role: 'viewer',
				}),
			),
		).toBe('UNAUTHENTICATED')
	})

	test('a demoted inviter’s invitations die with the demotion', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('bob', '/invitations/create', {
			space: F1,
			email: 'cat@example.com',
			role: 'editor',
		})
		const token = h.tokenFor('cat@example.com')
		const demoted = await h.call('ann', '/members/role', {
			space: F1,
			userId: 'bob',
			role: 'editor',
		})
		expect(demoted.body).toMatchObject({ invitationsRevoked: 1 })
		expect(codeOf(await h.call('cat', '/invitations/accept', { token }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		expect(await h.roleOf('cat', 'f1')).toBeNull()
	})

	test('a demotion made outside the kit (server.access) also kills the invitation, even after a re-promotion', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('bob', '/invitations/create', {
			space: F1,
			email: 'cat@example.com',
			role: 'editor',
		})
		const token = h.tokenFor('cat@example.com')
		await h.server.access.grant({ userId: 'bob', group: F1, role: 'viewer' })
		await h.server.access.grant({ userId: 'bob', group: F1, role: 'admin' })
		expect(codeOf(await h.call('cat', '/invitations/accept', { token }))).toBe(
			'INVITER_NO_LONGER_AUTHORIZED',
		)
		expect(await h.roleOf('cat', 'f1')).toBeNull()
	})

	test('an inviter removed and added back cannot revive their old invitations', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('bob', '/invitations/create', {
			space: F1,
			email: 'cat@example.com',
			role: 'editor',
		})
		const token = h.tokenFor('cat@example.com')
		await h.server.access.revoke({ userId: 'bob', group: F1 })
		await h.server.access.grant({ userId: 'bob', group: F1, role: 'admin' })
		expect(codeOf(await h.call('cat', '/invitations/accept', { token }))).toBe(
			'INVITER_NO_LONGER_AUTHORIZED',
		)
	})

	test('operator transfers away and back (A to B to A) kill every pending invitation', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'cat@example.com',
			role: 'admin',
		})
		await h.call('bob', '/invitations/create', {
			space: F1,
			email: 'dan@example.com',
			role: 'editor',
		})
		const catToken = h.tokenFor('cat@example.com')
		const danToken = h.tokenFor('dan@example.com')
		// Raw engine transfers, which know nothing of the kit's rows.
		await h.server.access.transfer({ group: F1, toUserId: 'bob' })
		await h.server.access.transfer({ group: F1, toUserId: 'ann' })
		expect(codeOf(await h.call('cat', '/invitations/accept', { token: catToken }))).toBe(
			'INVITER_NO_LONGER_AUTHORIZED',
		)
		expect(codeOf(await h.call('dan', '/invitations/accept', { token: danToken }))).toBe(
			'INVITER_NO_LONGER_AUTHORIZED',
		)
	})

	test('an invitation to a deleted space cannot be accepted', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'bob@example.com',
			role: 'editor',
		})
		const token = h.tokenFor('bob@example.com')
		await h.server.getKoraContext().apply({ collection: 'forms', type: 'delete', recordId: 'f1' })
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe('SPACE_NOT_FOUND')
		expect(await h.roleOf('bob', 'f1')).toBeNull()
	})

	test('an invitation never changes an existing member’s role; it is consumed instead', async () => {
		// Without an address lookup, the kit learns that the invitee is a member only at accept.
		const h = await harness(kind, { findUserByEmail: undefined })
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'bob@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('bob@example.com')
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe('ALREADY_MEMBER')
		expect(await h.roleOf('bob', 'f1')).toBe('admin')
		expect(await h.server.getKoraContext().query(SPACE_INVITATIONS)).toHaveLength(0)
	})

	test('revoking: the sender, or a manager above the invited role; others are told nothing exists', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.join('ann', 'cat', 'f1', 'editor')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'dan@example.com',
			role: 'admin',
		})
		const invitationId = h.tokenFor('dan@example.com').split('.')[0]
		expect(codeOf(await h.call('eve', '/invitations/revoke', { invitationId }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		expect(codeOf(await h.call('cat', '/invitations/revoke', { invitationId }))).toBe('FORBIDDEN')
		// An admin cannot revoke an invitation to the admin role (not strictly below them).
		expect(codeOf(await h.call('bob', '/invitations/revoke', { invitationId }))).toBe('FORBIDDEN')
		expect((await h.call('ann', '/invitations/revoke', { invitationId })).status).toBe(200)
	})

	test('the accept page learns names only for the verified invitee', async () => {
		const calls: unknown[] = []
		const h = await harness(kind, {
			describeInvitation: (input) => {
				calls.push(input)
				return { title: 'Secret plans', inviterName: 'Ann' }
			},
		})
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'eve@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('eve@example.com')
		const stranger = await h.call('bob', '/invitations/describe', { token })
		const unverified = await h.call('eve', '/invitations/describe', { token })
		expect(stranger.body).not.toHaveProperty('details')
		expect(unverified.body).not.toHaveProperty('details')
		expect(calls).toHaveLength(0)
		expect(JSON.stringify(stranger.body)).not.toContain('eve@example.com')
	})

	test('limits: pending invitations per space, invitations per address, requests per user', async () => {
		const h = await harness(kind, {
			limits: { pendingPerSpace: 2, perRecipientPerDay: 2, requestsPerUserPerMinute: 8 },
		})
		await h.createForm('f1', 'ann')
		await h.createForm('f2', 'ann')
		const invite = (space: readonly [string, string], email: string) =>
			h.call('ann', '/invitations/create', { space, email, role: 'viewer' })
		expect((await invite(F1, 'a@example.com')).status).toBe(200)
		expect((await invite(F1, 'b@example.com')).status).toBe(200)
		expect(codeOf(await invite(F1, 'c@example.com'))).toBe('TOO_MANY_PENDING')
		// Re-sending a pending invitation is not a new one.
		expect((await invite(F1, 'a@example.com')).status).toBe(200)
		// The address limit holds across spaces.
		expect(codeOf(await invite(['forms', 'f2'], 'a@example.com'))).toBe('RATE_LIMITED')
		expect((await invite(['forms', 'f2'], 'd@example.com')).status).toBe(200)
		expect((await invite(['forms', 'f2'], 'e@example.com')).status).toBe(200)
		expect(codeOf(await invite(['forms', 'f2'], 'f@example.com'))).toBe('TOO_MANY_PENDING')
		// The ninth request in the minute: the per-user limit.
		expect(codeOf(await h.call('ann', '/leave', { space: F1 }))).toBe('RATE_LIMITED')
	})

	test('beforeInvite can refuse, and a failed delivery keeps the invitation for a re-send', async () => {
		let fail = true
		const h = await harness(kind, {
			beforeInvite: ({ email }) =>
				email.endsWith('@blocked.test') ? { message: 'That domain is not allowed.' } : undefined,
			deliverInvitation: () => {
				if (fail) throw new Error('smtp down')
			},
		})
		await h.createForm('f1', 'ann')
		const refused = await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'x@blocked.test',
			role: 'viewer',
		})
		expect(refused.body).toMatchObject({
			error: { code: 'INVITE_REFUSED', message: 'That domain is not allowed.' },
		})
		const failed = await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'bob@example.com',
			role: 'viewer',
		})
		expect(codeOf(failed)).toBe('DELIVERY_FAILED')
		expect(await h.server.getKoraContext().query(SPACE_INVITATIONS)).toHaveLength(1)
		fail = false
		const resent = await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'bob@example.com',
			role: 'viewer',
		})
		expect(resent.body).toMatchObject({ resent: true })
	})

	test('invalid input is refused before anything is read', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		const cases: Array<[unknown, string]> = [
			[null, 'INVALID_REQUEST'],
			[{ space: ['notes', 'x'], email: 'a@example.com', role: 'viewer' }, 'INVALID_REQUEST'],
			[{ space: F1, email: 'not-an-email', role: 'viewer' }, 'INVALID_REQUEST'],
			[{ space: F1, email: 'a@example.com', role: 'superuser' }, 'ROLE_NOT_ALLOWED'],
			[{ space: F1, email: 'a@example.com', role: 'owner' }, 'ROLE_NOT_ALLOWED'],
		]
		for (const [body, code] of cases) {
			expect(codeOf(await h.call('ann', '/invitations/create', body))).toBe(code)
		}
	})
})

describe.each(STORE_KINDS)('roles above the manager role on the %s store', (kind) => {
	test('promoting an inviter revokes their pending invitations (sent under the old role)', async () => {
		const wide = spacesCollections({
			roles: ['viewer', 'admin', 'director', 'owner'],
			ownerRole: 'owner',
			manageRole: 'admin',
			groups: { forms: { owner: 'ownerId' } },
		})
		const h = await createHarness(kind, {}, { sharing: wide })
		open.push(h)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.call('bob', '/invitations/create', {
			space: F1,
			email: 'cat@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('cat@example.com')
		const promoted = await h.call('ann', '/members/role', {
			space: F1,
			userId: 'bob',
			role: 'director',
		})
		expect(promoted.body).toMatchObject({ changed: true, invitationsRevoked: 1 })
		expect(codeOf(await h.call('cat', '/invitations/accept', { token }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		// A director now invites to admin, which an admin could not.
		expect(
			(
				await h.call('bob', '/invitations/create', {
					space: F1,
					email: 'dan@example.com',
					role: 'admin',
				})
			).status,
		).toBe(200)
	})
})
