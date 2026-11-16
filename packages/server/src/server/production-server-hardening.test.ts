import { request } from 'node:http'
import { connect } from 'node:net'
import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import { MemoryServerStore } from '../store/memory-server-store'
import { createSqliteServerStore } from '../store/sqlite-server-store'
import { type ProductionServer, createProductionServer } from './production-server'

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

const insert = {
	id: 'op-1',
	nodeId: 'client-1',
	type: 'insert' as const,
	collection: 'todos',
	recordId: 'rec-1',
	data: { title: 'hello' },
	previousData: null,
	timestamp: { wallTime: 1000, logical: 0, nodeId: 'client-1' },
	sequenceNumber: 1,
	causalDeps: [],
	schemaVersion: 1,
}

async function storeWithOneOperation(): Promise<MemoryServerStore> {
	const store = new MemoryServerStore('server-a')
	await store.setSchema(schema)
	await store.applyRemoteOperation(insert)
	return store
}

let running: ProductionServer | null = null

async function start(store = createSqliteServerStore({ filename: ':memory:' })): Promise<string> {
	running = createProductionServer({
		store,
		port: 0,
		staticDir: '/nonexistent',
		operationalAuth: { adminToken: 'admin', backupToken: 'backup' },
	})
	return running.start()
}

afterEach(async () => {
	await running?.stop()
	running = null
})

describe('backup integrity', () => {
	test('a truncated backup is refused and replace mode keeps the log', async () => {
		const source = await storeWithOneOperation()
		const backup = await source.exportBackup()
		const target = await storeWithOneOperation()

		await expect(target.importBackup(backup.slice(0, backup.length - 20), false)).rejects.toThrow(
			expect.objectContaining({ code: 'BACKUP_CHECKSUM_MISMATCH' }),
		)
		await expect(
			target.importBackup(new TextEncoder().encode('not a backup at all'), false),
		).rejects.toThrow(expect.objectContaining({ code: 'BACKUP_CHECKSUM_MISMATCH' }))
		expect(await target.getOperationCount()).toBe(1)
	})

	test('a backup whose content was altered is refused', async () => {
		const backup = await (await storeWithOneOperation()).exportBackup()
		const text = new TextDecoder().decode(backup)
		const at = text.indexOf('hello')
		expect(at).toBeGreaterThan(0)
		const altered = new Uint8Array(backup)
		altered[at] = 'j'.charCodeAt(0)
		const target = new MemoryServerStore('server-b')
		await expect(target.importBackup(altered, false)).rejects.toThrow(
			expect.objectContaining({ code: 'BACKUP_CHECKSUM_MISMATCH' }),
		)
	})

	test('an intact backup still restores', async () => {
		const backup = await (await storeWithOneOperation()).exportBackup()
		const target = new MemoryServerStore('server-b')
		await target.setSchema(schema)
		const result = await target.importBackup(backup, false)
		expect(result).toMatchObject({ success: true, operationsRestored: 1 })
	})

	test('the import route answers 400 for a truncated backup', async () => {
		const base = await start()
		const backup = await (await storeWithOneOperation()).exportBackup()
		const response = await fetch(`${base}/__kora/backup/import?merge=false`, {
			method: 'POST',
			headers: { authorization: 'Bearer backup' },
			body: backup.slice(0, 40),
		})
		expect(response.status).toBe(400)
		expect(await response.json()).toMatchObject({ code: 'BACKUP_CHECKSUM_MISMATCH' })
	})
})

describe('production server robustness', () => {
	test('an interrupted backup upload restores nothing', async () => {
		const store = createSqliteServerStore({ filename: ':memory:' })
		let imports = 0
		const original = store.importBackup.bind(store)
		store.importBackup = (data, merge) => {
			imports += 1
			return original(data, merge)
		}
		const base = await start(store)
		const { port } = new URL(base)
		await new Promise<void>((resolve) => {
			const req = request({
				port,
				method: 'POST',
				path: '/__kora/backup/import?merge=false',
				headers: { authorization: 'Bearer backup', 'content-length': '1000' },
			})
			req.on('error', () => resolve())
			req.write(Buffer.alloc(40), () => {
				req.destroy()
				resolve()
			})
		})
		// The server sees the reset on its next turn; a request it can still answer
		// proves the earlier one has been handled.
		expect((await fetch(`${base}/health`)).status).toBe(200)
		expect(imports).toBe(0)
	})

	test('an upgrade with a malformed Host header is dropped, not fatal', async () => {
		const base = await start()
		const { port } = new URL(base)
		await new Promise<void>((resolve) => {
			const socket = connect(Number(port), '127.0.0.1', () => {
				socket.write(
					'GET /kora-sync HTTP/1.1\r\nHost: a b\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
						'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n',
				)
			})
			socket.on('close', () => resolve())
			socket.on('error', () => resolve())
		})
		expect((await fetch(`${base}/health`)).status).toBe(200)
	})

	test('stop() ends open dashboard feeds', async () => {
		const base = await start()
		const response = await fetch(`${base}/__kora/events`, {
			headers: { authorization: 'Bearer admin' },
		})
		expect(response.status).toBe(200)
		const reader = response.body?.getReader()
		await reader?.read()
		const server = running
		running = null
		await server?.stop()
		// Reaching this line is the assertion: stop() used to wait for the feed forever.
		expect(server).not.toBeNull()
		await reader?.cancel().catch(() => {})
	})
})
