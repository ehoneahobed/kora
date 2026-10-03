/**
 * W7 convergence gate harness.
 *
 * - `generateScenario(seed)`: a random schema (subset of every field kind) and a
 *   random operation stream for ONE record, written by 2-4 simulated nodes that
 *   go offline, sync partially, write concurrently, hit equal wall times, insert
 *   onto an existing row, delete, and include a node whose clock lags far behind
 *   (very late offline ops). previousData is what the writing node actually saw.
 * - `oracleMaterialize(ops)`: an independent, whole-log specification of the
 *   fold semantics (no incremental state, no pruning, no join). The fold under
 *   test must agree with it on every scenario.
 * - `naiveArrivalOrderFold`: the pre-W7 shape (replay in arrival order). The gate
 *   must reject it, which proves the gate has teeth.
 */
import { HybridLogicalClock } from '../../../src/clock/hlc'
import { applyAtomicOp } from '../../../src/operations/atomic-ops'
import { canonicalize } from '../../../src/operations/content-hash'
import {
	base64ToBytes,
	bytesToBase64,
	decodeBytesFromOpData,
} from '../../../src/operations/op-data-binary'
import { replayOperationsForRecord } from '../../../src/operations/replay-record'
import { defineSchema } from '../../../src/schema/define'
import { t } from '../../../src/schema/types'
import type {
	AtomicOp,
	CollectionDefinition,
	FieldDescriptor,
	HLCTimestamp,
	Operation,
	SchemaDefinition,
} from '../../../src/types'

// ---------------------------------------------------------------------------
// PRNG
// ---------------------------------------------------------------------------

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

const pick = <T>(rng: Rng, items: readonly T[]): T => {
	const item = items[Math.floor(rng() * items.length)]
	if (item === undefined) throw new Error('pick from empty list')
	return item
}
const chance = (rng: Rng, p: number): boolean => rng() < p
const int = (rng: Rng, lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1))

export function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
	const out = [...items]
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1))
		const a = out[i] as T
		out[i] = out[j] as T
		out[j] = a
	}
	return out
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Additive resolver (the documented inventory example). */
export const additiveResolver = (local: unknown, remote: unknown, base: unknown): unknown => {
	const l = typeof local === 'number' ? local : 0
	const r = typeof remote === 'number' ? remote : 0
	const b = typeof base === 'number' ? base : 0
	return l + (r - b)
}

/** Deliberately non-commutative resolver: the fold must still be deterministic. */
export const orderSensitiveResolver = (local: unknown, remote: unknown): unknown =>
	`${String(remote)}${String(local).slice(0, 2)}`

/** Resolver that throws on some inputs (the fold falls back to LWW there). */
export const throwingResolver = (local: unknown, remote: unknown): unknown => {
	if (remote === 'boom') throw new Error('resolver exploded')
	return `${String(local)}+${String(remote)}`.slice(-12)
}

const ALL_FIELDS = {
	title: () => t.string(),
	count: () => t.number(),
	done: () => t.boolean(),
	prio: () => t.enum(['low', 'mid', 'high']),
	due: () => t.timestamp().optional(),
	createdAt: () => t.timestamp().auto(),
	tags: () => t.array(t.string()),
	nums: () => t.array(t.number()),
	meta: () => t.object({ a: t.string(), b: t.number(), c: t.string() }).optional(),
	doc: () => t.json(),
	score: () => t.number().merge('counter'),
	hi: () => t.number().merge('max'),
	lo: () => t.number().merge('min'),
	log: () => t.array(t.string()).merge('append-only'),
	auth: () => t.string().merge('server-authoritative'),
	inv: () => t.number(),
	label: () => t.string(),
	risky: () => t.string(),
	body: () => t.richtext(),
	pin: () => t.secret(),
} as const

export type GateField = keyof typeof ALL_FIELDS
export const GATE_FIELDS = Object.keys(ALL_FIELDS) as GateField[]

const RESOLVERS: Partial<Record<GateField, (l: unknown, r: unknown, b: unknown) => unknown>> = {
	inv: additiveResolver,
	label: orderSensitiveResolver,
	risky: throwingResolver,
}

export function buildGateSchema(fields: readonly GateField[]): SchemaDefinition {
	const fieldBuilders: Record<string, ReturnType<(typeof ALL_FIELDS)[GateField]>> = {}
	const resolve: Record<string, (l: unknown, r: unknown, b: unknown) => unknown> = {}
	for (const f of fields) {
		fieldBuilders[f] = ALL_FIELDS[f]()
		const resolver = RESOLVERS[f]
		if (resolver) resolve[f] = resolver
	}
	return defineSchema({
		version: 1,
		collections: { items: { fields: fieldBuilders, resolve } },
	}) as unknown as SchemaDefinition
}

// ---------------------------------------------------------------------------
// Fake richtext: opaque updates; the "merge" is deterministic concatenation of
// the (already canonically ordered) updates. Real Yjs is exercised in
// packages/test (it is not a core dependency).
// ---------------------------------------------------------------------------

export const fakeRichtextMerger = (updates: Uint8Array[]): Uint8Array => {
	const total = updates.reduce((n, u) => n + u.length + 1, 0)
	const out = new Uint8Array(total)
	let i = 0
	for (const u of updates) {
		out.set(u, i)
		i += u.length
		out[i] = 255
		i += 1
	}
	return out
}

// ---------------------------------------------------------------------------
// Oracle: whole-log specification of the fold
// ---------------------------------------------------------------------------

type OracleKind = 'reg' | 'set' | 'set-ao' | 'map' | 'ctr' | 'max' | 'min' | 'res' | 'rt'

function oracleKind(
	desc: FieldDescriptor | undefined,
	collection: CollectionDefinition | undefined,
	field: string,
): OracleKind {
	if (collection?.resolvers[field]) return 'res'
	if (!desc) return 'reg'
	switch (desc.mergeStrategy) {
		case 'counter':
			return 'ctr'
		case 'max':
			return 'max'
		case 'min':
			return 'min'
		case 'append-only':
			return desc.kind === 'array' ? 'set-ao' : 'reg'
		case 'lww':
		case 'server-authoritative':
			return 'reg'
		default:
			break
	}
	if (desc.kind === 'array') return 'set'
	if (desc.kind === 'object' || desc.kind === 'json') return 'map'
	if (desc.kind === 'richtext') return 'rt'
	return 'reg'
}

interface OStamp {
	t: string
	o: string
}
const ocmp = (a: OStamp, b: OStamp): number =>
	a.t < b.t ? -1 : a.t > b.t ? 1 : a.o < b.o ? -1 : a.o > b.o ? 1 : 0
const ostamp = (op: Operation): OStamp => ({
	t: HybridLogicalClock.serialize(op.timestamp),
	o: op.id,
})

/**
 * The node whose writes are authoritative for `merge('server-authoritative')`
 * fields in every gate scenario (it plays the server).
 */
export const GATE_AUTHORITATIVE_NODES: ReadonlySet<string> = new Set(['node-1'])

/**
 * How a gate run names its simulated nodes and which are authoritative by list
 * (nodes named `kora:server:<id>` are authoritative by prefix, listed or not).
 */
export interface GateAuthority {
	nodeName?: (index: number) => string
	authoritative?: ReadonlySet<string>
}

interface OWrite {
	node: string
	s: OStamp
	insert: boolean
	v: unknown
	prev: unknown
	hasPrev: boolean
	a?: AtomicOp
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
	const proto = Object.getPrototypeOf(v)
	return proto === null || proto === Object.prototype
}

function normalize(v: unknown): unknown {
	if (v instanceof Uint8Array) return { $koraBytes: bytesToBase64(v) }
	if (Array.isArray(v)) return v.map(normalize)
	if (isPlainObject(v)) {
		const out: Record<string, unknown> = {}
		for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = normalize(x)
		return out
	}
	return v
}

function fieldWrites(sorted: Operation[], field: string): OWrite[] {
	const out: OWrite[] = []
	for (const op of sorted) {
		if (op.type === 'delete' || !op.data) continue
		if (!(field in op.data) || op.data[field] === undefined) continue
		const v = normalize(op.data[field])
		const a = op.atomicOps?.[field]
		if (op.type === 'insert') {
			out.push({
				node: op.nodeId,
				s: ostamp(op),
				insert: true,
				v,
				prev: undefined,
				hasPrev: false,
				a,
			})
			continue
		}
		const hasPrev =
			op.previousData !== null && field in op.previousData && op.previousData[field] !== undefined
		const prev = hasPrev ? normalize(op.previousData?.[field]) : undefined
		if (!a && hasPrev && canonicalize(prev) === canonicalize(v)) continue
		out.push({ node: op.nodeId, s: ostamp(op), insert: false, v, prev, hasPrev, a })
	}
	return out
}

function oracleField(
	kind: OracleKind,
	writes: OWrite[],
	resolver: ((l: unknown, r: unknown, b: unknown) => unknown) | undefined,
	merger: (u: Uint8Array[]) => Uint8Array,
): unknown {
	if (writes.length === 0) return undefined
	switch (kind) {
		case 'reg': {
			let value: unknown
			let last: string | null = null
			for (const w of writes) {
				if (w.a && last === w.a.type) value = applyAtomicOp(value, w.a)
				else value = w.v
				last = w.a ? w.a.type : 'set'
			}
			return value
		}
		case 'res': {
			let value: unknown = undefined
			let first = true
			for (const w of writes) {
				if (first) {
					value = w.v
					first = false
					continue
				}
				try {
					value = normalize(resolver?.(value, w.v, w.insert ? null : w.prev))
				} catch {
					value = w.v
				}
			}
			return value
		}
		case 'ctr': {
			let base: unknown = undefined
			let deltas: number[] = []
			for (const w of writes) {
				if (w.a?.type === 'increment' && typeof w.a.value === 'number') deltas.push(w.a.value)
				else if (!w.insert && !w.a && typeof w.v === 'number' && typeof w.prev === 'number')
					deltas.push(w.v - w.prev)
				else {
					base = w.v
					deltas = []
				}
			}
			if (deltas.length === 0) return base
			let sum = typeof base === 'number' ? base : 0
			for (const d of deltas) sum += d
			return sum
		}
		case 'max':
		case 'min': {
			let best: number | undefined
			let reg: unknown = undefined
			for (const w of writes) {
				if (typeof w.v === 'number') {
					if (best === undefined || (kind === 'max' ? w.v > best : w.v < best)) best = w.v
				} else reg = w.v
			}
			return best !== undefined ? best : reg
		}
		case 'set':
		case 'set-ao': {
			// Occurrence-indexed multiset: the identity of an element is (value, k), the
			// k-th copy of the value. Writes are applied in stamp order, so the last
			// add/remove of an occurrence is its newest.
			const ao = kind === 'set-ao'
			const el = new Map<
				string,
				{ v: unknown; a: OStamp | null; f: { s: OStamp; i: number } | null; r: OStamp | null }
			>()
			const get = (x: unknown, k: number) => {
				const key = `${canonicalize(normalize(x))}#${k}`
				let e = el.get(key)
				if (!e) {
					e = { v: JSON.parse(canonicalize(normalize(x))), a: null, f: null, r: null }
					el.set(key, e)
				}
				return e
			}
			const occurrences = (items: unknown[]) => {
				const counts = new Map<string, number>()
				return items.map((x) => {
					const c = canonicalize(normalize(x))
					const k = counts.get(c) ?? 0
					counts.set(c, k + 1)
					return { x, c, k }
				})
			}
			const countOf = (items: unknown[], c: string) =>
				items.filter((x) => canonicalize(normalize(x)) === c).length
			let shape: { arr: boolean; v: unknown } | null = null
			let clr: OStamp | null = null
			for (const w of writes) {
				const prevArr = !w.insert && Array.isArray(w.prev) ? (w.prev as unknown[]) : null
				if (
					w.a &&
					(w.a.type === 'append' || w.a.type === 'remove') &&
					(prevArr === null || !Array.isArray(w.v))
				) {
					shape = { arr: true, v: undefined }
					const e = get(w.a.value, 0)
					if (w.a.type === 'append') {
						e.a = w.s
						if (!e.f) e.f = { s: w.s, i: 0 }
					} else if (!ao) e.r = w.s
					continue
				}
				if (!Array.isArray(w.v)) {
					shape = { arr: false, v: w.v }
					clr = w.s
					continue
				}
				shape = { arr: true, v: undefined }
				const next = w.v as unknown[]
				occurrences(next).forEach(({ x, c, k }, i) => {
					if (k < (prevArr ? countOf(prevArr, c) : 0)) return
					const e = get(x, k)
					e.a = w.s
					if (!e.f) e.f = { s: w.s, i }
				})
				if (prevArr && !ao) {
					for (const { x, c, k } of occurrences(prevArr)) {
						if (k >= countOf(next, c)) get(x, k).r = w.s
					}
				}
			}
			if (!shape) return undefined
			if (!shape.arr) return shape.v
			const present = [...el.entries()].filter(([, e]) => {
				if (!e.a || !e.f) return false
				if (ao) return true
				if (e.r && ocmp(e.a, e.r) <= 0) return false
				if (clr && ocmp(e.a, clr) <= 0) return false
				return true
			})
			present.sort(([ka, a], [kb, b]) => {
				const fa = a.f as { s: OStamp; i: number }
				const fb = b.f as { s: OStamp; i: number }
				return ocmp(fa.s, fb.s) || fa.i - fb.i || (ka < kb ? -1 : ka > kb ? 1 : 0)
			})
			return present.map(([, e]) => e.v)
		}
		case 'map': {
			let shape: { obj: boolean; v: unknown } | null = null
			let clr: OStamp | null = null
			const keys = new Map<string, { s: OStamp; del: boolean; v?: unknown }>()
			for (const w of writes) {
				if (!isPlainObject(w.v)) {
					shape = { obj: false, v: w.v }
					clr = w.s
					continue
				}
				shape = { obj: true, v: undefined }
				const prev = !w.insert && isPlainObject(w.prev) ? w.prev : null
				for (const [k, x] of Object.entries(w.v)) {
					if (prev && k in prev && canonicalize(prev[k]) === canonicalize(x)) continue
					keys.set(k, { s: w.s, del: false, v: x })
				}
				if (prev)
					for (const k of Object.keys(prev)) if (!(k in w.v)) keys.set(k, { s: w.s, del: true })
			}
			if (!shape) return undefined
			if (!shape.obj) return shape.v
			const out: Record<string, unknown> = {}
			for (const k of [...keys.keys()].sort()) {
				const st = keys.get(k)
				if (!st || st.del) continue
				if (clr && ocmp(st.s, clr) <= 0) continue
				out[k] = st.v
			}
			return out
		}
		case 'rt': {
			let reset: { s: OStamp; v: unknown } | null = null
			const updates = new Map<string, OStamp>()
			for (const w of writes) {
				const decoded = w.v === null ? null : decodeBytesFromOpData(w.v)
				if (decoded === null || typeof decoded === 'string') {
					reset = { s: w.s, v: decoded }
					continue
				}
				updates.set(bytesToBase64(decoded), w.s)
			}
			const live = [...updates.entries()]
				.filter(([, s]) => !reset || ocmp(s, reset.s) > 0)
				.map(([k]) => k)
				.sort()
			if (live.length === 0) return reset ? reset.v : undefined
			const bytes = live.map((k) => base64ToBytes(k))
			const merged = bytes.length === 1 ? (bytes[0] as Uint8Array) : merger(bytes)
			return { $koraBytes: bytesToBase64(merged) }
		}
	}
}

/** Whole-log specification of the materialized record. */
export function oracleMaterialize(
	ops: readonly Operation[],
	schema: SchemaDefinition,
	merger: (u: Uint8Array[]) => Uint8Array = fakeRichtextMerger,
	authoritative: ReadonlySet<string> = GATE_AUTHORITATIVE_NODES,
): Record<string, unknown> | null {
	const unique = new Map<string, Operation>()
	for (const op of ops) unique.set(op.id, op)
	const sorted = [...unique.values()].sort((a, b) => ocmp(ostamp(a), ostamp(b)))
	let inserted = false
	let w: OStamp | null = null
	let d: OStamp | null = null
	const fields = new Set<string>()
	for (const op of sorted) {
		if (op.type === 'delete') d = ostamp(op)
		else {
			if (op.type === 'insert') inserted = true
			w = ostamp(op)
			for (const k of Object.keys(op.data ?? {})) fields.add(k)
		}
	}
	if (!inserted || !w || (d && ocmp(w, d) <= 0)) return null
	const collection = schema.collections[sorted[0]?.collection ?? '']
	const out: Record<string, unknown> = {}
	for (const field of [...fields].sort()) {
		const kind = oracleKind(collection?.fields[field], collection, field)
		let writes = fieldWrites(sorted, field)
		if (
			!collection?.resolvers[field] &&
			collection?.fields[field]?.mergeStrategy === 'server-authoritative'
		) {
			// Authoritative writes order after every other write: (class, HLC, op id).
			// A node is authoritative by the reserved `kora:server:` prefix or by the list.
			const cls = (w: OWrite) =>
				authoritative.has(w.node) || /^kora:server:./.test(w.node) ? 1 : 0
			writes = [...writes].sort((a, b) => cls(a) - cls(b) || ocmp(a.s, b.s))
		}
		const value = oracleField(kind, writes, collection?.resolvers[field], merger)
		if (value !== undefined) out[field] = value
	}
	return out
}

// ---------------------------------------------------------------------------
// Scenario generator
// ---------------------------------------------------------------------------

interface SimNode {
	id: string
	wall: number
	logical: number
	seq: number
	lag: number
	known: Map<string, Operation>
	lastOp: string | null
}

export interface Scenario {
	seed: number
	schema: SchemaDefinition
	fields: GateField[]
	ops: Operation[]
}

const STRINGS = ['a', 'b', 'c', 'd']
const TAGS = ['t1', 't2', 't3', 't4', 't5']

function nextStamp(node: SimNode, physical: number): HLCTimestamp {
	const phys = physical - node.lag
	if (phys > node.wall) {
		node.wall = phys
		node.logical = 0
	} else {
		node.logical += 1
	}
	return { wallTime: node.wall, logical: node.logical, nodeId: node.id }
}

function receive(node: SimNode, remote: HLCTimestamp): void {
	if (remote.wallTime > node.wall) {
		node.wall = remote.wallTime
		node.logical = remote.logical + 1
	} else if (remote.wallTime === node.wall) {
		node.logical = Math.max(node.logical, remote.logical) + 1
	}
}

function randomValue(rng: Rng, field: GateField, current: unknown): { v: unknown; a?: AtomicOp } {
	switch (field) {
		case 'title':
		case 'auth':
		case 'pin':
			return { v: pick(rng, STRINGS) }
		case 'label':
			return { v: pick(rng, STRINGS) }
		case 'risky':
			return { v: chance(rng, 0.2) ? 'boom' : pick(rng, STRINGS) }
		case 'count': {
			if (chance(rng, 0.5)) {
				const a: AtomicOp = chance(rng, 0.6)
					? { type: 'increment', value: int(rng, -3, 5) }
					: { type: chance(rng, 0.5) ? 'max' : 'min', value: int(rng, -5, 5) }
				return { v: applyAtomicOp(current, a), a }
			}
			return { v: int(rng, -5, 5) }
		}
		case 'done':
			return { v: chance(rng, 0.5) }
		case 'prio':
			return { v: pick(rng, ['low', 'mid', 'high']) }
		case 'due':
		case 'createdAt':
			return { v: chance(rng, 0.1) ? null : int(rng, 1, 4) * 1000 }
		case 'tags':
		case 'log': {
			if (chance(rng, 0.08)) return { v: chance(rng, 0.5) ? null : [] }
			const base = Array.isArray(current) ? [...(current as unknown[])] : []
			if (chance(rng, 0.5) && base.length > 0) base.splice(int(rng, 0, base.length - 1), 1)
			if (chance(rng, 0.7)) {
				const tag = pick(rng, TAGS)
				// Duplicates are data: arrays are multisets.
				if (!base.includes(tag) || chance(rng, 0.3)) base.push(tag)
			}
			if (chance(rng, 0.15)) base.reverse()
			return { v: base }
		}
		case 'nums': {
			if (chance(rng, 0.5)) {
				const a: AtomicOp = { type: chance(rng, 0.6) ? 'append' : 'remove', value: int(rng, 1, 4) }
				return { v: applyAtomicOp(current, a), a }
			}
			const base = Array.isArray(current) ? [...(current as unknown[])] : []
			if (chance(rng, 0.5) && base.length > 0) base.splice(int(rng, 0, base.length - 1), 1)
			const n = int(rng, 1, 4)
			if (!base.includes(n) || chance(rng, 0.3)) base.push(n)
			return { v: base }
		}
		case 'meta': {
			if (chance(rng, 0.08)) return { v: null }
			const base: Record<string, unknown> =
				typeof current === 'object' && current !== null && !Array.isArray(current)
					? { ...(current as Record<string, unknown>) }
					: {}
			const key = pick(rng, ['a', 'b', 'c'])
			if (chance(rng, 0.25)) delete base[key]
			else base[key] = key === 'b' ? int(rng, 0, 3) : pick(rng, STRINGS)
			return { v: base }
		}
		case 'doc': {
			const r = rng()
			if (r < 0.08) return { v: null }
			if (r < 0.14) return { v: [int(rng, 0, 2)] }
			if (r < 0.18) return { v: pick(rng, STRINGS) }
			const base: Record<string, unknown> =
				typeof current === 'object' && current !== null && !Array.isArray(current)
					? { ...(current as Record<string, unknown>) }
					: {}
			const key = pick(rng, ['x', 'y', 'z'])
			if (chance(rng, 0.25)) delete base[key]
			else base[key] = chance(rng, 0.3) ? { deep: pick(rng, STRINGS) } : pick(rng, STRINGS)
			return { v: base }
		}
		case 'score': {
			if (chance(rng, 0.4)) {
				const a: AtomicOp = { type: 'increment', value: int(rng, -2, 4) }
				return { v: applyAtomicOp(current, a), a }
			}
			const cur = typeof current === 'number' ? current : 0
			return { v: cur + int(rng, -3, 3) }
		}
		case 'hi':
		case 'lo':
			return { v: chance(rng, 0.05) ? null : int(rng, -9, 9) }
		case 'inv': {
			const cur = typeof current === 'number' ? current : 0
			return { v: cur + int(rng, -3, 5) }
		}
		case 'body': {
			if (chance(rng, 0.25)) return { v: pick(rng, ['hello', 'world']) }
			const bytes = new Uint8Array([int(rng, 0, 9), int(rng, 0, 9), int(rng, 0, 9)])
			return { v: { $koraBytes: bytesToBase64(bytes) } }
		}
	}
}

/**
 * Generate one scenario. Deterministic in `seed`.
 *
 * @param seed - PRNG seed
 * @param onlyFields - restrict the schema to these fields (per-kind gates)
 */
export function generateScenario(
	seed: number,
	onlyFields?: readonly GateField[],
	nodeName: (index: number) => string = (index) => `node-${index}`,
): Scenario {
	const rng = mulberry32(seed)
	let fields: GateField[]
	if (onlyFields) fields = [...onlyFields]
	else {
		fields = GATE_FIELDS.filter((f) => f === 'title' || chance(rng, 0.6))
	}
	const schema = buildGateSchema(fields)
	const nodeCount = int(rng, 2, 4)
	const nodes: SimNode[] = Array.from({ length: nodeCount }, (_, i) => ({
		id: nodeName(i),
		wall: 0,
		logical: 0,
		seq: 0,
		// One node may run far behind: its writes are "very late offline ops".
		lag: i === nodeCount - 1 && chance(rng, 0.3) ? 50 : 0,
		known: new Map(),
		lastOp: null,
	}))
	const all: Operation[] = []
	let physical = 100
	const steps = int(rng, 6, 28)
	// Most records are created on one device and synced before anyone edits them;
	// the rest start with concurrent inserts of the same id (insert onto existing).
	const sharedInsert = chance(rng, 0.6)
	for (let step = 0; step < steps; step++) {
		physical += int(rng, 0, 2)
		const node = sharedInsert && step === 0 ? (nodes[0] as SimNode) : pick(rng, nodes)
		if (sharedInsert && step === 1) {
			const first = all[0] as Operation
			for (const other of nodes) {
				if (!other.known.has(first.id)) {
					other.known.set(first.id, first)
					receive(other, first.timestamp)
				}
			}
		}
		if (chance(rng, 0.25) && all.length > 0) {
			// Partial sync: learn every op some other node knows.
			const peer = pick(rng, nodes)
			for (const op of peer.known.values()) {
				if (!node.known.has(op.id)) {
					node.known.set(op.id, op)
					receive(node, op.timestamp)
				}
			}
			continue
		}
		const view = oracleMaterialize([...node.known.values()], schema)
		const knowsInsert = [...node.known.values()].some((o) => o.type === 'insert')
		let type: Operation['type']
		let data: Record<string, unknown> | null = null
		let previousData: Record<string, unknown> | null = null
		const atomicOps: Record<string, AtomicOp> = {}
		if (!knowsInsert || (view !== null && chance(rng, 0.06))) {
			type = 'insert'
			data = {}
			const chosen = knowsInsert ? fields.filter(() => chance(rng, 0.5)) : fields
			for (const f of chosen) data[f] = randomValue(rng, f, undefined).v
		} else if (chance(rng, 0.1)) {
			type = 'delete'
		} else {
			type = 'update'
			data = {}
			previousData = {}
			const count = int(rng, 1, Math.min(3, fields.length))
			const chosen = shuffle(rng, fields).slice(0, count)
			for (const f of chosen) {
				const current = view?.[f]
				const { v, a } = randomValue(rng, f, current)
				data[f] = v
				previousData[f] = current ?? null
				if (a) atomicOps[f] = a
			}
			// A form that re-sends an untouched field.
			if (chance(rng, 0.25)) {
				const f = pick(rng, fields)
				if (!(f in data) && view && f in view) {
					data[f] = view[f]
					previousData[f] = view[f]
				}
			}
		}
		node.seq += 1
		const timestamp = nextStamp(node, physical)
		const op: Operation = {
			id: `${node.id}:${node.seq}`,
			nodeId: node.id,
			type,
			collection: 'items',
			recordId: 'rec-1',
			data,
			previousData,
			timestamp,
			sequenceNumber: node.seq,
			causalDeps: node.lastOp ? [node.lastOp] : [],
			schemaVersion: 1,
			...(Object.keys(atomicOps).length > 0 ? { atomicOps } : {}),
		}
		node.lastOp = op.id
		node.known.set(op.id, op)
		all.push(op)
	}
	return { seed, schema, fields, ops: all }
}

/** A delivery order: a permutation of `ops` with random duplicates spliced in. */
export function deliveryOrder(rng: Rng, ops: readonly Operation[]): Operation[] {
	const order = shuffle(rng, ops)
	const dupes = Math.floor(ops.length * 0.2)
	for (let i = 0; i < dupes; i++) {
		const op = pick(rng, ops)
		order.splice(int(rng, 0, order.length), 0, op)
	}
	return order
}

// ---------------------------------------------------------------------------
// Fold implementations under test
// ---------------------------------------------------------------------------

export interface GateReplica {
	apply(op: Operation): void
	/** Simulate persisting and reloading the replica's state (serialization round-trip). */
	reload(): void
	materialize(): Record<string, unknown> | null
	/** Canonical identity of the replica's internal state, or null if not comparable. */
	stateKey(): string | null
}

export interface FoldUnderTest {
	name: string
	replica(schema: SchemaDefinition): GateReplica
	/** Fold a set of ops from scratch, optionally excluding some ids. */
	fold(
		ops: readonly Operation[],
		schema: SchemaDefinition,
		exclude?: ReadonlySet<string>,
	): Record<string, unknown> | null
	/** Fold partitions separately and join them; null if the implementation has no join. */
	joinFold?(
		parts: readonly (readonly Operation[])[],
		schema: SchemaDefinition,
		grouping: 'left' | 'right',
	): Record<string, unknown> | null
}

/**
 * The pre-W7 shape: replay every op in the order it arrived (no HLC sort), with
 * the interim set rule. This is what "apply as it arrives" amounts to; the gate
 * must reject it.
 */
export const naiveArrivalOrderFold: FoldUnderTest = {
	name: 'naive arrival-order replay',
	replica() {
		const seen = new Map<string, Operation>()
		return {
			apply(op) {
				if (!seen.has(op.id)) seen.set(op.id, op)
			},
			reload() {},
			materialize() {
				const ops = [...seen.values()]
				if (!ops.some((o) => o.type === 'insert')) return null
				return replayOperationsForRecord(ops)
			},
			stateKey: () => null,
		}
	},
	fold(ops, _schema, exclude) {
		const kept = ops.filter((o) => !exclude?.has(o.id))
		if (!kept.some((o) => o.type === 'insert')) return null
		return replayOperationsForRecord(kept)
	},
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/** Canonical form for comparing materialized records. */
export const canon = (v: unknown): string => canonicalize(normalize(v))

export interface GateFailure {
	seed: number
	check: string
	detail: string
}

/**
 * Run every gate check for one seed. Returns null on success, or the first
 * failure (with enough detail to reproduce it from the seed).
 */
export function runGateSeed(
	impl: FoldUnderTest,
	seed: number,
	onlyFields?: readonly GateField[],
	authority: GateAuthority = {},
): GateFailure | null {
	const scenario = generateScenario(seed, onlyFields, authority.nodeName)
	const { schema, ops } = scenario
	const rng = mulberry32(seed ^ 0x9e3779b9)
	const authoritative = authority.authoritative ?? GATE_AUTHORITATIVE_NODES
	const expected = canon(oracleMaterialize(ops, schema, fakeRichtextMerger, authoritative))
	const fail = (check: string, detail: string): GateFailure => ({ seed, check, detail })

	// 1. Commutativity + idempotency: replicas receiving the ops in different
	//    orders, with duplicates and reloads, all reach the oracle's state.
	const keys: (string | null)[] = []
	for (let r = 0; r < 3; r++) {
		const replica = impl.replica(schema)
		for (const op of deliveryOrder(rng, ops)) {
			replica.apply(op)
			if (chance(rng, 0.1)) replica.reload()
		}
		const got = canon(replica.materialize())
		if (got !== expected)
			return fail('commutativity/idempotency', `replica ${r}: ${got} !== oracle ${expected}`)
		keys.push(replica.stateKey())
	}
	if (keys[0] !== null && keys.some((k) => k !== keys[0]))
		return fail('state identity', 'replica states differ although they hold the same ops')

	// 2. Incremental == from scratch.
	const scratch = canon(impl.fold(shuffle(rng, ops), schema))
	if (scratch !== expected) return fail('incremental == scratch', `${scratch} !== ${expected}`)

	// 3. Associativity: fold partitions and join them in both groupings.
	if (impl.joinFold) {
		const parts: Operation[][] = [[], [], []]
		for (const op of ops) parts[int(rng, 0, 2)]?.push(op)
		for (const grouping of ['left', 'right'] as const) {
			const joined = canon(impl.joinFold(parts, schema, grouping))
			if (joined !== expected)
				return fail(`associativity (${grouping})`, `${joined} !== ${expected}`)
		}
	}

	// 4. Exclusion: folding with an excluded set equals folding without those ops.
	const excluded = new Set(ops.filter(() => chance(rng, 0.15)).map((o) => o.id))
	if (excluded.size > 0) {
		const withExclusion = canon(impl.fold(ops, schema, excluded))
		const withoutOps = canon(
			oracleMaterialize(
				ops.filter((o) => !excluded.has(o.id)),
				schema,
				fakeRichtextMerger,
				authoritative,
			),
		)
		if (withExclusion !== withoutOps) return fail('exclusion', `${withExclusion} !== ${withoutOps}`)
	}
	return null
}
