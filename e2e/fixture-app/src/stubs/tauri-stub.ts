/** Stub for E2E: @korajs/tauri is an optional peer, not installed in the browser fixture. */
export class TauriSqliteAdapter {
	constructor(_options: { path: string }) {
		throw new Error('TauriSqliteAdapter is not available in the E2E fixture')
	}
}
