/**
 * The sharing lifecycle through the routes, on the memory, SQLite and Postgres stores: invite,
 * describe, accept, change roles, remove, leave, transfer, and what each leaves in the
 * kit's collections.
 */
import { afterEach, describe, expect, test, vi } from 'vitest'
import { SPACE_INVITATIONS, SPACE_INVITATION_SECRETS, SPACE_MEMBERS } from '../../src/index'
import { spacesRoutes } from '../../src/server'
import {
	type Harness,
	STORE_KINDS,
	type StoreKind,
	codeOf,
	createHarness,
	sharing,
} from './fixture'

const open: Harness[] = []
async function harness(
	kind: StoreKind,
	...args: Parameters<typeof createHarness> extends [unknown, ...infer R] ? R : never
): Promise<Harness> {
	const h = await createHarness(kind, ...args)
	open.push(h)
	return h
}
afterEach(async () => {
	vi.useRealTimers()
	for (const h of open.splice(0)) await h.close()
})

/** Moves the system clock forward from now (only `Date`; timers stay real). */
function fakeClock(): { advance(ms: number): void } {
	let at = Date.now()
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(at)
	return {
		advance(ms) {
			at += ms
			vi.setSystemTime(at)
		},
	}
}

describe.each(STORE_KINDS)('spaces on the %s store', (kind) => {
	test('invite, describe and accept make the invitee a member and consume the invitation', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		const invited = await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: ' Bob@Example.com ',
			role: 'editor',
		})
		expect(invited.status).toBe(200)
		expect(invited.headers?.['Referrer-Policy']).toBe('no-referrer')
		expect(invited.body).toMatchObject({
			invitation: { email: 'bob@example.com', role: 'editor' },
			resent: false,
		})
		expect(invited.body).not.toHaveProperty('url')
		expect(h.sent).toHaveLength(1)
		const token = h.tokenFor('bob@example.com')

		// The token is never stored: only its hash, in a collection devices never receive.
		const kora = h.server.getKoraContext()
		const [secret] = await kora.query(SPACE_INVITATION_SECRETS)
		expect(JSON.stringify(secret)).not.toContain(token.slice(token.indexOf('.') + 1))

		const described = await h.call('bob', '/invitations/describe', { token })
		expect(described.body).toMatchObject({
			role: 'editor',
			expired: false,
			emailHint: 'b***@example.com',
			match: 'yes',
		})
		const strangerView = await h.call('cat', '/invitations/describe', { token })
		expect(strangerView.body).toMatchObject({ match: 'no' })

		const accepted = await h.call('bob', '/invitations/accept', { token })
		expect(accepted.status).toBe(200)
		expect(accepted.body).toMatchObject({ space: ['forms', 'f1'], role: 'editor', userId: 'bob' })
		expect(await h.roleOf('bob', 'f1')).toBe('editor')
		const [row] = await kora.query(SPACE_MEMBERS, { where: { userId: 'bob' } })
		expect(row).toMatchObject({ group: 'forms:f1', role: 'editor', invitedBy: 'ann' })
		expect(row?.joinedAt).toBe((accepted.body as { joinedAt: number }).joinedAt)
		expect(await kora.query(SPACE_INVITATIONS)).toHaveLength(0)
		expect(await kora.query(SPACE_INVITATION_SECRETS)).toHaveLength(0)

		// Used: a second accept finds nothing.
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		expect(h.events.map((e) => e.type)).toEqual(['invitation.created', 'invitation.accepted'])
	})

	test('re-sending rotates the token: the earlier link stops working', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'bob@example.com',
			role: 'viewer',
		})
		const first = h.tokenFor('bob@example.com')
		const again = await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'bob@example.com',
			role: 'editor',
		})
		expect(again.body).toMatchObject({ resent: true })
		const second = h.tokenFor('bob@example.com')
		expect(second).not.toBe(first)
		expect(codeOf(await h.call('bob', '/invitations/accept', { token: first }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		expect((await h.call('bob', '/invitations/accept', { token: second })).status).toBe(200)
		expect(await h.roleOf('bob', 'f1')).toBe('editor')
	})

	test('accepting needs the verified invited address', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'eve@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('eve@example.com')
		expect(codeOf(await h.call(null, '/invitations/accept', { token }))).toBe('UNAUTHENTICATED')
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe('EMAIL_MISMATCH')
		expect(codeOf(await h.call('eve', '/invitations/accept', { token }))).toBe('EMAIL_NOT_VERIFIED')
		expect((await h.call('eve', '/invitations/describe', { token })).body).toMatchObject({
			match: 'unverified',
		})
		expect(await h.roleOf('eve', 'f1')).toBeNull()
	})

	test('malformed, unknown and revoked tokens all answer INVITATION_NOT_FOUND', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'bob@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('bob@example.com')
		const forged = `${token.slice(0, token.indexOf('.'))}.${'A'.repeat(43)}`
		for (const bad of ['nope', forged, `inv_${'0'.repeat(32)}.${'A'.repeat(43)}`]) {
			expect(codeOf(await h.call('bob', '/invitations/accept', { token: bad }))).toBe(
				'INVITATION_NOT_FOUND',
			)
		}
		const invitationId = token.slice(0, token.indexOf('.'))
		expect((await h.call('ann', '/invitations/revoke', { invitationId })).status).toBe(200)
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		expect(codeOf(await h.call('bob', '/invitations/describe', { token }))).toBe(
			'INVITATION_NOT_FOUND',
		)
	})

	test('an expired invitation cannot be accepted, but can be declined', async () => {
		const clock = fakeClock()
		const h = await harness(kind, { invitationTtlMs: 1000 })
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'bob@example.com',
			role: 'viewer',
		})
		const token = h.tokenFor('bob@example.com')
		clock.advance(1000)
		expect((await h.call('bob', '/invitations/describe', { token })).body).toMatchObject({
			expired: true,
		})
		expect(codeOf(await h.call('bob', '/invitations/accept', { token }))).toBe('INVITATION_EXPIRED')
		expect((await h.call('bob', '/invitations/decline', { token })).status).toBe(200)
		expect(await h.server.getKoraContext().query(SPACE_INVITATIONS)).toHaveLength(0)
	})

	test('roles: managers act only below themselves, and only the owner outranks a manager', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'admin')
		await h.join('ann', 'cat', 'f1', 'admin')
		await h.join('bob', 'dan', 'f1', 'viewer')

		// A manager cannot grant their own role, nor touch a fellow manager.
		const tooHigh = await h.call('bob', '/members/role', {
			space: ['forms', 'f1'],
			userId: 'dan',
			role: 'admin',
		})
		expect(codeOf(tooHigh)).toBe('ROLE_TOO_HIGH')
		expect(
			codeOf(
				await h.call('bob', '/members/role', {
					space: ['forms', 'f1'],
					userId: 'cat',
					role: 'viewer',
				}),
			),
		).toBe('FORBIDDEN')
		expect(
			codeOf(await h.call('bob', '/members/remove', { space: ['forms', 'f1'], userId: 'cat' })),
		).toBe('FORBIDDEN')
		expect(
			codeOf(
				await h.call('bob', '/invitations/create', {
					space: ['forms', 'f1'],
					email: 'x@example.com',
					role: 'admin',
				}),
			),
		).toBe('ROLE_TOO_HIGH')
		// Nobody is given the owner role except by transfer, and the owner's role is not changeable.
		expect(
			codeOf(
				await h.call('ann', '/members/role', {
					space: ['forms', 'f1'],
					userId: 'bob',
					role: 'owner',
				}),
			),
		).toBe('ROLE_NOT_ALLOWED')
		expect(
			codeOf(await h.call('bob', '/members/remove', { space: ['forms', 'f1'], userId: 'ann' })),
		).toBe('CANNOT_CHANGE_OWNER')

		// A manager changes and removes members below them.
		const promoted = await h.call('bob', '/members/role', {
			space: ['forms', 'f1'],
			userId: 'dan',
			role: 'editor',
			from: 'viewer',
		})
		expect(promoted.body).toMatchObject({ changed: true })
		expect(await h.roleOf('dan', 'f1')).toBe('editor')
		expect(
			codeOf(
				await h.call('bob', '/members/role', {
					space: ['forms', 'f1'],
					userId: 'dan',
					role: 'viewer',
					from: 'viewer',
				}),
			),
		).toBe('ROLE_CHANGED')
		expect(
			(await h.call('bob', '/members/remove', { space: ['forms', 'f1'], userId: 'dan' })).status,
		).toBe(200)
		expect(await h.roleOf('dan', 'f1')).toBeNull()

		// The owner outranks everyone.
		expect(
			(
				await h.call('ann', '/members/role', {
					space: ['forms', 'f1'],
					userId: 'cat',
					role: 'viewer',
				})
			).status,
		).toBe(200)
		expect(await h.roleOf('cat', 'f1')).toBe('viewer')
	})

	test('leave: any member but the owner', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'editor')
		expect(codeOf(await h.call('ann', '/leave', { space: ['forms', 'f1'] }))).toBe(
			'OWNER_CANNOT_LEAVE',
		)
		expect((await h.call('bob', '/leave', { space: ['forms', 'f1'] })).status).toBe(200)
		expect(await h.roleOf('bob', 'f1')).toBeNull()
		expect(codeOf(await h.call('bob', '/leave', { space: ['forms', 'f1'] }))).toBe('NOT_A_MEMBER')
	})

	test('transfer: the new owner holds the owner field, the previous owner keeps the manager role', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'editor')
		await h.call('ann', '/invitations/create', {
			space: ['forms', 'f1'],
			email: 'cat@example.com',
			role: 'viewer',
		})
		const catToken = h.tokenFor('cat@example.com')

		expect(
			codeOf(await h.call('bob', '/transfer', { space: ['forms', 'f1'], toUserId: 'bob' })),
		).toBe('FORBIDDEN')
		expect(
			codeOf(await h.call('ann', '/transfer', { space: ['forms', 'f1'], toUserId: 'dan' })),
		).toBe('NOT_A_MEMBER')
		const moved = await h.call('ann', '/transfer', { space: ['forms', 'f1'], toUserId: 'bob' })
		expect(moved.status).toBe(200)
		expect(moved.body).toMatchObject({ invitationsRevoked: 1 })

		const kora = h.server.getKoraContext()
		expect((await kora.findById('forms', 'f1'))?.ownerId).toBe('bob')
		expect(await h.server.access.roleOf('bob', ['forms', 'f1'])).toMatchObject({
			role: 'owner',
			source: 'owner',
		})
		expect(await h.roleOf('ann', 'f1')).toBe('admin')
		// One owner only: bob's membership row went with the transfer.
		expect(await kora.query(SPACE_MEMBERS, { where: { userId: 'bob' } })).toHaveLength(0)
		// Invitations sent under the previous ownership are gone.
		expect(codeOf(await h.call('cat', '/invitations/accept', { token: catToken }))).toBe(
			'INVITATION_NOT_FOUND',
		)
		// The previous owner is now a manager below the new owner.
		expect(
			codeOf(await h.call('ann', '/members/remove', { space: ['forms', 'f1'], userId: 'bob' })),
		).toBe('CANNOT_CHANGE_OWNER')
		expect((await h.call('ann', '/leave', { space: ['forms', 'f1'] })).status).toBe(200)
	})

	test('a space the server does not have yet, and a deleted one', async () => {
		const h = await harness(kind)
		expect(
			codeOf(
				await h.call('ann', '/invitations/create', {
					space: ['forms', 'later'],
					email: 'bob@example.com',
					role: 'viewer',
				}),
			),
		).toBe('SPACE_NOT_SYNCED')
		await h.createForm('f1', 'ann')
		await h.server.getKoraContext().apply({ collection: 'forms', type: 'delete', recordId: 'f1' })
		expect(
			codeOf(
				await h.call('ann', '/invitations/create', {
					space: ['forms', 'f1'],
					email: 'bob@example.com',
					role: 'viewer',
				}),
			),
		).toBe('SPACE_NOT_FOUND')
	})

	test('an existing member is not invited again', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'viewer')
		expect(
			codeOf(
				await h.call('ann', '/invitations/create', {
					space: ['forms', 'f1'],
					email: 'bob@example.com',
					role: 'editor',
				}),
			),
		).toBe('ALREADY_MEMBER')
		expect(
			codeOf(
				await h.call('ann', '/invitations/create', {
					space: ['forms', 'f1'],
					email: 'ann@example.com',
					role: 'editor',
				}),
			),
		).toBe('ALREADY_MEMBER')
	})

	test('only POST, and unknown routes are 404', async () => {
		const h = await harness(kind)
		const route = await h.call('ann', '/nope', {})
		expect(route.status).toBe(404)
	})

	test('a basePath without a leading slash routes like the server does', async () => {
		const h = await harness(kind, { basePath: 'api/spaces/' })
		await h.createForm('f1', 'ann')
		expect(codeOf(await h.call('ann', '/leave', { space: ['forms', 'f1'] }))).toBe(
			'OWNER_CANNOT_LEAVE',
		)
	})

	test('a transfer where the previous owner leaves reports no role for them', async () => {
		const h = await harness(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'bob', 'f1', 'editor')
		await h.call('ann', '/transfer', {
			space: ['forms', 'f1'],
			toUserId: 'bob',
			previousOwner: 'leave',
		})
		const event = h.events.find((e) => e.type === 'space.transferred')
		expect(event).toBeDefined()
		expect(event).not.toHaveProperty('role')
	})
})

test('mounting the routes at the root is refused', () => {
	for (const basePath of ['/', '', '//']) {
		expect(() =>
			spacesRoutes({ sharing, basePath, identify: () => null, acceptUrl: (t) => t }),
		).toThrow('below the root')
	}
})

test('a decision that waited for the lock judges expiry when it decides', async () => {
	const clock = fakeClock()
	const h = await createHarness('memory', { invitationTtlMs: 1000 })
	open.push(h)
	await h.createForm('f1', 'ann')
	await h.call('ann', '/invitations/create', {
		space: ['forms', 'f1'],
		email: 'bob@example.com',
		role: 'viewer',
	})
	const token = h.tokenFor('bob@example.com')
	// Another transaction holds the store's write lock while the accept arrives.
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const blocker = h.server.getKoraContext().transaction(async () => {
		await held
		return []
	})
	const accepting = h.call('bob', '/invitations/accept', { token })
	await new Promise((resolve) => setTimeout(resolve, 20))
	clock.advance(1000)
	release()
	await blocker
	expect(codeOf(await accepting)).toBe('INVITATION_EXPIRED')
})

test('an invitation created after waiting for the lock is valid for its full lifetime', async () => {
	const clock = fakeClock()
	const h = await createHarness('memory', { invitationTtlMs: 1000 })
	open.push(h)
	await h.createForm('f1', 'ann')
	let release: () => void = () => {}
	const held = new Promise<void>((resolve) => {
		release = resolve
	})
	const blocker = h.server.getKoraContext().transaction(async () => {
		await held
		return []
	})
	const creating = h.call('ann', '/invitations/create', {
		space: ['forms', 'f1'],
		email: 'bob@example.com',
		role: 'viewer',
	})
	await new Promise((resolve) => setTimeout(resolve, 20))
	clock.advance(1000)
	release()
	await blocker
	expect((await creating).status).toBe(200)
	expect(
		(await h.call('bob', '/invitations/accept', { token: h.tokenFor('bob@example.com') })).status,
	).toBe(200)
})
