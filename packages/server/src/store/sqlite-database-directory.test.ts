import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSqliteServerStore } from './sqlite-server-store'

test('createSqliteServerStore creates the directory of its database file (F10)', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kora-dbdir-'))
	try {
		// The template default, ./.kora/kora-server.db, on a fresh checkout.
		const filename = join(root, '.kora', 'kora-server.db')
		const store = createSqliteServerStore({ filename })
		expect(existsSync(filename)).toBe(true)
		await store.close()
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
