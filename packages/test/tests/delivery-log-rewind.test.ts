import { copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import { createSqliteServerStore } from '@korajs/server'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice, TestServer } from '../src/index'

/**
 * A server restored underneath its devices, the way a database-level restore does it
 * (pg_restore, point-in-time recovery, a disk snapshot): the database file goes back to an
 * earlier copy, with its delivery sequences as they were, and Kora is never told. New
 * writes then take sequences a device already passed. Without delivery anchors that
 * device resumes above them and never receives them; with anchors the server sees the
 * device is in step with another log and resyncs it from 0.
 */

const schema = defineSchema({
	version: 1,
	collections: { todos: { fields: { title: t.string() } } },
})

let dir: string
const devices: TestDevice[] = []
let server: TestServer<import('@korajs/server').ServerStore> | null = null

afterEach(async () => {
	for (const device of devices.splice(0)) await device.close().catch(() => undefined)
	await server?.close().catch(() => undefined)
	server = null
	rmSync(dir, { recursive: true, force: true })
})

/** Devices reach whichever server is current, so the server can be replaced underneath them. */
const switchboard = {
	handleConnection: (transport: ServerTransport): string => {
		if (!server) throw new Error('No server is running')
		return server.handleConnection(transport)
	},
}

async function startServer(file: string): Promise<void> {
	server = new TestServer(schema, {
		store: createSqliteServerStore({ filename: file, nodeId: 'server-node' }),
	})
	await server.ready
}

async function stopServer(): Promise<void> {
	for (const device of devices) await device.disconnect().catch(() => undefined)
	await server?.close()
	server = null
}

/** A device whose handshakes can be stripped of anchors, as a client from before them sends. */
async function device(name: string, withoutAnchors = false): Promise<TestDevice> {
	const created = new TestDevice({
		name,
		schema,
		server: switchboard,
		tmpDir: dir,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			const client = pair.client as unknown as SyncTransport
			if (!withoutAnchors) return { client, serverTransport: pair.server }
			const send = client.send.bind(client)
			client.send = (message: SyncMessage) => {
				if (message.type === 'handshake') {
					const { lastDeliveryAnchor: _a, acceptedScopeAnchor: _b, ...rest } = message
					return send(rest as SyncMessage)
				}
				return send(message)
			}
			return { client, serverTransport: pair.server }
		},
	})
	devices.push(created)
	await created.open()
	return created
}

async function titles(target: TestDevice): Promise<string[]> {
	return (await target.getState('todos')).map((row) => String(row.title)).sort()
}

/** Writes before the snapshot, more after it that the restore loses, then the restore. */
async function restoreScenario(readerWithoutAnchors: boolean) {
	dir = mkdtempSync(join(tmpdir(), 'kora-rewind-'))
	const file = join(dir, 'server.db')
	const snapshot = join(dir, 'snapshot.db')
	await startServer(file)
	const writer = await device('writer')
	const reader = await device('reader', readerWithoutAnchors)

	await writer.collection('todos').insert({ title: 'kept 1' })
	await writer.collection('todos').insert({ title: 'kept 2' })
	await writer.sync()
	await reader.sync()

	// The backup: a copy of the database file, taken while the server is stopped.
	await stopServer()
	copyFileSync(file, snapshot)
	await startServer(file)
	await writer.collection('todos').insert({ title: 'lost 3' })
	await writer.collection('todos').insert({ title: 'lost 4' })
	await writer.sync()
	await reader.sync()
	expect(await titles(reader)).toEqual(['kept 1', 'kept 2', 'lost 3', 'lost 4'])

	// The restore: the file goes back to the copy, and Kora is never told.
	await stopServer()
	for (const suffix of ['', '-wal', '-shm'])
		if (existsSync(`${file}${suffix}`)) rmSync(`${file}${suffix}`)
	copyFileSync(snapshot, file)
	await startServer(file)

	// A device that never saw the old log writes past the reader's position.
	const newcomer = await device('newcomer')
	await newcomer.sync()
	for (const title of ['after 5', 'after 6', 'after 7'])
		await newcomer.collection('todos').insert({ title })
	await newcomer.sync()

	await reader.sync()
	return { writer, reader, newcomer }
}

describe('a server restored underneath its devices', () => {
	test('a device that was ahead receives everything written after the restore', async () => {
		const { writer, reader, newcomer } = await restoreScenario(false)
		expect(await titles(reader)).toEqual([
			'after 5',
			'after 6',
			'after 7',
			'kept 1',
			'kept 2',
			'lost 3',
			'lost 4',
		])

		// The writer re-uploads what the restore lost, and every device converges.
		await writer.sync()
		await newcomer.sync()
		await reader.sync()
		const all = ['after 5', 'after 6', 'after 7', 'kept 1', 'kept 2', 'lost 3', 'lost 4']
		expect(await titles(writer)).toEqual(all)
		expect(await titles(newcomer)).toEqual(all)
		expect(await titles(reader)).toEqual(all)
	})

	test('without anchors the same device skips what was written after the restore', async () => {
		// Pins the failure anchors exist for: the old client resumes above writes it never got.
		const { reader } = await restoreScenario(true)
		const seen = await titles(reader)
		expect(seen).not.toContain('after 5')
		expect(seen).not.toContain('after 6')
	})
})
