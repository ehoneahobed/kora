import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { WorkerBridge, WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'

type BetterSqlite3Constructor = (filename: string) => BetterSqlite3Database

/**
 * Mock WorkerBridge that wraps better-sqlite3 for Node.js testing.
 * This allows SqliteWasmAdapter to be fully tested without WASM or a real Web Worker.
 */
export class MockWorkerBridge implements WorkerBridge {
	private db: BetterSqlite3Database | null = null
	private createDb: BetterSqlite3Constructor | null = null
	private terminated = false

	async send(request: WorkerRequest): Promise<WorkerResponse> {
		if (this.terminated) {
			return {
				id: request.id,
				type: 'error',
				message: 'Worker has been terminated',
				code: 'WORKER_TERMINATED',
			}
		}

		try {
			switch (request.type) {
				case 'open':
					return await this.handleOpen(request.id, request.ddlStatements)
				case 'close':
					return this.handleClose(request.id)
				case 'execute':
					return this.handleExecute(request.id, request.sql, request.params)
				case 'query':
					return this.handleQuery(request.id, request.sql, request.params)
				case 'begin':
					return this.handleExec(request.id, 'BEGIN')
				case 'commit':
					return this.handleExec(request.id, 'COMMIT')
				case 'rollback':
					return this.handleExec(request.id, 'ROLLBACK')
				case 'migrate':
					return this.handleMigrate(request.id, request.statements)
				case 'export':
					return this.handleExport(request.id)
				default:
					return {
						id: (request as WorkerRequest).id,
						type: 'error',
						message: 'Unknown request type',
						code: 'UNKNOWN_REQUEST',
					}
			}
		} catch (error) {
			return {
				id: request.id,
				type: 'error',
				message: (error as Error).message,
				code: 'WORKER_ERROR',
			}
		}
	}

	terminate(): void {
		if (this.terminated) return
		this.terminated = true
		if (this.db) {
			this.db.close()
			this.db = null
		}
	}

	private async handleOpen(id: number, ddlStatements: string[]): Promise<WorkerResponse> {
		if (!this.createDb) {
			const mod = await import('better-sqlite3')
			const Constructor = mod.default
			this.createDb = (filename: string) => new Constructor(filename)
		}
		const database = this.createDb(':memory:')
		this.db = database
		database.pragma('journal_mode = WAL')
		database.pragma('foreign_keys = ON')
		for (const sql of ddlStatements) {
			database.exec(sql)
		}
		return { id, type: 'success' }
	}

	private handleClose(id: number): WorkerResponse {
		if (this.db) {
			this.db.close()
			this.db = null
		}
		return { id, type: 'success' }
	}

	private handleExecute(id: number, sql: string, params?: unknown[]): WorkerResponse {
		if (!this.db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		this.db.prepare(sql).run(...(params ?? []))
		return { id, type: 'success' }
	}

	private handleQuery(id: number, sql: string, params?: unknown[]): WorkerResponse {
		if (!this.db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		const rows = this.db.prepare(sql).all(...(params ?? []))
		return { id, type: 'success', data: rows }
	}

	private handleExec(id: number, sql: string): WorkerResponse {
		if (!this.db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		this.db.exec(sql)
		return { id, type: 'success' }
	}

	private handleMigrate(id: number, statements: string[]): WorkerResponse {
		if (!this.db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		for (const sql of statements) {
			this.db.exec(sql)
		}
		return { id, type: 'success' }
	}

	private handleExport(id: number): WorkerResponse {
		if (!this.db) {
			return { id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' }
		}
		const data = this.db.serialize()
		return { id, type: 'success', data: new Uint8Array(data) }
	}
}
