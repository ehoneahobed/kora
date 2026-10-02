/**
 * SYNC-3 repro: a delivered operation whose apply returns a non-success result
 * ('skipped' / 'rejected') or whose schema transform yields null still advances the
 * delivery watermark, so it is never re-fetched — even after the cause is fixed
 * (here: the device upgrades its schema). Asserts CORRECT behavior.
 */
import { defineSchema, t } from '@korajs/core'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { describe, expect, test } from 'vitest'
import { TestDevice, createMixedTestNetwork } from '../../src/index'

const v1 = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})
const v2 = defineSchema({
	version: 2,
	collections: {
		todos: { fields: { title: t.string() } },
		notes: { fields: { body: t.string() } },
	},
})

describe('SYNC-3: non-success apply advances the delivery watermark', () => {
	test('an op skipped by an old-schema client is delivered after that client upgrades', async () => {
		const network = await createMixedTestNetwork(
			v2,
			{ schemaVersion: 2, supportedSchemaVersions: { min: 1, max: 2 } },
			[
				{ name: 'old', schema: v1, syncSchemaVersion: 1 },
				{ name: 'new', schema: v2 },
			],
		)
		const [oldDevice, newDevice] = network.devices
		if (!oldDevice || !newDevice) throw new Error('devices')
		let upgraded: TestDevice | null = null
		try {
			const note = await newDevice.collection('notes').insert({ body: 'from v2' })
			const todo = await newDevice.collection('todos').insert({ title: 'shared' })
			await newDevice.sync()

			const failures: string[] = []
			oldDevice.emitter.on('sync:apply-failed', (e) => failures.push(`${e.collection}:${e.code}`))
			await oldDevice.sync()
			expect(failures).toContain('notes:APPLY_SKIPPED')
			expect((await oldDevice.getState('todos')).map((r) => r.id)).toContain(todo.id)
			const watermarkBefore = oldDevice.getSyncEngine()?.getStatus().deliveryWatermark ?? 0
			await oldDevice.close()

			// Same database file, upgraded app schema (local migration v1 -> v2).
			upgraded = new TestDevice({
				name: 'old',
				schema: v2,
				server: network.server,
				tmpDir: network.tmpDir,
				createTransportPair: () => {
					const pair = createServerTransportPair()
					return { client: pair.client as unknown as SyncTransport, serverTransport: pair.server }
				},
			})
			await upgraded.open()
			await upgraded.sync()
			// Control: the upgraded device does receive NEW notes, so migration + sync work.
			const later = await newDevice.collection('notes').insert({ body: 'after upgrade' })
			await newDevice.sync()
			await upgraded.sync()
			const afterUpgrade = (await upgraded.getState('notes')).map((r) => r.id)
			expect(afterUpgrade).toContain(later.id)
			expect(watermarkBefore).toBeGreaterThan(0)
			const notes = await upgraded.getState('notes')
			expect(
				notes.map((r) => r.id),
				'note skipped while on v1 is never re-delivered after upgrade',
			).toContain(note.id)
		} finally {
			await upgraded?.close()
			await network.close()
		}
	}, 30000)
})
