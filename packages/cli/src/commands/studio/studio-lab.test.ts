import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { LabManager, defaultLabSchema } from './lab-manager'
import { replayToOperation, sortByHlc } from './studio-replay'
import type { StudioServer } from './studio-server'
import { startStudioServer } from './studio-server'

/**
 * Lab mode contract: the laboratory runs REAL devices against a REAL server,
 * so conflicts, convergence, chaos, and atomic composition observed in the UI
 * are evidence of shipped behavior, not simulation.
 */
describe('Kora Studio Lab', () => {
	let lab: LabManager
	let server: StudioServer

	beforeAll(async () => {
		lab = new LabManager(defaultLabSchema())
		await lab.start(2)
		server = await startStudioServer({ port: 0, lab })
	})

	afterAll(async () => {
		await server.close()
		await lab.close()
	})

	test('starts with connected devices and reports state over HTTP', async () => {
		const stateResponse = (await (await fetch(`${server.url}/api/lab/state`)).json()) as {
			devices: Array<{ name: string; connected: boolean }>
			collections: Array<{ name: string; fields: Array<{ name: string }> }>
		}
		expect(stateResponse.devices).toHaveLength(2)
		expect(stateResponse.collections[0]?.name).toBe('tasks')
		expect(stateResponse.collections[0]?.fields.map((f) => f.name)).toContain('points')
	})

	test('full conflict lifecycle: edit offline on both, diverge, reconnect, converge', async () => {
		const [a, b] = lab.listDevices().map((d) => d.name)
		if (!a || !b) throw new Error('missing devices')

		// Seed and propagate.
		const created = await lab.insert(a, 'tasks', { title: 'contested' })
		const recordId = String(created.id)
		await lab.sync(a)
		await lab.sync(b)

		// Both offline; conflicting same-field edits.
		await lab.disconnect(a)
		await lab.disconnect(b)
		await lab.update(a, 'tasks', recordId, { title: 'A version' })
		await lab.update(b, 'tasks', recordId, { title: 'B version' })

		const diverged = await lab.convergence()
		expect(diverged.converged).toBe(false)

		// Reconnect and exchange.
		await lab.connect(a)
		await lab.connect(b)
		await lab.sync(a)
		await lab.sync(b)
		await lab.sync(a)

		const converged = await lab.convergence()
		expect(converged.converged).toBe(true)
	}, 30000)

	test('atomic increments on two devices compose through the lab', async () => {
		const [a, b] = lab.listDevices().map((d) => d.name)
		if (!a || !b) throw new Error('missing devices')

		const created = await lab.insert(a, 'tasks', { title: 'counter', points: 10 })
		const recordId = String(created.id)
		await lab.sync(a)
		await lab.sync(b)

		await lab.disconnect(a)
		await lab.disconnect(b)
		await lab.update(a, 'tasks', recordId, {}, { points: 3 })
		await lab.update(b, 'tasks', recordId, {}, { points: 5 })
		await lab.connect(a)
		await lab.connect(b)
		await lab.sync(a)
		await lab.sync(b)
		await lab.sync(a)

		const report = await lab.convergence()
		expect(report.converged).toBe(true)

		// Verify the composed value through the HTTP API (per-device reader).
		const records = (await (
			await fetch(`${server.url}/api/collections/tasks/records?device=${a}&search=counter`)
		).json()) as { records: Array<{ id: string; fields: { points: number } }> }
		const record = records.records.find((r) => r.id === recordId)
		expect(record?.fields.points).toBe(18)
	}, 30000)

	test('chaos settings apply and devices still converge once the network heals', async () => {
		const [a] = lab.listDevices().map((d) => d.name)
		if (!a) throw new Error('missing device')
		const chaos = lab.setChaos(a, { dropRate: 0.2, reorderRate: 0.1 })
		expect(chaos.dropRate).toBe(0.2)

		await lab.disconnect(a)
		await lab.connect(a) // chaos transport now active
		await lab.insert(a, 'tasks', { title: 'through chaos' })

		// A few chaotic rounds (may or may not fully converge — drops are random)…
		for (let i = 0; i < 4; i++) {
			for (const d of lab.listDevices()) {
				await lab.sync(d.name)
			}
		}

		// …then the network HEALS (chaos off, reconnect): convergence is now
		// guaranteed, not probabilistic — tests must never depend on luck.
		lab.setChaos(a, { dropRate: 0, duplicateRate: 0, reorderRate: 0, maxLatency: 0 })
		await lab.disconnect(a)
		await lab.connect(a)
		for (let i = 0; i < 3; i++) {
			for (const d of lab.listDevices()) {
				await lab.sync(d.name)
			}
		}
		const report = await lab.convergence()
		expect(report.converged).toBe(true)
	}, 45000)

	test('live event feed captures operation and sync events', async () => {
		const events = lab.recentEvents()
		const types = new Set(events.map((e) => e.type))
		expect(types.has('operation:created')).toBe(true)
		expect(types.has('sync:received') || types.has('sync:sent')).toBe(true)
	})

	test('merge conflicts land in the durable audit trail (Merges tab)', async () => {
		// The conflict-lifecycle test above produced same-field merges; the audit
		// bridge (same wiring createApp uses) must have persisted them, and the
		// Studio Merges view reads exactly this table.
		const conflictEvents = lab.recentEvents().filter((e) => e.type === 'merge:conflict')
		expect(conflictEvents.length).toBeGreaterThan(0)

		const deviceName = conflictEvents[0]?.device
		const response = (await (
			await fetch(`${server.url}/api/audit?device=${deviceName}`)
		).json()) as { traces: Array<{ strategy: string; field: string; collection: string }> }
		expect(response.traces.length).toBeGreaterThan(0)
		expect(response.traces[0]?.collection).toBe('tasks')
	})

	test('lab HTTP mutation routes work end-to-end', async () => {
		const deviceName = lab.listDevices()[0]?.name
		const insertResponse = (await (
			await fetch(`${server.url}/api/lab/devices/${deviceName}/insert`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ collection: 'tasks', data: { title: 'via http' } }),
			})
		).json()) as { record: { id: string } }
		expect(insertResponse.record.id).toBeTruthy()

		const added = (await (
			await fetch(`${server.url}/api/lab/devices`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ name: 'device-X' }),
			})
		).json()) as { name: string; connected: boolean }
		expect(added.name).toBe('device-X')
	})
})

describe('replay fold (time travel)', () => {
	const baseOp = {
		nodeId: 'node-a',
		collection: 'tasks',
		previousData: null,
		sequenceNumber: 1,
		causalDeps: [],
		schemaVersion: 1,
	}

	test('folds inserts, updates, and deletes in HLC order to the causal cut', () => {
		const ops = [
			{
				...baseOp,
				id: 'op-1',
				type: 'insert',
				recordId: 'r1',
				data: { title: 'v1' },
				timestamp: { wallTime: 100, logical: 0, nodeId: 'node-a' },
			},
			{
				...baseOp,
				id: 'op-2',
				type: 'update',
				recordId: 'r1',
				data: { title: 'v2' },
				timestamp: { wallTime: 200, logical: 0, nodeId: 'node-b' },
			},
			{
				...baseOp,
				id: 'op-3',
				type: 'delete',
				recordId: 'r1',
				data: null,
				timestamp: { wallTime: 300, logical: 0, nodeId: 'node-a' },
			},
		]

		const atInsert = replayToOperation(ops, 'op-1')
		expect(atInsert.records[0]?.fields.title).toBe('v1')
		expect(atInsert.appliedCount).toBe(1)

		const atUpdate = replayToOperation(ops, 'op-2')
		expect(atUpdate.records[0]?.fields.title).toBe('v2')
		expect(atUpdate.records[0]?.lastWriterByField.title).toBe('node-b')

		const atDelete = replayToOperation(ops, 'op-3')
		expect(atDelete.records[0]?.deleted).toBe(true)

		// Unsorted input replays identically (HLC order is authoritative).
		const shuffled = [ops[2], ops[0], ops[1]].filter(
			(o): o is (typeof ops)[number] => o !== undefined,
		)
		expect(replayToOperation(shuffled, 'op-2').records[0]?.fields.title).toBe('v2')
		expect(sortByHlc(shuffled).map((o) => o.id)).toEqual(['op-1', 'op-2', 'op-3'])
	})
})
