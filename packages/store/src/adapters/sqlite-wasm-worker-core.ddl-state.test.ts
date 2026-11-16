import { describe, expect, test, vi } from 'vitest'

/**
 * A stand-in for `@sqlite.org/sqlite-wasm` that records statements and keeps one value across
 * opens, as a database file would: the DDL fingerprint (`_kora_ddl_state`).
 */
const ran: string[] = []
let storedFingerprint: string | null = null

vi.mock('@sqlite.org/sqlite-wasm', () => {
	class DB {
		exec(opts: {
			sql: string
			bind?: unknown[]
			callback?: (row: Record<string, unknown>) => void
		}): void {
			if (opts.sql.startsWith('INSERT OR REPLACE INTO _kora_ddl_state')) {
				storedFingerprint = String(opts.bind?.[0])
			} else if (opts.sql.startsWith('SELECT value FROM _kora_ddl_state')) {
				if (storedFingerprint !== null) opts.callback?.({ value: storedFingerprint })
			} else if (!opts.sql.startsWith('CREATE TABLE IF NOT EXISTS _kora_ddl_state')) {
				ran.push(opts.sql)
			}
		}
		close(): void {}
	}
	return { default: async () => ({ oo1: { DB } }) }
})

const { createSqliteWasmCore } = await import('./sqlite-wasm-worker-core')
const { ddlFingerprint } = await import('./ddl-state')

async function open(ddlStatements: string[]): Promise<string[]> {
	ran.length = 0
	const core = createSqliteWasmCore()
	const opened = await core.handle({
		id: 1,
		type: 'open',
		ddlStatements,
		dbName: 'ddl',
		storage: 'memory',
	})
	expect(opened.type).toBe('success')
	return ran.filter((sql) => sql.startsWith('CREATE TABLE IF NOT EXISTS t'))
}

describe('sqlite-wasm worker core: DDL fingerprint', () => {
	test('the same DDL runs once; a changed DDL (or a cleared fingerprint) runs again', async () => {
		storedFingerprint = null
		const v1 = [
			'CREATE TABLE IF NOT EXISTS t1 (id TEXT)',
			'CREATE TABLE IF NOT EXISTS t2 (id TEXT)',
		]
		expect(await open(v1)).toHaveLength(2)
		expect(storedFingerprint).toBe(ddlFingerprint(v1))
		expect(await open(v1)).toHaveLength(0)

		const v2 = [...v1, 'CREATE TABLE IF NOT EXISTS t3 (id TEXT)']
		expect(await open(v2)).toHaveLength(3)
		expect(await open(v2)).toHaveLength(0)

		// What the store does before a migration: the next open applies everything again.
		storedFingerprint = null
		expect(await open(v2)).toHaveLength(3)
	})

	test('the fingerprint tells statements apart, including their order', () => {
		expect(ddlFingerprint(['a', 'b'])).toBe(ddlFingerprint(['a', 'b']))
		expect(ddlFingerprint(['a', 'b'])).not.toBe(ddlFingerprint(['b', 'a']))
		expect(ddlFingerprint(['ab'])).not.toBe(ddlFingerprint(['a', 'b']))
		expect(ddlFingerprint([])).not.toBe(ddlFingerprint(['']))
	})
})
