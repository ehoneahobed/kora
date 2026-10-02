/**
 * Randomized multi-device workloads for the W7 convergence gate, run END TO END
 * through real devices (Store + ApplyPipeline + SyncEngine) and the test server.
 *
 * A seed picks a schema (a subset of every field kind a device can write: scalars,
 * enum, timestamp, numbers with atomic increments, arrays with duplicates, objects,
 * json with shape changes, counter / max / min / append-only / server-authoritative
 * strategies, an additive custom resolver, real Yjs richtext) and drives 2-4
 * devices that go offline, edit concurrently, delete, and reconnect in random
 * order. Deterministic in the seed (mulberry32), except wall-clock timing.
 */
import { type SchemaDefinition, defineSchema, foldRecord, materialize, op, t } from '@korajs/core'
import { mergeYjsUpdates } from '@korajs/store'
import * as Y from 'yjs'
import type { TestDevice, TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

export type Rng = () => number

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let x = a
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296
	}
}

const pick = <T>(rng: Rng, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T
const chance = (rng: Rng, p: number): boolean => rng() < p
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))

const FIELDS = {
	title: () => t.string(),
	count: () => t.number(),
	done: () => t.boolean(),
	prio: () => t.enum(['low', 'mid', 'high']),
	due: () => t.timestamp().optional(),
	tags: () => t.array(t.string()),
	meta: () => t.object({ a: t.string(), b: t.number() }),
	doc: () => t.json().optional(),
	score: () => t.number().merge('counter'),
	hi: () => t.number().merge('max'),
	lo: () => t.number().merge('min'),
	log: () => t.array(t.string()).merge('append-only'),
	auth: () => t.string().merge('server-authoritative'),
	inv: () => t.number(),
	body: () => t.richtext(),
} as const

export type GateField = keyof typeof FIELDS
export const GATE_FIELDS = Object.keys(FIELDS) as GateField[]

/** Field kind label for reports (which documented semantic change can explain a difference). */
export const FIELD_KIND: Record<GateField, string> = {
	title: 'scalar',
	count: 'atomic',
	done: 'scalar',
	prio: 'scalar',
	due: 'scalar',
	tags: 'array',
	meta: 'object',
	doc: 'object',
	score: 'counter',
	hi: 'extremum',
	lo: 'extremum',
	log: 'append-only',
	auth: 'scalar',
	inv: 'resolver',
	body: 'richtext',
}

export function buildSchema(fields: readonly GateField[]): SchemaDefinition {
	const builders: Record<string, ReturnType<(typeof FIELDS)[GateField]>> = {}
	for (const field of fields) builders[field] = FIELDS[field]()
	return defineSchema({
		version: 1,
		collections: {
			items: {
				fields: builders,
				resolve: fields.includes('inv')
					? {
							inv: (local: unknown, remote: unknown, base: unknown) =>
								(Number(local) || 0) + ((Number(remote) || 0) - (Number(base) || 0)),
						}
					: {},
			},
		},
	}) as unknown as SchemaDefinition
}

const STRINGS = ['a', 'b', 'c', 'd']
const TAGS = ['t1', 't2', 't3', 't4']

export function richtextText(value: unknown): string | null {
	if (!(value instanceof Uint8Array))
		return value === null || value === undefined ? null : String(value)
	const doc = new Y.Doc()
	Y.applyUpdate(doc, value)
	return doc.getText('content').toString()
}

function editRichtext(rng: Rng, current: unknown, clientId: number): Uint8Array {
	const doc = new Y.Doc()
	// A fresh client id per edit: Yjs needs one per editing session.
	doc.clientID = clientId * 1_000_000 + int(rng, 1, 999_999)
	if (current instanceof Uint8Array) Y.applyUpdate(doc, current)
	const text = doc.getText('content')
	if (text.length > 0 && chance(rng, 0.3)) text.delete(int(rng, 0, text.length - 1), 1)
	else text.insert(int(rng, 0, text.length), pick(rng, STRINGS))
	return Y.encodeStateAsUpdate(doc)
}

function initialValue(field: GateField): unknown {
	switch (field) {
		case 'title':
		case 'auth':
			return 'x'
		case 'count':
		case 'score':
		case 'hi':
		case 'lo':
		case 'inv':
			return 10
		case 'done':
			return false
		case 'prio':
			return 'low'
		case 'due':
			return 1000
		case 'tags':
			return ['t1']
		case 'log':
			return ['created']
		case 'meta':
			return { a: 'x', b: 0 }
		case 'doc':
			return { x: 'a' }
		case 'body':
			return 'hi'
	}
}

/** A new value for `field`, written by a device that currently sees `current`. */
function nextValue(rng: Rng, field: GateField, current: unknown, clientId: number): unknown {
	switch (field) {
		case 'title':
		case 'auth':
			return pick(rng, STRINGS)
		case 'count':
			return chance(rng, 0.5) ? op.increment(int(rng, -2, 5)) : int(rng, 0, 20)
		case 'done':
			return !current
		case 'prio':
			return pick(rng, ['low', 'mid', 'high'])
		case 'due':
			return chance(rng, 0.15) ? null : int(rng, 1, 9) * 1000
		case 'tags':
		case 'log': {
			const next = Array.isArray(current) ? [...(current as string[])] : []
			if (next.length > 0 && chance(rng, 0.45)) next.splice(int(rng, 0, next.length - 1), 1)
			if (chance(rng, 0.75)) {
				const tag = pick(rng, TAGS)
				// Duplicates are data: arrays are multisets.
				if (!next.includes(tag) || chance(rng, 0.35)) next.push(tag)
			}
			return next
		}
		case 'meta': {
			const base = { a: 'x', b: 0, ...((current as Record<string, unknown>) ?? {}) }
			return chance(rng, 0.5) ? { ...base, a: pick(rng, STRINGS) } : { ...base, b: int(rng, 0, 5) }
		}
		case 'doc': {
			const r = rng()
			if (r < 0.08) return null
			if (r < 0.14) return [int(rng, 0, 2)]
			const base =
				typeof current === 'object' && current !== null && !Array.isArray(current)
					? { ...(current as Record<string, unknown>) }
					: {}
			const key = pick(rng, ['x', 'y', 'z'])
			if (chance(rng, 0.25)) delete base[key]
			else base[key] = chance(rng, 0.3) ? { deep: pick(rng, STRINGS) } : pick(rng, STRINGS)
			return base
		}
		case 'score':
			return (Number(current) || 0) + int(rng, -3, 4)
		case 'hi':
		case 'lo':
			return int(rng, 0, 30)
		case 'inv':
			return (Number(current) || 0) + int(rng, -3, 5)
		case 'body':
			return editRichtext(rng, current, clientId)
	}
}

export interface WorkloadResult {
	seed: number
	fields: GateField[]
	/** device name -> materialized record (null when deleted / absent), normalized. */
	devices: Record<string, Record<string, unknown> | null>
	/** The from-scratch fold of the union of every device's log, normalized. */
	oracle: Record<string, unknown> | null
	/** Every device holds the same operation ids for the record. */
	sameLogs: boolean
	/** The server's materialized row, normalized (B2: server materialization). */
	server: Record<string, unknown> | null
	log: string[]
	/** The union of every device's operations for the record. */
	operations: import('@korajs/core').Operation[]
	/** The schema of the run. */
	schema: SchemaDefinition
}

/** Comparable form of a record: richtext as its text, no metadata. */
export function normalizeRecord(
	record: Record<string, unknown> | null | undefined,
	fields: readonly GateField[],
): Record<string, unknown> | null {
	if (!record) return null
	const out: Record<string, unknown> = {}
	for (const field of fields) {
		const value = record[field]
		out[field] = field === 'body' ? richtextText(value) : (value ?? null)
	}
	return out
}

/**
 * Run one seeded workload through real devices and return every replica's view.
 *
 * @param seed - The seed
 * @param options - `legacyMerge` runs the devices on the beta.13 pipeline
 */
export async function runWorkload(
	seed: number,
	options: { legacyMerge?: boolean; onlyFields?: readonly GateField[] } = {},
): Promise<WorkloadResult> {
	const rng = mulberry32(seed)
	const fields = options.onlyFields
		? [...options.onlyFields]
		: GATE_FIELDS.filter((field) => field === 'title' || chance(rng, 0.55))
	const schema = buildSchema(fields)
	const deviceCount = int(rng, 2, 4)
	const log: string[] = []
	let network: TestNetwork | null = null
	try {
		network = await createTestNetwork(schema, {
			devices: deviceCount,
			...(options.legacyMerge ? { legacyMerge: true } : {}),
		})
		const devices = network.devices
		const first = devices[0] as TestDevice
		const initial: Record<string, unknown> = {}
		for (const field of fields) initial[field] = initialValue(field)
		const created = await first.collection('items').insert(initial)
		const id = String(created.id)
		for (const device of devices) await device.sync()
		const online = new Set(devices.map((device) => device.name))

		const steps = int(rng, 6, 14)
		for (let step = 0; step < steps; step++) {
			const index = int(rng, 0, devices.length - 1)
			const device = devices[index] as TestDevice
			const roll = rng()
			if (roll < 0.25) {
				if (online.has(device.name)) {
					await device.disconnect()
					online.delete(device.name)
					log.push(`${device.name} offline`)
				} else {
					await device.sync()
					online.add(device.name)
					log.push(`${device.name} online`)
				}
				continue
			}
			const current = await device.collection('items').findById(id)
			if (!current) continue
			if (roll < 0.3) {
				await device.collection('items').delete(id)
				log.push(`${device.name} delete`)
				continue
			}
			const count = int(rng, 1, Math.min(3, fields.length))
			const chosen = [...fields].sort(() => rng() - 0.5).slice(0, count)
			const patch: Record<string, unknown> = {}
			for (const field of chosen) patch[field] = nextValue(rng, field, current[field], index + 1)
			log.push(
				`${device.name} update ${JSON.stringify(patch, (_k, v) => (v instanceof Uint8Array ? `<yjs ${v.length}B>` : v))}`,
			)
			await device.collection('items').update(id, patch)
			if (online.has(device.name) && chance(rng, 0.5)) await device.sync()
		}

		// Quiesce: everyone online, several passes in a random order.
		const order = [...devices].sort(() => rng() - 0.5)
		for (let pass = 0; pass < 3; pass++) for (const device of order) await device.sync()

		const views: Record<string, Record<string, unknown> | null> = {}
		const logs: string[] = []
		const union = new Map<string, import('@korajs/core').Operation>()
		for (const device of devices) {
			views[device.name] = normalizeRecord(await device.collection('items').findById(id), fields)
			const ops = await device.store.getOperationsForRecord('items', id)
			logs.push(
				ops
					.map((op) => op.id)
					.sort()
					.join(','),
			)
			for (const op of ops) union.set(op.id, op)
		}
		const folded = foldRecord([...union.values()], schema, { richtext: mergeYjsUpdates }).state
		const oracleRaw = folded ? materialize(folded, { richtext: mergeYjsUpdates }) : null
		const oracle = oracleRaw ? normalizeRecord(decodeOracle(oracleRaw), fields) : null
		const serverRow = (await network.server.store.findRecord('items', id)) as Record<
			string,
			unknown
		> | null
		const serverLive =
			serverRow && serverRow._deleted !== 1 && serverRow._deleted !== true ? serverRow : null
		return {
			seed,
			fields,
			devices: views,
			oracle,
			sameLogs: new Set(logs).size === 1,
			server: normalizeRecord(
				serverLive,
				fields.filter((field) => field !== 'body'),
			),
			log,
			operations: [...union.values()],
			schema,
		}
	} finally {
		await network?.close()
	}
}

/** The fold materializes op-data form (tagged bytes); turn richtext into bytes. */
function decodeOracle(record: Record<string, unknown>): Record<string, unknown> {
	const out = { ...record }
	const body = out.body
	if (body && typeof body === 'object' && '$koraBytes' in body) {
		out.body = Uint8Array.from(
			Buffer.from(String((body as { $koraBytes: string }).$koraBytes), 'base64'),
		)
	} else if (typeof body === 'string') {
		// A plain-string (reset) value: as a device stores it, a Yjs doc with the text.
		const doc = new Y.Doc()
		doc.clientID = 0
		doc.getText('content').insert(0, body)
		out.body = Y.encodeStateAsUpdate(doc)
	}
	return out
}

/** Run `count` seeds starting at `base`, `parallel` at a time. */
export async function runSeeds(
	base: number,
	count: number,
	parallel: number,
	run: (seed: number) => Promise<WorkloadResult>,
): Promise<WorkloadResult[]> {
	const results: WorkloadResult[] = []
	for (let i = 0; i < count; i += parallel) {
		const batch = Array.from(
			{ length: Math.min(parallel, count - i) },
			(_, j) => (base + i + j) >>> 0,
		)
		results.push(...(await Promise.all(batch.map((seed) => run(seed)))))
	}
	return results
}
