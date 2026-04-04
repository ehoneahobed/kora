/** Minimal type declarations for @sqlite.org/sqlite-wasm */
declare module '@sqlite.org/sqlite-wasm' {
	interface SqliteDb {
		exec(opts: {
			sql: string
			bind?: unknown[]
			returnValue?: string
			rowMode?: string
			callback?: (row: Record<string, unknown>) => void
		}): void
		close(): void
	}

	interface SqliteOo1 {
		DB: new (opts?: { filename?: string; vfs?: string }) => SqliteDb
	}

	interface SqliteApi {
		oo1: SqliteOo1
		installOpfsSAHPoolVfs?: (opts: {
			name: string
		}) => Promise<{ OpfsSAHPoolDb: new (filename: string) => SqliteDb }>
	}

	function sqlite3InitModule(): Promise<SqliteApi>
	export default sqlite3InitModule
}
