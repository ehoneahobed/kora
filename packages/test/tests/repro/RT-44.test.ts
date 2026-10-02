/**
 * RT-44 repro (Phase 2 red team round 2, 2026-10-02): two live devices with ONE node id
 * (a database copied to a second machine: Electron/Tauri app data moved to a new
 * laptop, a VM image, a restored backup used alongside the original). Phase 2 turns their
 * sequence collisions into SEQUENCE_CONFLICT recoveries (renumber + full resync, RT-35)
 * instead of losses, but nothing detects the clone:
 *
 * - each copy's writes are "own operations" for the other, which a resumed stream and
 *   the live relay never deliver, so the copies diverge while connected and only catch
 *   up at the next full resync;
 * - every colliding write costs a renumber AND a full resync from 0 (the whole dataset
 *   is downloaded again), for as long as both copies are used.
 *
 * Asserts the CORRECT behaviour (fails today): a write on one copy reaches the other
 * while both are connected (or the clone is detected and one copy moves to a new node),
 * and the copies do not fall into repeated full resyncs.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, t } from '@korajs/core'
import type { KoraEvent } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../../src/test-device'
import { TestServer } from '../../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { notes: { fields: { body: t.string() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

function pair(): { client: SyncTransport; serverTransport: ServerTransport } {
	const p = createServerTransportPair()
	return { client: p.client as unknown as SyncTransport, serverTransport: p.server }
}

describe('RT-44: a cloned database (one node id on two live devices)', () => {
	test('writes of one copy reach the other while connected, without repeated full resyncs', async () => {
		const server = new TestServer(schema)
		cleanup.push(() => server.close())
		const dir = mkdtempSync(join(tmpdir(), 'rt44-'))
		cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
		const mk = (name: string) =>
			new TestDevice({ name, schema, server, tmpDir: dir, createTransportPair: pair })

		const original = mk('original')
		await original.open()
		await original.sync()
		await original.collection('notes').insert({ body: 'before the copy' })
		await original.sync()
		await original.disconnect()
		await original.close()
		copyFileSync(join(dir, 'test-device-original.db'), join(dir, 'test-device-copy.db'))

		const a = mk('original')
		const b = mk('copy')
		await a.open()
		await b.open()
		cleanup.push(() => a.close())
		cleanup.push(() => b.close())
		expect(a.getNodeId()).toBe(b.getNodeId())
		const recoveries: KoraEvent[] = []
		for (const d of [a, b]) {
			d.emitter.on('sync:local-node', (e) => {
				if (e.type === 'sync:local-node' && e.action === 'history-behind') recoveries.push(e)
			})
		}
		await a.sync()
		await b.sync()

		// Both copies in use, both connected.
		for (let i = 0; i < 3; i++) {
			await a.collection('notes').insert({ body: `a-${i}` })
			await b.collection('notes').insert({ body: `b-${i}` })
			await a.sync()
			await b.sync()
		}
		await a.sync()
		await b.sync()
		const bodies = async (d: TestDevice) =>
			(await d.getState('notes')).map((n) => String(n.body)).sort()

		expect({
			aSeesB: (await bodies(a)).filter((x) => x.startsWith('b-')),
			bSeesA: (await bodies(b)).filter((x) => x.startsWith('a-')),
			recoveries: recoveries.length,
		}).toEqual({ aSeesB: ['b-0', 'b-1', 'b-2'], bSeesA: ['a-0', 'a-1', 'a-2'], recoveries: 0 })
	}, 60_000)
})
