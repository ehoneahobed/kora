/**
 * A record deleted on the server while it is outside a device's view must end deleted
 * on every device that can see any version of it, including devices that join later.
 *
 * Sequence (independent review of PR #54): `r` is moved out of view V (school-0 to
 * school-1), devices scoped to V hide or keep it; an offline device writes an update
 * moving `r` back into V; the server deletes `r`; the offline update then uploads. The
 * server judged the delete by the record's last values (school-1), so V-devices never
 * received it, while the stale update's values are in V and were delivered: the record
 * appeared live on V-devices, and on a brand-new V-device, although the server holds it
 * deleted. Delivery of an operation that leaves the record deleted is now decided by
 * the record's folded state and by what the view held of it.
 */
import { defineSchema, t } from '@korajs/core'
import { TokenAuthProvider } from '@korajs/server'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice } from '../src/index'
import { type ScopedNetwork, scopedNetwork, settle } from './repro/scoped-network'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: { fields: { title: t.string(), school: t.string() } },
	},
})

// `admin` reads and writes every school; any other token is a school.
const auth = new TokenAuthProvider({
	validate: async (token) => ({
		userId: token,
		scopes: { lessons: token === 'admin' ? {} : { school: token } },
	}),
})

let net: ScopedNetwork | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function ids(device: TestDevice): Promise<string[]> {
	return (await device.getState('lessons')).map((row) => String((row as { id: string }).id)).sort()
}

async function serverApply(
	network: ScopedNetwork,
	input: { type: 'insert' | 'update' | 'delete'; recordId: string; data?: Record<string, unknown> },
): Promise<void> {
	const result = await network.server.getKoraContext().apply({ collection: 'lessons', ...input })
	expect(result.ok).toBe(true)
}

describe('a record deleted outside a view does not come back through a stale write', () => {
	test('every device of the view, and a new one, ends without the record', async () => {
		net = await scopedNetwork(schema, { auth, unscopedSharing: 'allow' })
		const admin = await net.device({ name: 'admin', token: 'admin' })
		const retract = await net.device({ name: 'retract', token: 'school-0', scopeExit: 'retract' })
		const retain = await net.device({ name: 'retain', token: 'school-0' })
		const other = await net.device({ name: 'other', token: 'school-1', scopeExit: 'retract' })

		const r = await admin.collection('lessons').insert({ title: 'r', school: 'school-0' })
		await settle([admin, retract, retain, other])
		expect(await ids(retract)).toEqual([r.id])
		expect(await ids(retain)).toEqual([r.id])

		// The admin goes offline holding r in school-0.
		await admin.disconnect()
		// r leaves school-0: the retract device hides it, the retain device keeps a copy.
		await serverApply(net, { type: 'update', recordId: r.id, data: { school: 'school-1' } })
		await settle([retract, retain, other])
		expect(await ids(retract)).toEqual([])
		expect(await ids(other)).toEqual([r.id])

		// Offline, the admin moves r back to school-0; then the server deletes r (newer HLC).
		await admin.collection('lessons').update(r.id, { school: 'school-0' })
		await serverApply(net, { type: 'delete', recordId: r.id })
		await settle([retract, retain, other])
		// The stale update uploads.
		await admin.sync()
		await settle([admin, retract, retain, other])

		expect(await net.store.findRecord('lessons', r.id)).toBeNull()
		expect(await ids(admin)).toEqual([])
		expect(await ids(other)).toEqual([])
		expect(await ids(retract)).toEqual([])
		expect(await ids(retain)).toEqual([])

		// Devices that join afterwards, in either view and with either exit policy.
		const freshRetract = await net.device({
			name: 'fresh-retract',
			token: 'school-0',
			scopeExit: 'retract',
		})
		const freshRetain = await net.device({ name: 'fresh-retain', token: 'school-0' })
		const freshOther = await net.device({ name: 'fresh-other', token: 'school-1' })
		await settle([freshRetract, freshRetain, freshOther])
		expect(await ids(freshRetract)).toEqual([])
		expect(await ids(freshRetain)).toEqual([])
		expect(await ids(freshOther)).toEqual([])
	}, 60_000)

	test('a view that never held the record does not receive it', async () => {
		net = await scopedNetwork(schema, { auth, unscopedSharing: 'allow' })
		const admin = await net.device({ name: 'admin', token: 'admin' })
		const school0 = await net.device({ name: 'school-0', token: 'school-0' })
		const r = await admin.collection('lessons').insert({ title: 'r', school: 'school-1' })
		await settle([admin, school0])
		await admin.disconnect()
		await admin.collection('lessons').update(r.id, { school: 'school-0' })
		await serverApply(net, { type: 'delete', recordId: r.id })
		await admin.sync()
		await settle([admin, school0])
		expect(await ids(school0)).toEqual([])
		const fresh = await net.device({ name: 'fresh', token: 'school-0' })
		await settle([fresh])
		expect(await ids(fresh)).toEqual([])
	}, 60_000)

	test('a write newer than the delete revives the record in the view', async () => {
		net = await scopedNetwork(schema, { auth, unscopedSharing: 'allow' })
		const admin = await net.device({ name: 'admin', token: 'admin' })
		const retract = await net.device({ name: 'retract', token: 'school-0', scopeExit: 'retract' })
		const r = await admin.collection('lessons').insert({ title: 'r', school: 'school-0' })
		await settle([admin, retract])
		await serverApply(net, { type: 'update', recordId: r.id, data: { school: 'school-1' } })
		await serverApply(net, { type: 'delete', recordId: r.id })
		await settle([admin, retract])
		expect(await ids(retract)).toEqual([])
		// A later write wins over the delete (CLAUDE.md: the later of the newest delete and
		// the newest write decides) and moves the record into school-0.
		await serverApply(net, { type: 'update', recordId: r.id, data: { school: 'school-0' } })
		await settle([admin, retract])
		expect((await net.store.findRecord('lessons', r.id))?.school).toBe('school-0')
		expect(await retract.collection('lessons').findById(r.id)).toMatchObject({
			school: 'school-0',
		})
	}, 60_000)
})
