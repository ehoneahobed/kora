import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Operation, SchemaDefinition } from '@korajs/core'
import { op as atomicOp, defineSchema, t } from '@korajs/core'

/**
 * Default Lab schema: covers every merge tier so the Lab can demonstrate the
 * whole system — scalar LWW (title/assignee/priority/done), add-wins arrays
 * (tags), and atomic increment composition (points).
 */
export function defaultLabSchema(): SchemaDefinition {
	return defineSchema({
		version: 1,
		collections: {
			tasks: {
				fields: {
					title: t.string(),
					assignee: t.string().optional(),
					priority: t.enum(['low', 'medium', 'high']).default('medium'),
					done: t.boolean().default(false),
					tags: t.array(t.string()).default([]),
					points: t.number().default(0),
				},
			},
		},
	})
}

/**
 * Kora Studio Lab: an interactive, in-process multi-device sync laboratory.
 *
 * Every device is a REAL Kora client (its own SQLite store, sync engine, merge
 * pipeline) talking to a REAL sync server over in-memory transports, optionally
 * wrapped in a chaos transport. Nothing is simulated at the data layer, so what
 * the Lab shows is evidence, not illustration: conflicts, convergence, chaos
 * recovery, and atomic-op composition all run the exact code that ships.
 *
 * The Lab only ever touches throwaway databases in a temp directory — it can
 * never write to a user's real data.
 */

/** Per-device chaos settings; applied on the device's NEXT connect. */
export interface LabChaosConfig {
	dropRate: number
	duplicateRate: number
	reorderRate: number
	maxLatency: number
}

export interface LabDeviceState {
	name: string
	nodeId: string
	connected: boolean
	chaos: LabChaosConfig
	/** Path of this device's SQLite DB — Studio's readers attach here. */
	dbPath: string
	pendingOperations: number
}

export interface LabEvent {
	seq: number
	at: number
	device: string
	type: string
	summary: string
}

export interface LabConvergenceReport {
	converged: boolean
	deviceCount: number
	differences: string[]
}

/** Structural interfaces for the lazily-imported @korajs/test harness. */
interface HarnessDevice {
	readonly name: string
	readonly emitter: {
		on(type: string, listener: (event: Record<string, unknown>) => void): () => void
	}
	open(): Promise<void>
	sync(): Promise<void>
	disconnect(): Promise<void>
	close(): Promise<void>
	collection(name: string): {
		insert(data: Record<string, unknown>): Promise<Record<string, unknown>>
		update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>>
		delete(id: string): Promise<void>
	}
	getNodeId(): string
	getSyncEngine(): { getStatus(): { pendingOperations: number } } | null
	isConnected(): boolean
}

interface Harness {
	TestServer: new (
		schema: SchemaDefinition,
	) => {
		handleConnection(transport: unknown): string
		getAllOperations(): Operation[]
		getConnectionCount(): number
		close(): Promise<void>
	}
	TestDevice: new (options: {
		name: string
		schema: SchemaDefinition
		server: unknown
		createTransportPair: () => { client: unknown; serverTransport: unknown }
		tmpDir: string
	}) => HarnessDevice
	checkConvergence(
		devices: unknown[],
		schema: SchemaDefinition,
	): Promise<{
		converged: boolean
		differences: Array<{ collection: string; description?: string }>
	}>
	ChaosTransport: new (inner: unknown, config: Record<string, unknown>) => unknown
	/** Returns { client, server } — note the property name is `server`. */
	createServerTransportPair: () => { client: unknown; server: unknown }
}

const DEFAULT_CHAOS: LabChaosConfig = {
	dropRate: 0,
	duplicateRate: 0,
	reorderRate: 0,
	maxLatency: 0,
}

/** Event types forwarded into the Lab's live feed. */
const FORWARDED_EVENTS = [
	'operation:created',
	'operation:applied',
	'merge:started',
	'merge:conflict',
	'merge:completed',
	'sync:connected',
	'sync:disconnected',
	'sync:sent',
	'sync:received',
	'sync:apply-failed',
] as const

const MAX_EVENT_BUFFER = 500

export class LabManager {
	private readonly devices = new Map<
		string,
		{ device: HarnessDevice; chaos: LabChaosConfig; unsubscribes: Array<() => void> }
	>()
	private server: InstanceType<Harness['TestServer']> | null = null
	private harness: Harness | null = null
	private tmpDir: string | null = null
	private eventSeq = 0
	private readonly eventBuffer: LabEvent[] = []
	private readonly eventListeners = new Set<(event: LabEvent) => void>()
	private deviceCounter = 0

	constructor(private readonly schema: SchemaDefinition) {}

	/** Load the harness lazily so file-mode Studio never needs @korajs/test. */
	private async loadHarness(): Promise<Harness> {
		if (this.harness) {
			return this.harness
		}
		try {
			const testPkg = (await import('@korajs/test')) as unknown as Record<string, unknown>
			const serverInternal = (await import('@korajs/server/internal')) as unknown as Record<
				string,
				unknown
			>
			this.harness = {
				TestServer: testPkg.TestServer as Harness['TestServer'],
				TestDevice: testPkg.TestDevice as Harness['TestDevice'],
				checkConvergence: testPkg.checkConvergence as Harness['checkConvergence'],
				ChaosTransport: testPkg.ChaosTransport as Harness['ChaosTransport'],
				createServerTransportPair:
					serverInternal.createServerTransportPair as Harness['createServerTransportPair'],
			}
			return this.harness
		} catch (error) {
			throw new Error(
				`Kora Studio Lab needs "@korajs/test" and "@korajs/server" installed (pnpm add -D @korajs/test @korajs/server). Underlying error: ${
					error instanceof Error ? error.message : String(error)
				}`,
			)
		}
	}

	async start(initialDevices = 2): Promise<void> {
		const harness = await this.loadHarness()
		this.tmpDir = mkdtempSync(join(tmpdir(), 'kora-studio-lab-'))
		this.server = new harness.TestServer(this.schema)
		for (let i = 0; i < initialDevices; i++) {
			await this.addDevice()
		}
	}

	async addDevice(name?: string): Promise<LabDeviceState> {
		const harness = await this.loadHarness()
		if (!this.server || !this.tmpDir) {
			throw new Error('Lab is not started')
		}
		const deviceName = name?.trim() || `device-${String.fromCharCode(65 + this.deviceCounter)}`
		this.deviceCounter++
		if (this.devices.has(deviceName)) {
			throw new Error(`Device "${deviceName}" already exists`)
		}

		const chaos: LabChaosConfig = { ...DEFAULT_CHAOS }
		const entry = { chaos }
		const device = new harness.TestDevice({
			name: deviceName,
			schema: this.schema,
			server: this.server,
			// Read the CURRENT chaos settings each time a connection is made, so
			// toggling chaos + reconnecting applies it without rebuilding the device.
			createTransportPair: () => {
				const pair = harness.createServerTransportPair()
				const hasChaos =
					entry.chaos.dropRate > 0 ||
					entry.chaos.duplicateRate > 0 ||
					entry.chaos.reorderRate > 0 ||
					entry.chaos.maxLatency > 0
				return {
					client: hasChaos
						? new harness.ChaosTransport(pair.client, { ...entry.chaos })
						: pair.client,
					serverTransport: pair.server,
				}
			},
			tmpDir: this.tmpDir,
		})
		await device.open()

		const unsubscribes = FORWARDED_EVENTS.map((type) =>
			device.emitter.on(type, (event) => this.pushEvent(deviceName, type, event)),
		)

		this.devices.set(deviceName, { device, chaos, unsubscribes })
		this.pushEvent(deviceName, 'lab:device-added', {})
		return this.deviceState(deviceName)
	}

	listDevices(): LabDeviceState[] {
		return [...this.devices.keys()].map((name) => this.deviceState(name))
	}

	deviceState(name: string): LabDeviceState {
		const entry = this.mustGet(name)
		return {
			name,
			nodeId: entry.device.getNodeId(),
			connected: entry.device.isConnected(),
			chaos: { ...entry.chaos },
			dbPath: join(this.tmpDir ?? '', `test-device-${name}.db`),
			pendingOperations: entry.device.getSyncEngine()?.getStatus().pendingOperations ?? 0,
		}
	}

	async connect(name: string): Promise<void> {
		await this.mustGet(name).device.sync()
		this.pushEvent(name, 'lab:connected', {})
	}

	async disconnect(name: string): Promise<void> {
		await this.mustGet(name).device.disconnect()
		this.pushEvent(name, 'lab:disconnected', {})
	}

	async sync(name: string): Promise<void> {
		await this.mustGet(name).device.sync()
	}

	setChaos(name: string, chaos: Partial<LabChaosConfig>): LabChaosConfig {
		const entry = this.mustGet(name)
		entry.chaos.dropRate = clamp01(chaos.dropRate ?? entry.chaos.dropRate)
		entry.chaos.duplicateRate = clamp01(chaos.duplicateRate ?? entry.chaos.duplicateRate)
		entry.chaos.reorderRate = clamp01(chaos.reorderRate ?? entry.chaos.reorderRate)
		entry.chaos.maxLatency = Math.max(0, chaos.maxLatency ?? entry.chaos.maxLatency)
		this.pushEvent(name, 'lab:chaos-changed', { ...entry.chaos })
		return { ...entry.chaos }
	}

	async insert(
		name: string,
		collection: string,
		data: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		return this.mustGet(name).device.collection(collection).insert(data)
	}

	async update(
		name: string,
		collection: string,
		recordId: string,
		data: Record<string, unknown>,
		increments?: Record<string, number>,
	): Promise<Record<string, unknown>> {
		// Intent-preserving atomic increments: concurrent increments on two
		// devices COMPOSE to the sum instead of last-write-wins — the Lab's most
		// striking demonstration.
		const payload: Record<string, unknown> = { ...data }
		for (const [field, delta] of Object.entries(increments ?? {})) {
			payload[field] = atomicOp.increment(delta)
		}
		return this.mustGet(name).device.collection(collection).update(recordId, payload)
	}

	async delete(name: string, collection: string, recordId: string): Promise<void> {
		await this.mustGet(name).device.collection(collection).delete(recordId)
	}

	async convergence(): Promise<LabConvergenceReport> {
		const harness = await this.loadHarness()
		const devices = [...this.devices.values()].map((e) => e.device)
		if (devices.length < 2) {
			return { converged: true, deviceCount: devices.length, differences: [] }
		}
		const result = await harness.checkConvergence(devices, this.schema)
		return {
			converged: result.converged,
			deviceCount: devices.length,
			differences: result.differences.map(
				(d) => d.description ?? `collection "${d.collection}" differs`,
			),
		}
	}

	serverOperationCount(): number {
		return this.server?.getAllOperations().length ?? 0
	}

	getSchema(): SchemaDefinition {
		return this.schema
	}

	/** Recent events (for initial page load), oldest first. */
	recentEvents(): LabEvent[] {
		return [...this.eventBuffer]
	}

	onEvent(listener: (event: LabEvent) => void): () => void {
		this.eventListeners.add(listener)
		return () => this.eventListeners.delete(listener)
	}

	async close(): Promise<void> {
		for (const [, entry] of this.devices) {
			for (const unsub of entry.unsubscribes) {
				unsub()
			}
			await entry.device.close().catch(() => {})
		}
		this.devices.clear()
		await this.server?.close().catch(() => {})
		this.server = null
		if (this.tmpDir) {
			rmSync(this.tmpDir, { recursive: true, force: true })
			this.tmpDir = null
		}
	}

	private mustGet(name: string): { device: HarnessDevice; chaos: LabChaosConfig } {
		const entry = this.devices.get(name)
		if (!entry) {
			throw new Error(`Unknown device "${name}"`)
		}
		return entry
	}

	private pushEvent(device: string, type: string, payload: Record<string, unknown>): void {
		const event: LabEvent = {
			seq: ++this.eventSeq,
			at: Date.now(),
			device,
			type,
			summary: summarizeEvent(type, payload),
		}
		this.eventBuffer.push(event)
		if (this.eventBuffer.length > MAX_EVENT_BUFFER) {
			this.eventBuffer.shift()
		}
		for (const listener of this.eventListeners) {
			listener(event)
		}
	}
}

function clamp01(n: number): number {
	return Math.min(1, Math.max(0, n))
}

function summarizeEvent(type: string, payload: Record<string, unknown>): string {
	const op = payload.operation as
		| { type?: string; collection?: string; recordId?: string; data?: Record<string, unknown> }
		| undefined
	switch (type) {
		case 'operation:created':
			return op
				? `${op.type} ${op.collection}/${String(op.recordId).slice(0, 8)}… ${op.data ? JSON.stringify(op.data).slice(0, 60) : ''}`
				: 'operation created'
		case 'operation:applied':
			return op
				? `applied ${op.type} ${op.collection}/${String(op.recordId).slice(0, 8)}…`
				: 'applied'
		case 'merge:conflict':
			return 'merge conflict resolved'
		case 'merge:started':
			return 'merge started'
		case 'merge:completed':
			return 'merge completed'
		case 'sync:sent': {
			const count = Array.isArray(payload.operations) ? payload.operations.length : 0
			return `sent ${count} op(s)`
		}
		case 'sync:received': {
			const count = Array.isArray(payload.operations) ? payload.operations.length : 0
			return `received ${count} op(s)`
		}
		case 'sync:connected':
			return 'connected to server'
		case 'sync:disconnected':
			return 'disconnected'
		case 'sync:apply-failed':
			return 'APPLY FAILED'
		case 'lab:chaos-changed':
			return `chaos → drop ${payload.dropRate} dup ${payload.duplicateRate} reorder ${payload.reorderRate} latency ${payload.maxLatency}ms`
		default:
			return type.replace('lab:', '')
	}
}
