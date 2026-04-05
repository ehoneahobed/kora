/// <reference lib="webworker" />
/**
 * Web Worker script for running SQLite WASM.
 *
 * This file is intended to run inside a Web Worker in browsers.
 * It loads @sqlite.org/sqlite-wasm, initializes SQLite with OPFS persistence
 * (falling back to in-memory if unavailable), and processes messages from
 * the main thread via the WorkerRequest/WorkerResponse protocol.
 *
 * This script cannot be tested in Node.js — it is validated in E2E browser tests.
 */

import type { WorkerRequest, WorkerResponse } from './sqlite-wasm-channel'

interface SqliteDb {
	exec(opts: {
		sql: string
		bind?: unknown[]
		returnValue?: string
		rowMode?: string
		callback?: (row: Record<string, unknown>) => void
	}): void
	close(): void
	deserialize?: (data: Uint8Array) => void
}

declare const self: DedicatedWorkerGlobalScope

let db: SqliteDb | null = null
let sqlite3Api: unknown = null

function sendResponse(response: WorkerResponse): void {
	self.postMessage(response)
}

function handleExecute(id: number, sql: string, params?: unknown[]): void {
	if (!db) {
		sendResponse({ id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' })
		return
	}
	try {
		db.exec({ sql, bind: params })
		sendResponse({ id, type: 'success' })
	} catch (error) {
		sendResponse({ id, type: 'error', message: (error as Error).message, code: 'EXEC_ERROR' })
	}
}

function handleQuery(id: number, sql: string, params?: unknown[]): void {
	if (!db) {
		sendResponse({ id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' })
		return
	}
	try {
		const rows: Record<string, unknown>[] = []
		db.exec({
			sql,
			bind: params,
			rowMode: 'object',
			callback: (row: Record<string, unknown>) => {
				rows.push({ ...row })
			},
		})
		sendResponse({ id, type: 'success', data: rows })
	} catch (error) {
		sendResponse({ id, type: 'error', message: (error as Error).message, code: 'QUERY_ERROR' })
	}
}

async function handleOpen(id: number, ddlStatements: string[]): Promise<void> {
	try {
		const sqlite3InitModule = (await import('@sqlite.org/sqlite-wasm')).default
		const sqlite3 = await sqlite3InitModule()
		sqlite3Api = sqlite3

		// Try OPFS persistence first
		let useOpfs = false
		if (sqlite3.installOpfsSAHPoolVfs) {
			try {
				const pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'kora-opfs' })
				db = new pool.OpfsSAHPoolDb('kora.db')
				useOpfs = true
			} catch {
				// OPFS unavailable, fall back to in-memory
				console.warn('[kora] OPFS unavailable, falling back to in-memory SQLite')
			}
		}

		if (!useOpfs) {
			db = new sqlite3.oo1.DB({ filename: ':memory:' })
		}

		// Set pragmas
		db?.exec({ sql: 'PRAGMA journal_mode = WAL' })
		db?.exec({ sql: 'PRAGMA foreign_keys = ON' })

		// Execute DDL statements
		for (const sql of ddlStatements) {
			db?.exec({ sql })
		}

		sendResponse({ id, type: 'success' })
	} catch (error) {
		sendResponse({
			id,
			type: 'error',
			message: (error as Error).message,
			code: 'INIT_ERROR',
		})
	}
}

function handleClose(id: number): void {
	if (db) {
		db.close()
		db = null
	}
	sendResponse({ id, type: 'success' })
}

function handleImport(id: number, data: Uint8Array): void {
	if (!db) {
		sendResponse({ id, type: 'error', message: 'Database is not open', code: 'DB_NOT_OPEN' })
		return
	}

	const dbWithDeserialize = db as SqliteDb & { deserialize?: (bytes: Uint8Array) => void }
	if (typeof dbWithDeserialize.deserialize === 'function') {
		try {
			dbWithDeserialize.deserialize(data)
			sendResponse({ id, type: 'success' })
			return
		} catch (error) {
			sendResponse({ id, type: 'error', message: (error as Error).message, code: 'IMPORT_ERROR' })
			return
		}
	}

	const sqlite3 = sqlite3Api as
		| {
				oo1?: { DB?: new (...args: unknown[]) => SqliteDb }
				capi?: { sqlite3_deserialize?: unknown }
			}
		| null

	if (!sqlite3 || typeof sqlite3.capi?.sqlite3_deserialize === 'undefined') {
		sendResponse({
			id,
			type: 'error',
			message: 'Import not supported in this SQLite WASM runtime',
			code: 'IMPORT_NOT_SUPPORTED',
		})
		return
	}

	sendResponse({
		id,
		type: 'error',
		message: 'Import requires runtime-specific deserialize wiring and is unavailable in this worker build',
		code: 'IMPORT_NOT_SUPPORTED',
	})
}

function handleMessage(request: WorkerRequest): void {
	try {
		switch (request.type) {
			case 'open':
				// open is async due to WASM loading
				handleOpen(request.id, request.ddlStatements)
				return
			case 'close':
				handleClose(request.id)
				return
			case 'execute':
				handleExecute(request.id, request.sql, request.params)
				return
			case 'query':
				handleQuery(request.id, request.sql, request.params)
				return
			case 'begin':
				handleExecute(request.id, 'BEGIN')
				return
			case 'commit':
				handleExecute(request.id, 'COMMIT')
				return
			case 'rollback':
				handleExecute(request.id, 'ROLLBACK')
				return
			case 'migrate':
				if (!db) {
					sendResponse({
						id: request.id,
						type: 'error',
						message: 'Database is not open',
						code: 'DB_NOT_OPEN',
					})
					return
				}
				try {
					for (const sql of request.statements) {
						db.exec({ sql })
					}
					sendResponse({ id: request.id, type: 'success' })
				} catch (error) {
					sendResponse({
						id: request.id,
						type: 'error',
						message: (error as Error).message,
						code: 'MIGRATE_ERROR',
					})
				}
				return
			case 'export':
				// Export is not trivially supported via the oo1 API in the browser.
				// In a real implementation, we'd use the C API's sqlite3_serialize.
				sendResponse({
					id: request.id,
					type: 'error',
					message: 'Export not yet supported in browser worker',
					code: 'EXPORT_NOT_SUPPORTED',
				})
				return
			case 'import':
				handleImport(request.id, request.data)
				return
			default:
				sendResponse({
					id: (request as WorkerRequest).id,
					type: 'error',
					message: 'Unknown request type',
					code: 'UNKNOWN_REQUEST',
				})
		}
	} catch (error) {
		sendResponse({
			id: request.id,
			type: 'error',
			message: (error as Error).message,
			code: 'WORKER_ERROR',
		})
	}
}

// Listen for messages from the main thread
self.onmessage = (event: MessageEvent<WorkerRequest>) => {
	handleMessage(event.data)
}
