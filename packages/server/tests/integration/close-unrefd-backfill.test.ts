import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteServerStore } from '../../src/index'

afterEach(() => {
	vi.useRealTimers()
})

// The live-view backfill starts behind an unref'd timer. In a process with nothing else alive
// (a script, a test that opens a store and closes it) that timer never fires, so a close()
// that awaited it left the process with an unsettled await. Fake timers stand in for "the
// timer never fires": close() must end the wait itself.
describe('SqliteServerStore.close with the backfill start timer pending', () => {
	it('resolves without the timer firing', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const dir = mkdtempSync(join(tmpdir(), 'kora-close-'))
		try {
			const store = createSqliteServerStore({ filename: join(dir, 's.db') })
			await store.setSchema(
				defineSchema({ version: 1, collections: { todos: { fields: { title: t.string() } } } }),
			)
			await expect(store.close()).resolves.toBeUndefined()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
