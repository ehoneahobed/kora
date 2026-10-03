/**
 * RT-66 repro (Phase 3 red team, 2026-10-02): a replace-mode restore of a compacted
 * device's backup on another device rebuilds the records from an incomplete log.
 *
 * Compaction (STORE-14) folds acknowledged operations into `_kora_fold_base` and
 * deletes them from the log. A backup carries the rows and the remaining log, but not
 * the base states (nor the compaction marker). The restoring device clears its fold
 * tables, then `ensureMaterialization` picks the mode from ITS OWN meta: it never
 * compacted and the restored ops are not its own nodes' (gaps are only checked for
 * local nodes), so the log looks clean and every record is rebuilt with mode 'log'.
 * A record whose insert was compacted has no insert left: it disappears; a field
 * whose last write was compacted loses it. The backup's own rows, which held the
 * values, are overwritten.
 *
 * Asserts the CORRECT behaviour (fails at 959b791): the restored device shows what the
 * backup shows.
 */
import { createVersionVector, defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../../src/adapters/better-sqlite3-adapter'
import { Store } from '../../src/store/store'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { title: t.string(), body: t.string().optional() } } },
})

describe('RT-66: restoring a compacted backup on another device', () => {
	const stores: Store[] = []
	afterEach(async () => {
		for (const s of stores.splice(0)) await s.close()
	})

	test('records whose history was compacted survive the restore', async () => {
		const phone = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'old-phone',
		})
		stores.push(phone)
		await phone.open()
		const notes = phone.collection('notes')
		const kept = await notes.insert({ title: 'compacted note', body: 'v1' })
		await notes.update(String(kept.id), { body: 'v2' })
		// The server acknowledged both writes; the device compacts them away.
		const acked = createVersionVector()
		acked.set('old-phone', 2)
		const compacted = await phone.compact({ mode: 'after-ack', serverVector: acked })
		expect(compacted.deletedCount).toBe(2)
		// One later write stays in the log.
		await notes.update(String(kept.id), { title: 'renamed' })
		expect(await notes.findById(String(kept.id))).toMatchObject({ title: 'renamed', body: 'v2' })
		const backup = await phone.exportBackup()

		const newPhone = new Store({
			schema,
			adapter: new BetterSqlite3Adapter(':memory:'),
			nodeId: 'new-phone',
		})
		stores.push(newPhone)
		await newPhone.open()
		const result = await newPhone.importBackup(backup)
		expect(result.success).toBe(true)
		expect(await newPhone.collection('notes').findById(String(kept.id))).toMatchObject({
			title: 'renamed',
			body: 'v2',
		})
	})
})
