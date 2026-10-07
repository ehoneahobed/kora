import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { createSqliteOAuthStores } from '../oauth/sqlite-oauth-store'
import { createSqliteUserStore } from './sqlite-user-store'

test('the SQLite user and OAuth stores create the directory of their database file (F8, F10)', async () => {
	const root = mkdtempSync(join(tmpdir(), 'kora-authdir-'))
	try {
		const users = join(root, '.kora', 'kora-auth.db')
		await createSqliteUserStore({ filename: users })
		expect(existsSync(users)).toBe(true)
		const oauth = join(root, 'nested', 'oauth', 'kora-auth.db')
		await createSqliteOAuthStores({ filename: oauth })
		expect(existsSync(oauth)).toBe(true)
	} finally {
		rmSync(root, { recursive: true, force: true })
	}
})
