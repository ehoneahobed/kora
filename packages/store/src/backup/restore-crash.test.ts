import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { Operation } from '@korajs/core'
import fc from 'fast-check'
import { afterEach, describe, expect, test } from 'vitest'
import { BetterSqlite3Adapter } from '../adapters/better-sqlite3-adapter'
import { Store } from '../store/store'

/**
 * A replace restore keeps this device's unsynced writes (keepUnsyncedWrites, the default):
 * it deletes them from the log with everything else and applies them again on top of the
 * restored data. A crash between the replace and that re-apply must not lose them.
 */
const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function openAt(path: string, nodeId = 'device-a'): Promise<Store> {
	const store = new Store({ schema, adapter: new BetterSqlite3Adapter(path), nodeId })
	await store.open()
	return store
}

/** Restore `backup` in replace mode and "crash" when the re-apply reaches its `crashAt`-th write. */
async function restoreAndCrash(store: Store, backup: Uint8Array, crashAt: number): Promise<void> {
	let reapplied = 0
	const crash = new Error('crashed before the kept writes were applied again')
	await expect(
		store.importBackup(backup, undefined, {
			applyOperation: async (operation: Operation) => {
				if (reapplied++ >= crashAt) throw crash
				return store.applyRemoteOperation(operation)
			},
		}),
	).rejects.toBe(crash)
	await store.close().catch(() => undefined)
}

const titles = async (store: Store) =>
	(await store.collection('todos').where({}).exec()).map((row) => String(row.title)).sort()

describe('a replace restore keeps unsynced writes across a crash', () => {
	test('a crash right after the replace commits: the writes are there after reopening', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'kora-restore-crash-'))
		dirs.push(dir)
		const path = join(dir, 'app.db')
		const store = await openAt(path)
		await store.collection('todos').insert({ title: 'in the backup' })
		const backup = await store.exportBackup()
		await store.collection('todos').insert({ title: 'written after the backup' })
		await restoreAndCrash(store, backup, 0)

		const reopened = await openAt(path)
		try {
			expect(await titles(reopened)).toEqual(['in the backup', 'written after the backup'])
		} finally {
			await reopened.close()
		}
	})

	test('property: any number of unsynced writes and any crash point keep every write', async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 6 }),
				fc.integer({ min: 0, max: 8 }),
				async (after, crashAt) => {
					const dir = mkdtempSync(join(tmpdir(), 'kora-restore-crash-'))
					dirs.push(dir)
					const path = join(dir, 'app.db')
					const store = await openAt(path)
					await store.collection('todos').insert({ title: 'base' })
					const backup = await store.exportBackup()
					const written = Array.from({ length: after }, (_, i) => `w${i}`)
					for (const title of written) await store.collection('todos').insert({ title })
					// The kept writes are every unsynced write (base included): a crash point past
					// them means the re-apply finished.
					if (crashAt <= after) await restoreAndCrash(store, backup, crashAt)
					else {
						await store.importBackup(backup)
						await store.close()
					}
					const reopened = await openAt(path)
					try {
						expect(await titles(reopened)).toEqual(['base', ...written].sort())
					} finally {
						await reopened.close()
					}
				},
			),
			{ numRuns: 25 },
		)
	}, 60_000)
})
