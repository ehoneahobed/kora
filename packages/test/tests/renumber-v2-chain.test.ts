/**
 * Phase 3 seam 4: renumbering with content-hash v2 ids.
 *
 * A SEQUENCE_CONFLICT renumbering (RT-35: the device lost an acknowledged tail, its
 * next write reuses the lost op's sequence) re-hashes a version-2 op under a new id.
 * A chain of three dependent writes (insert, then two atomic increments, each naming
 * the previous one in causalDeps) whose FIRST op is renumbered must:
 * - converge on the server, the author and a peer, with each increment applied once;
 * - leave no operation stored twice (by id or by content);
 * - leave no dangling causal dependency: a dependent the server never got is
 *   rewritten (and re-hashed, transitively) to name the new id; one it already
 *   stored keeps its id and its dep resolves through the renumbering record
 *   (`_kora_seq_conflicts.reemitted_as`) on the author.
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineSchema, op, t, verifyOperationId } from '@korajs/core'
import type { Operation } from '@korajs/core'
import type { ServerTransport } from '@korajs/server'
import { createServerTransportPair } from '@korajs/server/internal'
import type { SyncMessage, SyncTransport } from '@korajs/sync'
import { afterEach, describe, expect, test } from 'vitest'
import { TestDevice } from '../src/test-device'
import { TestServer } from '../src/test-server'

const schema = defineSchema({
	version: 1,
	collections: { items: { fields: { title: t.string(), count: t.number() } } },
})

let cleanup: Array<() => Promise<void> | void> = []
afterEach(async () => {
	for (const fn of cleanup.reverse()) await fn()
	cleanup = []
})

/** Holds the server's answers to uploads (rejections, acks) until released. */
class HoldingServerTransport implements ServerTransport {
	hold = false
	private held: SyncMessage[] = []
	constructor(private readonly inner: ServerTransport) {}
	send(message: SyncMessage): void {
		if (this.hold && (message.type === 'operation-rejected' || message.type === 'acknowledgment')) {
			this.held.push(message)
			return
		}
		this.inner.send(message)
	}
	release(): void {
		this.hold = false
		const held = this.held
		this.held = []
		for (const message of held) this.inner.send(message)
	}
	onMessage(handler: (message: SyncMessage) => void): void {
		this.inner.onMessage(handler)
	}
	onClose(handler: (code: number, reason: string) => void): void {
		this.inner.onClose(handler)
	}
	onError(handler: (error: Error) => void): void {
		this.inner.onError(handler)
	}
	isConnected(): boolean {
		return this.inner.isConnected()
	}
	close(code?: number, reason?: string): void {
		this.inner.close(code, reason)
	}
}

function makeDevice(
	server: TestServer,
	tmp: string,
	name: string,
	holders: HoldingServerTransport[] = [],
): TestDevice {
	return new TestDevice({
		name,
		schema,
		server,
		tmpDir: tmp,
		createTransportPair: () => {
			const pair = createServerTransportPair()
			const holding = new HoldingServerTransport(pair.server)
			holders.push(holding)
			return { client: pair.client as unknown as SyncTransport, serverTransport: holding }
		},
	})
}

async function seqConflictAliases(device: TestDevice): Promise<Map<string, string>> {
	const adapter = (
		device as unknown as {
			adapter: { query<T>(sql: string, params?: unknown[]): Promise<T[]> }
		}
	).adapter
	const rows = await adapter.query<{ id: string; reemitted_as: string | null }>(
		'SELECT id, reemitted_as FROM _kora_seq_conflicts',
	)
	return new Map(rows.flatMap((r) => (r.reemitted_as ? [[r.id, r.reemitted_as] as const] : [])))
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 200))

describe('renumbering a version-2 op with dependents (seam 4)', () => {
	test.each([
		// The dependents are written while the first op's upload is unanswered: they wait
		// unsent in the queue when it is renumbered, so they are rewritten (re-hashed).
		{ dependentsSent: false },
		// All three are uploaded in one batch: the server stores the dependents before
		// the first op is renumbered; they keep their ids and their dep resolves through
		// the renumbering record.
		{ dependentsSent: true },
	])(
		'a dependent chain whose first op is renumbered converges, applied once, no dangling deps (%o)',
		async ({ dependentsSent }) => {
			const server = new TestServer(schema)
			cleanup.push(() => server.close())
			const tmp = mkdtempSync(join(tmpdir(), 'renumber-v2-'))
			cleanup.push(() => rmSync(tmp, { recursive: true, force: true }))
			const dbPath = join(tmp, 'test-device-laptop.db')

			const d1 = makeDevice(server, tmp, 'laptop')
			await d1.open()
			await d1.sync()
			await d1.collection('items').insert({ title: 'first', count: 0 })
			await d1.sync()
			const adapter = (d1 as unknown as { adapter: { execute(sql: string): Promise<void> } })
				.adapter
			await adapter.execute(`VACUUM INTO '${join(tmp, 'snapshot.db')}'`)
			// Uploaded and acknowledged, then lost locally (RT-35).
			await d1.collection('items').insert({ title: 'lost', count: 0 })
			await d1.sync()
			await d1.close()
			rmSync(`${dbPath}-wal`, { force: true })
			rmSync(`${dbPath}-shm`, { force: true })
			copyFileSync(join(tmp, 'snapshot.db'), dbPath)

			// After the reload, offline: the first write reuses the lost op's sequence.
			const holders: HoldingServerTransport[] = []
			const d2 = makeDevice(server, tmp, 'laptop', holders)
			await d2.open()
			cleanup.push(() => d2.close())
			const node = d2.getNodeId()
			const item = await d2.collection('items').insert({ title: 'chain', count: 0 })
			const id = String(item.id)
			if (dependentsSent) {
				await d2.collection('items').update(id, { count: op.increment(1) })
				await d2.collection('items').update(id, { count: op.increment(1) })
				for (let i = 0; i < 4; i++) await d2.sync()
			} else {
				// Connect with the server's answers held: the first op is on the wire, its
				// SEQUENCE_CONFLICT not yet received. Two dependent writes queue behind it.
				const originalCreate = holders.length
				void originalCreate
				const syncing = d2.sync()
				await new Promise((resolve) => setTimeout(resolve, 0))
				for (const holder of holders) holder.hold = true
				await syncing
				await d2.collection('items').update(id, { count: op.increment(1) })
				await d2.collection('items').update(id, { count: op.increment(1) })
				await settle()
				const queued = d2.getSyncEngine()?.getOutboundQueue()
				expect(queued?.getAll().filter((o) => !queued.wasSent(o.id))).toHaveLength(2)
				for (const holder of holders) holder.release()
				await settle()
				for (let i = 0; i < 4; i++) await d2.sync()
			}
			const before = (await d2.store.getOperationsForRecord('items', id)).filter(
				(o) => o.nodeId === node,
			)

			const peer = makeDevice(server, tmp, 'phone')
			await peer.open()
			cleanup.push(() => peer.close())
			await peer.sync()
			await peer.sync()

			// Converged, each increment applied exactly once.
			expect(await d2.getRejectedOperations()).toEqual([])
			expect(await server.store.findRecord('items', id)).toMatchObject({ title: 'chain', count: 2 })
			expect(await d2.collection('items').findById(id)).toMatchObject({ count: 2 })
			expect(await peer.collection('items').findById(id)).toMatchObject({ count: 2 })

			// The first op WAS renumbered (the scenario happened), under a new id.
			const aliases = await seqConflictAliases(d2)
			expect(aliases.size).toBeGreaterThanOrEqual(1)

			// Nothing stored twice: three ops for the record on the server, distinct
			// (node, sequence), every one a valid version-2 id.
			const stored = server.getAllOperations().filter((o) => o.recordId === id)
			expect(stored).toHaveLength(3)
			expect(new Set(stored.map((o) => `${o.nodeId}:${o.sequenceNumber}`)).size).toBe(3)
			for (const o of stored) expect(await verifyOperationId(o)).toBe(true)

			// Every replica holds the same ids.
			const serverIds = stored.map((o) => o.id).sort()
			const authorLog = await d2.store.getOperationsForRecord('items', id)
			const peerLog = await peer.store.getOperationsForRecord('items', id)
			expect(authorLog.map((o) => o.id).sort()).toEqual(serverIds)
			expect(peerLog.map((o) => o.id).sort()).toEqual(serverIds)
			expect(before.map((o) => o.id).sort()).toEqual(serverIds)

			// No dangling dep: on the author each dep (into this record) is in the log or
			// resolves through the renumbering record; when the dependents were never sent,
			// every replica names the new id directly.
			const ids = new Set(serverIds)
			const known = new Set([...ids, ...aliases.keys()])
			const resolve = (dep: string): string => aliases.get(dep) ?? dep
			for (const o of authorLog as Operation[]) {
				for (const dep of o.causalDeps) {
					if (!known.has(dep)) continue // a dep on another record's op
					expect(ids.has(resolve(dep)), `dep ${dep} of ${o.id}`).toBe(true)
					if (!dependentsSent) expect(ids.has(dep), `dependent ${o.id} kept ${dep}`).toBe(true)
				}
			}
			// The causal cut of the last write reaches the renumbered insert (time travel).
			const last = [...before].sort((x, y) => x.sequenceNumber - y.sequenceNumber).at(-1)
			const replayTarget = authorLog.find(
				(o) => o.type === 'update' && !authorLog.some((other) => other.causalDeps.includes(o.id)),
			)
			expect(replayTarget ?? last).toBeDefined()
			const snapshot = await d2.store.replayTo(String((replayTarget ?? last)?.id))
			expect(snapshot.findRecord('items', id)).toMatchObject({ title: 'chain', count: 2 })

			const chainDeps = stored.flatMap((o) => o.causalDeps).filter((dep) => known.has(dep))
			expect(chainDeps.length).toBeGreaterThanOrEqual(2)
			if (!dependentsSent) for (const dep of chainDeps) expect(ids.has(dep)).toBe(true)
		},
		60_000,
	)
})
