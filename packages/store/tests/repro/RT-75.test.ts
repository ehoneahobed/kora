/**
 * RT-75 repro (Phase 3 red team round 2, 2026-10-03): the client REPLACES its
 * authoritative node ids with each handshake's list (`Store.setAuthoritativeNodeIds`,
 * `RecordFolder.setAuthoritativeNodeIds`, `SyncEngine` saving `msg.authoritativeNodeIds`)
 * instead of keeping the union the RT-62 fix requires ("devices union, never drop, ids
 * they learned").
 *
 * The handshake list is per instance: the instance's own `kora:server:<d>:<i>` id
 * first, then the other `kora:server:` ids it happened to see, then the legacy ids it
 * loaded at its own start. Postgres draws a new instance id on every start, and
 * instances behind a load balancer list different sets. So:
 * 1. Every reconnect after a deploy, and every reconnect that lands on another
 *    instance, re-folds every record of every collection with a server-authoritative
 *    field, although `kora:server:` ids are authoritative by prefix and the change
 *    cannot alter any result.
 * 2. An explicit (non-prefix) authority one instance does not list (configured extras,
 *    or a legacy id another instance added after this one started) is dropped by the
 *    device: the legacy server's old decision loses to a later device write, until the
 *    device next lands on an instance that lists it.
 *
 * Asserts the CORRECT behaviour (fails at 4d6c8a7).
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HybridLogicalClock, createOperation, defineSchema, t } from '@korajs/core'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { afterAll, describe, expect, test, vi } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { RecordFolder } from '../../src/fold/record-folder'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				title: t.string(),
				status: t.string().merge('server-authoritative'),
			},
		},
	},
}) as unknown as SchemaDefinition

const dir = mkdtempSync(join(tmpdir(), 'rt-75-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const T0 = Date.now() - 60_000
function remote(
	node: string,
	wall: number,
	seq: number,
	partial: Partial<Operation>,
): Promise<Operation> {
	return createOperation(
		{
			nodeId: node,
			type: 'update',
			collection: 'items',
			recordId: 'r1',
			data: {},
			previousData: null,
			sequenceNumber: seq,
			causalDeps: [],
			schemaVersion: 1,
			...(partial as object),
		} as Parameters<typeof createOperation>[0],
		new HybridLogicalClock(node, { now: () => wall } as never),
	)
}

describe('RT-75: devices replace, not union, the authoritative node ids', () => {
	test('a handshake differing only in kora:server: ids re-folds nothing', async () => {
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(join(dir, 'a.db')),
			nodeId: 'dev',
		})
		await store.open()
		try {
			for (let i = 0; i < 50; i++)
				await store.collection('items').insert({ title: `t${i}`, status: 'draft' })
			await store.setAuthoritativeNodeIds(['kora:server:dep:1'])
			const refolds = vi.spyOn(RecordFolder.prototype, 'refoldInTx')
			// The next connection lands on instance 2 (or on instance 1 after a restart).
			await store.setAuthoritativeNodeIds(['kora:server:dep:2'])
			await store.setAuthoritativeNodeIds(['kora:server:dep:1', 'kora:server:dep:3'])
			expect(refolds).toHaveBeenCalledTimes(0)
			refolds.mockRestore()
		} finally {
			await store.close()
		}
	})

	test('an explicit authority is not dropped by a handshake that omits it', async () => {
		const store = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(join(dir, 'b.db')),
			nodeId: 'dev',
		})
		await store.open()
		try {
			await store.setAuthoritativeNodeIds(['kora:server:dep:1', 'legacy-server'])
			const insert = await remote('legacy-server', T0, 1, {
				type: 'insert',
				data: { title: 'x', status: 'draft' },
			})
			const approve = await remote('legacy-server', T0 + 100, 2, {
				data: { status: 'approved' },
				previousData: { status: 'draft' },
			})
			const later = await remote('other-device', T0 + 200, 1, {
				data: { status: 'client' },
				previousData: { status: 'approved' },
			})
			for (const op of [insert, approve, later]) await store.applyRemoteOperation(op)
			expect(await store.collection('items').findById('r1')).toMatchObject({ status: 'approved' })

			// Another instance (started before the legacy id was recorded, or without the
			// configured extra) lists only its own id.
			await store.setAuthoritativeNodeIds(['kora:server:dep:2'])
			expect(await store.collection('items').findById('r1')).toMatchObject({ status: 'approved' })
		} finally {
			await store.close()
		}
	})
})
