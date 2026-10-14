/**
 * Races: two requests that each pass their checks alone must not both take effect when
 * they conflict. Requests are fired together on different server instances sharing one
 * database (two SQLite connections on one file; three Postgres instances), so each
 * route's checks and writes are decided under the store's lock, not in one process.
 */
import { afterEach, describe, expect, test } from 'vitest'
import { SPACE_INVITATIONS, SPACE_MEMBERS } from '../../src/index'
import { type Harness, STORE_KINDS, type StoreKind, codeOf, createHarness } from './fixture'

const open: Harness[] = []
async function cluster(kind: StoreKind): Promise<Harness> {
	const h = await createHarness(kind, {}, { instances: kind === 'postgres' ? 3 : 2 })
	open.push(h)
	return h
}
afterEach(async () => {
	for (const h of open.splice(0)) await h.close()
})

const F1 = ['forms', 'f1'] as const
const ROUNDS = 6

describe.each(STORE_KINDS)('races on the %s store', (kind) => {
	test('accept against revoke: exactly one wins, and the invitee is a member only if accept did', async () => {
		const h = await cluster(kind)
		await h.createForm('f1', 'ann')
		for (let round = 0; round < ROUNDS; round++) {
			await h.call('ann', '/invitations/create', {
				space: F1,
				email: 'bob@example.com',
				role: 'editor',
			})
			const token = h.tokenFor('bob@example.com')
			const invitationId = token.split('.')[0]
			const [accepted, revoked] = await Promise.all([
				h.call('bob', '/invitations/accept', { token }, round),
				h.call('ann', '/invitations/revoke', { invitationId }, round + 1),
			])
			expect([accepted.status, revoked.status].filter((s) => s === 200)).toHaveLength(1)
			expect(await h.roleOf('bob', 'f1')).toBe(accepted.status === 200 ? 'editor' : null)
			expect(await h.server.getKoraContext().query(SPACE_INVITATIONS)).toHaveLength(0)
			if (accepted.status === 200)
				await h.call('ann', '/members/remove', { space: F1, userId: 'bob' })
		}
	})

	test('a role change racing a removal never brings the member back', async () => {
		const h = await cluster(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'cat', 'f1', 'admin')
		for (let round = 0; round < ROUNDS; round++) {
			await h.join('ann', 'bob', 'f1', 'editor')
			const [changed, removed] = await Promise.all([
				h.call('ann', '/members/role', { space: F1, userId: 'bob', role: 'viewer' }, round),
				h.call('cat', '/members/remove', { space: F1, userId: 'bob' }, round + 1),
			])
			expect(removed.status).toBe(200)
			if (changed.status !== 200) expect(codeOf(changed)).toBe('NOT_A_MEMBER')
			expect(await h.roleOf('bob', 'f1')).toBeNull()
			expect(
				await h.server.getKoraContext().query(SPACE_MEMBERS, { where: { userId: 'bob' } }),
			).toHaveLength(0)
		}
	})

	test('an invitation sent while its sender is being demoted never admits anyone', async () => {
		const h = await cluster(kind)
		await h.createForm('f1', 'ann')
		for (let round = 0; round < ROUNDS; round++) {
			await h.join('ann', 'bob', 'f1', 'admin')
			const email = `guest${round}@example.com`
			const [invited] = await Promise.all([
				h.call('bob', '/invitations/create', { space: F1, email, role: 'editor' }, round),
				h.call('ann', '/members/role', { space: F1, userId: 'bob', role: 'viewer' }, round + 1),
			])
			if (invited.status === 200) {
				// The demotion either deleted it or (committed first) refused it; either way it is dead.
				const pending = await h.server
					.getKoraContext()
					.query(SPACE_INVITATIONS, { where: { email } })
				expect(pending).toHaveLength(0)
			} else {
				expect(codeOf(invited)).toBe('FORBIDDEN')
			}
			await h.call('ann', '/members/remove', { space: F1, userId: 'bob' })
		}
	})

	test('transfer against the new owner leaving: exactly one wins, and there is one owner', async () => {
		const h = await cluster(kind)
		for (let round = 0; round < ROUNDS; round++) {
			const id = `t${round}`
			await h.createForm(id, 'ann')
			await h.join('ann', 'bob', id, 'editor')
			const [moved, left] = await Promise.all([
				h.call('ann', '/transfer', { space: ['forms', id], toUserId: 'bob' }, round),
				h.call('bob', '/leave', { space: ['forms', id] }, round + 1),
			])
			expect([moved.status, left.status].filter((s) => s === 200)).toHaveLength(1)
			const form = await h.server.getKoraContext().findById('forms', id)
			if (moved.status === 200) {
				expect(codeOf(left)).toBe('OWNER_CANNOT_LEAVE')
				expect(form?.ownerId).toBe('bob')
				expect(await h.roleOf('ann', id)).toBe('admin')
				const bobRows = await h.server
					.getKoraContext()
					.query(SPACE_MEMBERS, { where: { userId: 'bob', group: `forms:${id}` } })
				expect(bobRows).toHaveLength(0)
			} else {
				expect(codeOf(moved)).toBe('NOT_A_MEMBER')
				expect(form?.ownerId).toBe('ann')
				expect(await h.roleOf('bob', id)).toBeNull()
			}
		}
	})

	test('the same invitation accepted on every instance at once makes one membership', async () => {
		const h = await cluster(kind)
		await h.createForm('f1', 'ann')
		await h.call('ann', '/invitations/create', {
			space: F1,
			email: 'bob@example.com',
			role: 'editor',
		})
		const token = h.tokenFor('bob@example.com')
		const results = await Promise.all(
			Array.from({ length: 6 }, (_, i) => h.call('bob', '/invitations/accept', { token }, i)),
		)
		expect(results.filter((r) => r.status === 200)).toHaveLength(1)
		for (const r of results) if (r.status !== 200) expect(codeOf(r)).toBe('INVITATION_NOT_FOUND')
		expect(
			await h.server.getKoraContext().query(SPACE_MEMBERS, { where: { userId: 'bob' } }),
		).toHaveLength(1)
	})

	test('two managers inviting one address at once: one invitation, and only the last link works', async () => {
		const h = await cluster(kind)
		await h.createForm('f1', 'ann')
		await h.join('ann', 'cat', 'f1', 'admin')
		const results = await Promise.all([
			h.call(
				'ann',
				'/invitations/create',
				{ space: F1, email: 'bob@example.com', role: 'viewer' },
				0,
			),
			h.call(
				'cat',
				'/invitations/create',
				{ space: F1, email: 'bob@example.com', role: 'editor' },
				1,
			),
		])
		expect(results.map((r) => r.status)).toEqual([200, 200])
		expect(await h.server.getKoraContext().query(SPACE_INVITATIONS)).toHaveLength(1)
		const tokens = h.sent
			.filter((d) => d.email === 'bob@example.com')
			.map((d) => d.url.split('#')[1] as string)
		const outcomes = []
		for (const token of tokens)
			outcomes.push((await h.call('bob', '/invitations/accept', { token })).status)
		expect(outcomes.filter((s) => s === 200)).toHaveLength(1)
	})
})
