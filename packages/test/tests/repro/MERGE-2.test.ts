import { defineSchema, t } from '@korajs/core'
import { afterEach, describe, expect, test } from 'vitest'
import type { TestDevice, TestNetwork } from '../../src/index'
import { createTestNetwork } from '../../src/index'

/**
 * MERGE-2: strong eventual consistency for non-scalar merge kinds through the
 * real apply pipeline. Three writers + a late joiner + the server, seeded
 * random edits, random sync (= delivery) order. Correct behavior: after
 * quiescence every replica (incl. server materialization and a fresh device
 * that replays the server log) holds byte-identical field values.
 *
 * Deterministic: mulberry32 PRNG with fixed seeds (fast-check is not
 * resolvable from packages/test; seeds play the same role).
 */
const schema = defineSchema({
	version: 1,
	collections: {
		items: {
			fields: {
				tags: t.array(t.string()),
				settings: t.object({ a: t.string(), b: t.string(), c: t.string() }),
				meta: t.json<Record<string, unknown>>(),
				quantity: t.number(),
			},
			resolve: {
				// Documented additive resolver (docs/guide/conflict-resolution.md).
				quantity: (local: number, remote: number, base: number) =>
					base + (local - base) + (remote - base),
			},
		},
	},
})

function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let x = a
		x = Math.imul(x ^ (x >>> 15), x | 1)
		x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
		return ((x ^ (x >>> 14)) >>> 0) / 4294967296
	}
}

const TAGS = ['t1', 't2', 't3', 't4']
const KEYS = ['a', 'b', 'c'] as const
const VALS = ['x', 'y', 'z']

type FieldKind = 'tags' | 'settings' | 'meta' | 'quantity'

let network: TestNetwork | null = null
afterEach(async () => {
	await network?.close()
	network = null
})

async function snapshot(d: TestDevice, id: string): Promise<Record<string, unknown>> {
	const r = await d.collection('items').findById(id)
	return { tags: r?.tags, settings: r?.settings, meta: r?.meta, quantity: r?.quantity }
}

async function runScenario(
	seed: number,
	fields: FieldKind[],
	rounds: number,
): Promise<{ states: Record<string, unknown>; log: string[] }> {
	const rnd = mulberry32(seed)
	const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T
	network = await createTestNetwork(schema, { devices: 4 })
	const writers = network.devices.slice(0, 3)
	const late = network.devices[3] as TestDevice
	const w0 = writers[0] as TestDevice
	const rec = await w0.collection('items').insert({
		tags: ['t1'],
		settings: { a: 'x', b: 'x', c: 'x' },
		meta: { a: 'x', b: 'x', c: 'x' },
		quantity: 100,
	})
	for (const d of writers) await d.sync()
	for (const d of writers) await d.disconnect()
	const log: string[] = []

	for (let r = 0; r < rounds; r++) {
		for (const [i, d] of writers.entries()) {
			const nEdits = 1
			for (let e = 0; e < nEdits; e++) {
				const cur = await d.collection('items').findById(rec.id)
				if (!cur) throw new Error('missing record')
				const f = pick(fields)
				let patch: Record<string, unknown>
				if (f === 'tags') {
					const tags = [...(cur.tags as string[])]
					const tag = pick(TAGS)
					patch = { tags: tags.includes(tag) ? tags.filter((x) => x !== tag) : [...tags, tag] }
				} else if (f === 'settings' || f === 'meta') {
					patch = { [f]: { ...(cur[f] as Record<string, string>), [pick(KEYS)]: pick(VALS) } }
				} else {
					patch = { quantity: (cur.quantity as number) - (1 + Math.floor(rnd() * 5)) }
				}
				log.push(`r${r} w${i} ${JSON.stringify(patch)}`)
				await d.collection('items').update(rec.id, patch)
			}
		}
		// Random reconnect order => random delivery order at each replica.
		const order = [...writers].sort(() => rnd() - 0.5)
		log.push(`r${r} order ${order.map((d) => d.name).join(',')}`)
		for (let pass = 0; pass < 2; pass++) {
			for (const d of order) await d.sync()
		}
		for (const d of writers) await d.disconnect()
	}
	for (let pass = 0; pass < 3; pass++) for (const d of writers) await d.sync()
	await late.sync()

	const states: Record<string, unknown> = {}
	for (const d of [...writers, late]) states[d.name] = await snapshot(d, rec.id)
	const srv = await network.server.store.findRecord('items', rec.id)
	states.server = { tags: srv?.tags, settings: srv?.settings, meta: srv?.meta, quantity: srv?.quantity }
	return { states, log }
}

function distinct(states: Record<string, unknown>): number {
	return new Set(Object.values(states).map((s) => JSON.stringify(s))).size
}

// Seeds chosen from a 12-seed sweep: these reproduce divergence today. Every
// replica held all 7 ops for the record (op logs complete), so the divergence
// is permanent, not a delivery lag.
const CASES: Array<{ fields: FieldKind[]; seeds: number[] }> = [
	{ fields: ['tags'], seeds: [1, 7, 8] },
	{ fields: ['settings', 'meta'], seeds: [3] },
	{ fields: ['quantity'], seeds: [1, 2] },
]

function fmt(states: Record<string, unknown>, log: string[]): string {
	const lines = Object.entries(states).map(([k, v]) => `${k}=${JSON.stringify(v)}`)
	return `\n${lines.join('\n')}\n${log.join('\n')}`
}

describe('MERGE-2 3-replica randomized convergence through the real apply pipeline', () => {
	for (const { fields, seeds } of CASES) {
		for (const seed of seeds) {
			test(`fields=${fields.join('+')} seed=${seed}: clients converge, and agree with server`, async () => {
				const { states, log } = await runScenario(seed, fields, 2)
				const clientStates = Object.fromEntries(
					Object.entries(states).filter(([k]) => k !== 'server'),
				)
				// Client-side pairwise merge (MERGE-2 proper).
				expect(distinct(clientStates), `clients diverge${fmt(states, log)}`).toBe(1)
				// Client vs server materialization (overlaps SRV-1).
				expect(distinct(states), `server diverges from clients${fmt(states, log)}`).toBe(1)
			}, 90000)
		}
	}
})
