// LMS-9: client-side inbound re-filtering with directional scopes.
// Tests assert CORRECT behaviour. "[fails today]" = reproduces a live bug.
import type { Operation } from '@korajs/core'
import { defineSchema, t } from '@korajs/core'
import type { SyncEngine } from '@korajs/sync'
import { operationMatchesQuerySubsets, operationMatchesScope } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { ScopedNet, settle } from './lms-scope-harness'

const schema = defineSchema({
	version: 1,
	collections: {
		lessons: {
			fields: { courseId: t.string(), title: t.string(), status: t.string().optional() },
		},
		notes: { fields: { body: t.string() } },
	},
})

/** The LMS #9 patch, verbatim, applied to one engine instance. */
function lmsPatch(engine: SyncEngine) {
	const e = engine as unknown as {
		matchesScopeAndSubsets: (o: Operation, f?: Record<string, unknown> | null) => boolean
		hasDirectionalScopes: boolean
		activeUplinkScope: Record<string, Record<string, unknown>> | undefined
		getActiveQuerySubsets: () => never
	}
	e.matchesScopeAndSubsets = (op, fullRecord) => {
		if (e.hasDirectionalScopes) return true
		if (!operationMatchesScope(op, e.activeUplinkScope, fullRecord)) return false
		return operationMatchesQuerySubsets(op, e.getActiveQuerySubsets(), fullRecord)
	}
}

/**
 * Simulation of the PLANNED SYNC-2 split: inbound applies what the server delivered
 * (server already enforced the downlink scope); outbound keeps the uplink check.
 * Implemented by bypassing filterAllowedForSync only when called from the inbound
 * batch handler.
 */
function splitPatch(engine: SyncEngine) {
	const e = engine as unknown as {
		filterAllowedForSync: (ops: Operation[]) => Promise<Operation[]>
	}
	const orig = e.filterAllowedForSync.bind(engine)
	e.filterAllowedForSync = async (ops) =>
		new Error().stack?.includes('handleOperationBatch') ? ops : orig(ops)
}

let net: ScopedNet | null = null
afterEach(async () => {
	await net?.close()
	net = null
})

async function seed() {
	net = new ScopedNet(schema)
	net.auth.set('admin', { userId: 'admin' })
	const admin = await net.device('admin', 'admin')
	await admin.sync()
	const l1 = await admin.collection('lessons').insert({ courseId: 'c1', title: 'L1' })
	const l2 = await admin.collection('lessons').insert({ courseId: 'c2', title: 'L2' })
	await admin.sync()
	return { net, admin, l1, l2 }
}

const byTitle = (rows: Array<Record<string, unknown>>) =>
	Object.fromEntries(rows.map((r) => [r.title, r.status ?? null]))

describe('LMS-9 directional scopes (their scenario)', () => {
	test('[fails today] downlink {c1,c2}, uplink {c1}: insert + later status update for a c2 lesson reach the client', async () => {
		const { net, admin, l2 } = await seed()
		net.auth.set('ta', {
			userId: 'ta',
			downlinkScopes: { lessons: { courseId: { $in: ['c1', 'c2'] } } },
			uplinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
		})
		const ta = await net.device('ta', 'ta')
		await ta.sync()
		await admin.collection('lessons').update(l2.id, { status: 'published' })
		await admin.sync()
		await ta.sync()
		// Today: L2's INSERT is already dropped (courseId c2 ∉ uplink scope). The cause
		// is SYNC-2 (inbound judged by the uplink scope), not a missing field.
		expect(byTitle(await ta.rows('lessons'))).toEqual({ L1: null, L2: 'published' })
	})

	test('[passes today] downlink == uplink {c1}: partial update {status} of a synced record is NOT dropped (backfill works)', async () => {
		const { net, admin, l1 } = await seed()
		const scope = { lessons: { courseId: { $in: ['c1'] } } }
		net.auth.set('t', { userId: 't', downlinkScopes: scope, uplinkScopes: scope })
		const t1 = await net.device('t', 't')
		await t1.sync()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		await t1.sync()
		expect(byTitle(await t1.rows('lessons'))).toEqual({ L1: 'published' })
	})

	test('[fails today] read-only learner: downlink {c1}, no uplink for lessons → receives nothing', async () => {
		const { net } = await seed()
		net.auth.set('st', {
			userId: 'st',
			downlinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
			uplinkScopes: {},
		})
		const st = await net.device('st', 'st')
		await st.sync()
		expect(byTitle(await st.rows('lessons'))).toEqual({ L1: null })
	})

	test('[passes with LMS #9 patch] same two scenarios with the patch', async () => {
		const { net, admin, l2 } = await seed()
		net.auth.set('ta', {
			userId: 'ta',
			downlinkScopes: { lessons: { courseId: { $in: ['c1', 'c2'] } } },
			uplinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
		})
		const ta = await net.device('ta', 'ta', lmsPatch)
		await ta.sync()
		await admin.collection('lessons').update(l2.id, { status: 'published' })
		await admin.sync()
		await ta.sync()
		expect(byTitle(await ta.rows('lessons'))).toEqual({ L1: null, L2: 'published' })
	})
})

describe('LMS-9 without directional scopes: the "incomplete snapshot" drop is real but elsewhere', () => {
	test('[fails today] insert + partial update of the same record in ONE delivery batch: update is dropped', async () => {
		const { net, admin, l1 } = await seed()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		net.auth.set('s', { userId: 's', scopes: { lessons: { courseId: 'c1' } } })
		const s = await net.device('s', 's')
		await s.sync() // fresh client: insert(L1) and update(L1,{status}) arrive in one batch
		// filterAllowedForSync runs over the whole batch BEFORE any op is applied, so the
		// update's readRecordForBackfill finds no local row; the bare update has no
		// courseId → dropped, and the delivery watermark still advances past it.
		expect(byTitle(await s.rows('lessons'))).toEqual({ L1: 'published' })
	})

	test('[fails today] while the session stays up the dropped update is not redelivered (watermark advanced past it)', async () => {
		const { net, admin, l1 } = await seed()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		net.auth.set('s', { userId: 's', scopes: { lessons: { courseId: 'c1' } } })
		const s = await net.device('s', 's')
		await s.sync()
		await settle(50) // 1s more, same session
		await s.sync()
		expect(byTitle(await s.rows('lessons'))).toEqual({ L1: 'published' })
	})

	test('[passes today] a reconnect heals it (observed: op re-sent on next handshake, local row now exists for backfill)', async () => {
		const { net, admin, l1 } = await seed()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		net.auth.set('s', { userId: 's', scopes: { lessons: { courseId: 'c1' } } })
		const s = await net.device('s', 's')
		await s.sync()
		await s.disconnect()
		await s.sync()
		expect(byTitle(await s.rows('lessons'))).toEqual({ L1: 'published' })
	})

	test('[passes with LMS #9 patch] ALSO "fixed" because the server sets acceptedUplinkScopes for ANY scoped session, so hasDirectionalScopes is true even for legacy `scopes`', async () => {
		const { net, admin, l1 } = await seed()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		net.auth.set('s', { userId: 's', scopes: { lessons: { courseId: 'c1' } } })
		const s = await net.device('s', 's', lmsPatch)
		await s.sync()
		expect(byTitle(await s.rows('lessons'))).toEqual({ L1: 'published' })
	})
})

describe('Planned split (SYNC-2) vs the same scenarios', () => {
	test('[passes with split] directional TA scenario', async () => {
		const { net, admin, l2 } = await seed()
		net.auth.set('ta', {
			userId: 'ta',
			downlinkScopes: { lessons: { courseId: { $in: ['c1', 'c2'] } } },
			uplinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
		})
		const ta = await net.device('ta', 'ta', splitPatch)
		await ta.sync()
		await admin.collection('lessons').update(l2.id, { status: 'published' })
		await admin.sync()
		await ta.sync()
		expect(byTitle(await ta.rows('lessons'))).toEqual({ L1: null, L2: 'published' })
	})

	test('[passes with split] same-batch insert+update, legacy scopes', async () => {
		const { net, admin, l1 } = await seed()
		await admin.collection('lessons').update(l1.id, { status: 'published' })
		await admin.sync()
		net.auth.set('s', { userId: 's', scopes: { lessons: { courseId: 'c1' } } })
		const s = await net.device('s', 's', splitPatch)
		await s.sync()
		expect(byTitle(await s.rows('lessons'))).toEqual({ L1: 'published' })
	})

	test('[passes with split] read-only learner', async () => {
		const { net } = await seed()
		net.auth.set('st', {
			userId: 'st',
			downlinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
			uplinkScopes: {},
		})
		const st = await net.device('st', 'st', splitPatch)
		await st.sync()
		expect(byTitle(await st.rows('lessons'))).toEqual({ L1: null })
	})
})

describe('LMS-9 patch side effects on OUTBOUND', () => {
	async function taDevice(patch: boolean) {
		const { net, l1, l2 } = await seed()
		// Legacy single `scopes` (NOT directional). `notes` is absent from the scope map,
		// i.e. local-only / not uploadable for this session.
		net.auth.set('ta', { userId: 'ta', scopes: { lessons: { courseId: 'c1' } } })
		const ta = await net.device('ta', 'ta', patch ? lmsPatch : undefined)
		await ta.sync()
		return { net, ta, l1, l2 }
	}

	test('today: out-of-uplink local writes are silently kept local (never sent, never rejected)', async () => {
		const { net, ta } = await taDevice(false)
		await ta.collection('notes').insert({ body: 'private draft' })
		await ta.sync()
		expect(net.rejections).toEqual([])
		expect(net.serverStore.getAllOperations().filter((o) => o.collection === 'notes')).toHaveLength(
			0,
		)
	})

	test('with LMS #9 patch: out-of-uplink local writes are TRANSMITTED to the server and rejected; re-sent on every reconnect', async () => {
		const { net, ta } = await taDevice(true)
		await ta.collection('notes').insert({ body: 'private draft' })
		await ta.sync()
		const first = net.rejections.length
		await ta.disconnect()
		await ta.sync()
		await ta.disconnect()
		await ta.sync()
		await settle()
		// Record what happens for the report (not a correctness assertion of the patch).
		console.log(
			'LMS9-OUTBOUND rejections after 1st sync:',
			first,
			'after 2 reconnects:',
			net.rejections.length,
			net.rejections,
		)
		expect(first).toBeGreaterThan(0)
		expect(net.serverStore.getAllOperations().filter((o) => o.collection === 'notes')).toHaveLength(
			0,
		)
	})

	test('hasDirectionalScopes is true for a legacy `scopes` session', async () => {
		const { ta } = await taDevice(false)
		expect((ta.engine as unknown as { hasDirectionalScopes: boolean }).hasDirectionalScopes).toBe(
			true,
		)
	})

	test('[fails today] an edit to a downlink-visible but non-uploadable record must not be silently kept local-only', async () => {
		const { net, l1 } = await seed()
		net.auth.set('r', {
			userId: 'r',
			downlinkScopes: { lessons: { courseId: { $in: ['c1'] } } },
			uplinkScopes: { lessons: { courseId: { $in: ['zzz'] } } },
		})
		// Planned split applied, so the record arrives; outbound keeps today's uplink filter.
		const r = await net.device('r', 'r', splitPatch)
		await r.sync()
		void l1
		const rows = await r.rows('lessons')
		expect(rows).toHaveLength(1)
		await r.collection('lessons').update(rows[0]?.id as string, { title: 'edited offline' })
		await r.sync()
		// Correct: the client surfaces it (rejected store / event) — never a silent fork.
		const rejected =
			(await (
				r.engine as unknown as { getRejectedOperations?: () => Promise<unknown[]> }
			).getRejectedOperations?.()) ?? []
		console.log(
			'LMS9-FORK server-title:',
			(await net.serverStore.queryCollection('lessons', { where: {} }))[0]?.title,
			'local:',
			(await r.rows('lessons'))[0]?.title,
			'serverRejections:',
			net.rejections.length,
			'clientRejected:',
			rejected.length,
		)
		expect(rejected.length + net.rejections.length).toBeGreaterThan(0)
	})

	test('[passes] with LMS #9 patch, an in-scope op after a rejected one still uploads (no ack poisoning observed)', async () => {
		const { net, ta, l1 } = await taDevice(true)
		await ta.collection('notes').insert({ body: 'private draft' })
		await ta.collection('lessons').update(l1.id, { status: 'published' })
		await ta.sync()
		await ta.disconnect()
		await ta.sync()
		const row = (await net.serverStore.queryCollection('lessons', { where: { id: l1.id } }))[0]
		expect(row?.status).toBe('published')
	})
})
