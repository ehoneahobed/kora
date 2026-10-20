import { describe, expect, test, vi } from 'vitest'

/**
 * A stand-in for `@sqlite.org/sqlite-wasm` with sqlite-wasm's own statement rules:
 * `exec` runs every statement of a string, `prepare` compiles only the first one
 * (oo1 passes no tail pointer) and the rest is dropped. Statements are recorded,
 * not interpreted.
 */
const ran: string[] = []

function splitStatements(sql: string): string[] {
	return sql
		.split(';')
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
}

vi.mock('@sqlite.org/sqlite-wasm', () => {
	class DB {
		exec(opts: { sql: string }): void {
			ran.push(...splitStatements(opts.sql))
		}
		prepare(sql: string) {
			const first = splitStatements(sql)[0] ?? ''
			return {
				bind() {
					return this
				},
				step() {
					ran.push(first)
					return false
				},
				reset() {
					return this
				},
				finalize() {},
			}
		}
		close(): void {}
	}
	return { default: async () => ({ oo1: { DB } }) }
})

const { createSqliteWasmCore } = await import('./sqlite-wasm-worker-core')

describe('sqlite-wasm worker core: batch', () => {
	test('runs every statement of a multi-statement SQL string, not just the first', async () => {
		const core = createSqliteWasmCore()
		const opened = await core.handle({
			id: 1,
			type: 'open',
			ddlStatements: [],
			dbName: 'batch-multi',
			storage: 'memory',
		})
		expect(opened.type).toBe('success')
		ran.length = 0

		const result = await core.handle({
			id: 2,
			type: 'batch',
			statements: [
				{ sql: 'INSERT INTO t VALUES (1)', params: [] },
				{ sql: 'INSERT INTO t VALUES (2); INSERT INTO t VALUES (3)' },
				{ sql: 'INSERT INTO t VALUES (4);' },
			],
		})

		expect(result.type).toBe('success')
		expect(ran).toEqual([
			'INSERT INTO t VALUES (1)',
			'INSERT INTO t VALUES (2)',
			'INSERT INTO t VALUES (3)',
			'INSERT INTO t VALUES (4)',
		])
	})
})
