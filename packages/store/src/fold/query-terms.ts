import type { Transaction } from '../types'

/** Variables per statement. Conservative: older SQLite builds allow 999. */
export const MAX_PARAMS = 900
/** Compound select terms per statement (SQLite allows 500). */
export const MAX_TERMS = 100

/** Pack terms into compound selects under the variable and term limits and run them. */
export async function runTerms(
	tx: Transaction,
	terms: ReadonlyArray<{ sql: string; params: unknown[] }>,
): Promise<Array<Array<Record<string, unknown>>>> {
	const results: Array<Array<Record<string, unknown>>> = []
	let sql: string[] = []
	let params: unknown[] = []
	const flush = async (): Promise<void> => {
		if (sql.length === 0) return
		results.push(await tx.query<Record<string, unknown>>(sql.join('\nUNION ALL '), params))
		sql = []
		params = []
	}
	for (const term of terms) {
		if (
			sql.length > 0 &&
			(sql.length >= MAX_TERMS || params.length + term.params.length > MAX_PARAMS)
		) {
			await flush()
		}
		sql.push(term.sql)
		params.push(...term.params)
	}
	await flush()
	return results
}
